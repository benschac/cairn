import { Array, Console, Effect, FileSystem, Path, Runtime, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import type { SectionPrefix } from "@cairn/contract";
import { assignItemIds, assignSectionIds, numberStatements } from "@cairn/core";

import { MainCheckout } from "../main-checkout.ts";
import { CAIRN_DIRECTORY, loadPrd, loadSpec } from "../workspace.ts";

/**
 * `cairn ids --check` found headings or statements without an ID or items asking for one. `added` lists the IDs
 * `cairn ids` would assign; `unplaced` names the items that ask for one and have no heading with an
 * ID above them to take it from.
 */
export class MissingSectionIds extends Schema.TaggedError<
  MissingSectionIds,
  { readonly brand: unique symbol }
>()("MissingSectionIds", {
  added: Schema.Array(Schema.String),
  unplaced: Schema.Array(Schema.String),
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${Array.length(this.added) + Array.length(this.unplaced)} headings, items or statements lack an ID; run cairn ids`;
  }
}

const documents = [
  { name: "prd.md", prefix: "prd", load: loadPrd },
  { name: "spec.md", prefix: "spec", load: loadSpec },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly prefix: SectionPrefix;
  readonly load: typeof loadPrd;
}>;

/**
 * Assigns the missing section IDs in `.cairn/prd.md` (prefix `prd`) and `.cairn/spec.md` (prefix
 * `spec`), then fills each list item's empty `{#}` and gives each done-when statement without an ID one. A file is written only when IDs were added, and
 * each added ID is printed. With `check` nothing is written and the effect fails with
 * `MissingSectionIds` when any heading or statement lacks an ID or any item asks for one.
 */
export const ids = Effect.fn("ids")(function* (options: { readonly check: boolean }) {
  const results = yield* Effect.forEach(documents, ({ load, name, prefix }) =>
    load.pipe(
      Effect.map((markdown) => {
        const headings = assignSectionIds(markdown, prefix);
        const items = assignItemIds(headings.markdown);
        const statements = numberStatements(items.markdown);
        return {
          added: Array.flatten([headings.added, items.added, statements.added]),
          markdown: statements.markdown,
          name,
          unplaced: Array.map(
            items.unplaced,
            (line) => `the item at ${name}:${line}: no heading with an ID is above it`,
          ),
        };
      }),
    ),
  );
  const added = Array.flatMap(results, (result) => result.added);
  const unplaced = Array.flatMap(results, (result) => result.unplaced);
  yield* Effect.forEach(unplaced, (place) => Console.log(`Cannot fill ${place}`), {
    discard: true,
  });
  if (options.check) {
    yield* Effect.forEach(added, (id) => Console.log(`Missing ${id}`), { discard: true });
    yield* Effect.filterOrFail(
      Effect.succeed({ added, unplaced }),
      ({ added: missing, unplaced: stuck }) =>
        Array.isReadonlyArrayEmpty(missing) && Array.isReadonlyArrayEmpty(stuck),
      (missing) => new MissingSectionIds(missing),
    );
  } else {
    yield* write(results);
  }
});

const write = Effect.fn("ids.write")(function* (
  results: ReadonlyArray<{
    readonly added: ReadonlyArray<string>;
    readonly markdown: string;
    readonly name: string;
    readonly unplaced: ReadonlyArray<string>;
  }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  yield* Effect.forEach(
    Array.filter(results, (result) => Array.isReadonlyArrayNonEmpty(result.added)),
    (result) =>
      fs
        .writeFileString(path.join(root, CAIRN_DIRECTORY, result.name), result.markdown)
        .pipe(
          Effect.andThen(
            Effect.forEach(result.added, (id) => Console.log(`Added ${id}`), { discard: true }),
          ),
        ),
    { discard: true },
  );
});

export const idsCommand = Command.make(
  "ids",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Write nothing and exit 1 when a heading or statement lacks an ID or an item asks for one",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ check }) =>
    ids({ check }).pipe(
      // The failure logs its own message once; the runtime does not print it again.
      Effect.tapErrorTag("MissingSectionIds", (error) => Effect.logError(error.message)),
    ),
).pipe(
  Command.withDescription(
    "Assign missing section IDs in prd.md and spec.md, fill empty {#} and number statements",
  ),
);
