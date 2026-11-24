import { Array, Console, Effect, Option, Runtime, Schema } from "effect";
import { Command } from "effect/cli";

import { lint } from "@cairn/core";
import type { Finding } from "@cairn/core";

import { CAIRN_DIRECTORY, loadConfig, loadManifest, loadPrd, loadSpec } from "../workspace.ts";

/** `cairn lint` found errors. Warnings alone do not fail it. */
export class LintErrors extends Schema.TaggedError<LintErrors, { readonly brand: unique symbol }>()(
  "LintErrors",
  { errors: Schema.Int },
) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `cairn lint found ${this.errors} ${this.errors === 1 ? "error" : "errors"}`;
  }
}

/** A finding as `cairn lint` prints it: `file:line rule message`, the file under `.cairn/`, and no `:line` when it has none. */
export const formatFinding = (finding: Finding): string =>
  `${CAIRN_DIRECTORY}/${finding.file}${Option.match(finding.line, {
    onNone: () => "",
    onSome: (line) => `:${line}`,
  })} ${finding.rule} ${finding.message}`;

/**
 * Lints the plan in `.cairn/` (see `spec.lint`) and prints each finding. There may be no
 * `manifest.json` yet, and a missing `config.json` is the defaults. Fails with `LintErrors` when
 * any finding is an error; otherwise returns the findings, warnings included.
 */
export const lintPlan = Effect.fn("lintPlan")(function* () {
  const prd = yield* loadPrd;
  const spec = yield* loadSpec;
  const manifest = yield* loadManifest.pipe(
    Effect.asSome,
    Effect.catchTag("MissingFile", () => Effect.succeedNone),
  );
  const config = yield* loadConfig;
  const findings = lint(prd, spec, manifest, config);
  yield* Effect.forEach(findings, (finding) => Console.log(formatFinding(finding)), {
    discard: true,
  });
  const errors = Array.filter(findings, (finding) => finding.severity === "error");
  if (Array.isReadonlyArrayNonEmpty(errors)) {
    return yield* new LintErrors({ errors: Array.length(errors) });
  }
  return findings;
});

export const lintCommand = Command.make("lint", {}, () =>
  lintPlan().pipe(
    // The failure logs its own message once; the runtime does not print it again.
    Effect.tapErrorTag("LintErrors", (error) => Effect.logError(error.message)),
  ),
).pipe(Command.withDescription("Check the plan's section IDs, coverage, stacks and gates"));
