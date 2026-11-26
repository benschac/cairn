import { Manifest } from "@cairn/contract";
import { withStackDiagram } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Record, Schema } from "effect";

import { formatFinding, LintErrors, lintPlan } from "../src/commands/lint.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { MissingFile } from "../src/workspace.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const PRD =
  "# Product {#prd.product}\n\n## Store {#prd.store}\n\nDone when:\n\n- A stored note reads back. {#prd.store#v1}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n";

/** A one-task manifest for the plan above, with the task's files, gate, status and commits. */
const manifestOf = (task: {
  readonly commits: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly required: boolean;
  readonly status: "pending" | "landed";
}) =>
  encodeJson({
    baseBranch: "main",
    feature: "product",
    tasks: [
      {
        branch: "cairn-mvp/01-store",
        commits: task.commits,
        dependsOn: [],
        files: task.files,
        humanGate: { reasons: task.required ? ["path:*.sql"] : [], required: task.required },
        id: "t1",
        model: "sonnet",
        parent: null,
        prdSections: ["prd.store"],
        reasoning: "high",
        sessions: [],
        specSections: ["spec.store"],
        status: task.status,
        title: "Add the store",
        worktree: null,
      },
    ],
    version: 1,
  });

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

/** The spec with the stack diagram of `manifest` in it, so it does not drift. */
const drawn = (manifest: string) => withStackDiagram(SPEC, decodeManifest(manifest));

const PENDING = manifestOf({
  commits: [],
  files: ["src/store.ts"],
  required: false,
  status: "pending",
});

/** Runs `cairn lint` in a fresh main checkout whose `.cairn/` holds `files`. */
const lintIn = (files: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(Record.toEntries(files), ([name, content]) =>
        fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      return yield* lintPlan().pipe(Effect.provide(MainCheckout.fixed(root)));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("a plan with nothing wrong passes with no findings", () =>
  Effect.gen(function* () {
    const findings = yield* lintIn({
      "manifest.json": PENDING,
      "prd.md": PRD,
      "spec.md": drawn(PENDING),
    });
    expect(findings).toEqual([]);
  }),
);

it.effect("a plan with no manifest yet is linted for its sections alone", () =>
  Effect.gen(function* () {
    const findings = yield* lintIn({ "prd.md": PRD, "spec.md": SPEC });
    expect(findings).toEqual([]);
  }),
);

it.effect("an error fails with LintErrors, which counts the errors", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      lintIn({
        "prd.md": `${PRD}\n## Billing\n`,
        "spec.md": "# Spec\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n",
      }),
    );
    expect(Schema.is(LintErrors)(error)).toBe(true);
    expect(error.message).toBe("cairn lint found 2 errors");
  }),
);

it.effect("warnings alone do not fail it", () =>
  Effect.gen(function* () {
    const landed = manifestOf({
      commits: [],
      files: ["src/store.ts"],
      required: false,
      status: "landed",
    });
    const findings = yield* lintIn({
      "manifest.json": landed,
      "prd.md": PRD,
      "spec.md": drawn(landed),
    });
    expect(findings).toEqual([
      {
        file: "manifest.json",
        line: Option.none(),
        message: "t1 is landed but has no commits.",
        rule: "no-commits-landed",
        severity: "warning",
      },
    ]);
  }),
);

it.effect("reads the high-trust paths from config.json, and uses the defaults without one", () =>
  Effect.gen(function* () {
    const ungated = manifestOf({
      commits: [],
      files: ["db/schema.sql"],
      required: false,
      status: "pending",
    });
    const withDefaults = yield* lintIn({
      "manifest.json": ungated,
      "prd.md": PRD,
      "spec.md": drawn(ungated),
    });
    expect(withDefaults).toEqual([]);
    const error = yield* Effect.flip(
      lintIn({
        "config.json": encodeJson({ humanPaths: ["*.sql"] }),
        "manifest.json": ungated,
        "prd.md": PRD,
        "spec.md": drawn(ungated),
      }),
    );
    expect(Schema.is(LintErrors)(error)).toBe(true);
  }),
);

it.effect("a plan with no spec.md yet fails with MissingFile", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(lintIn({ "prd.md": PRD }));
    expect(Schema.is(MissingFile)(error)).toBe(true);
  }),
);

it("prints a finding as file:line rule message, under .cairn/, and leaves out a line it has none of", () => {
  expect(
    formatFinding({
      file: "prd.md",
      line: Option.some(5),
      message: 'The heading "Billing" has no ID. Run cairn ids to add one.',
      rule: "missing-id",
      severity: "error",
    }),
  ).toBe('.cairn/prd.md:5 missing-id The heading "Billing" has no ID. Run cairn ids to add one.');
  expect(
    formatFinding({
      file: "manifest.json",
      line: Option.none(),
      message: "t1 is landed but has no commits.",
      rule: "no-commits-landed",
      severity: "warning",
    }),
  ).toBe(".cairn/manifest.json no-commits-landed t1 is landed but has no commits.");
});
