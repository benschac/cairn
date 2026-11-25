import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { TestConsole } from "effect/testing";

import { assignSectionIds } from "@cairn/core";

import { ids, MissingSectionIds } from "../src/commands/ids.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { MissingFile } from "../src/workspace.ts";

const bare = "# Title\n\n## Goals\n\nText.\n\n## Goals\n";

/** A repository root with `.cairn/prd.md` and `.cairn/spec.md` holding the given text. */
const setup = (prd: string, spec: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    yield* fs.writeFileString(path.join(root, ".cairn", "prd.md"), prd);
    yield* fs.writeFileString(path.join(root, ".cairn", "spec.md"), spec);
    const read = (name: string) => fs.readFileString(path.join(root, ".cairn", name));
    const readBoth = Effect.all([read("prd.md"), read("spec.md")]);
    const run = (check: boolean) => ids({ check }).pipe(Effect.provide(MainCheckout.fixed(root)));
    return { fs, path, read, readBoth, root, run };
  });

const printed = TestConsole.logLines;

const fullySet = (markdown: string, prefix: "prd" | "spec") =>
  assignSectionIds(markdown, prefix).markdown;

it.effect("adds IDs to both files, rewrites them and prints each added ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(bare, "# Spec\n\n## Parsing\n");
      yield* run(false);
      const files = yield* readBoth;
      const lines = yield* printed;
      expect(files).toEqual([fullySet(bare, "prd"), fullySet("# Spec\n\n## Parsing\n", "spec")]);
      expect(lines).toEqual([
        "Added prd.title",
        "Added prd.goals",
        "Added prd.goals-2",
        "Added spec.spec",
        "Added spec.parsing",
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not rewrite a file that has every ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const done = fullySet(bare, "prd");
      const prd = done;
      const { fs, path, read, root, run } = yield* setup(prd, "# Spec\n\n## Parsing\n");
      // A read-only file makes any write fail, so a write of an unchanged file cannot go unnoticed.
      yield* fs.chmod(path.join(root, ".cairn", "prd.md"), 0o444);
      yield* run(false);
      const after = yield* read("prd.md");
      const lines = yield* printed;
      expect(after).toBe(prd);
      expect(lines).toEqual(["Added spec.spec", "Added spec.parsing"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("running twice changes nothing the second time", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(bare, bare);
      yield* run(false);
      const first = yield* readBoth;
      const firstLines = yield* printed;
      yield* run(false);
      const second = yield* readBoth;
      const secondLines = yield* printed;
      expect(second).toEqual(first);
      // The second run printed nothing more.
      expect(secondLines).toEqual(firstLines);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("--check writes nothing and fails when a heading lacks an ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(bare, fullySet(bare, "spec"));
      const error = yield* Effect.flip(run(true));
      const files = yield* readBoth;
      const lines = yield* printed;
      expect(Schema.is(MissingSectionIds)(error)).toBe(true);
      expect(files).toEqual([bare, fullySet(bare, "spec")]);
      expect(lines).toEqual(["Missing prd.title", "Missing prd.goals", "Missing prd.goals-2"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("--check passes and prints nothing when every heading has an ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { run } = yield* setup(fullySet(bare, "prd"), fullySet(bare, "spec"));
      yield* run(true);
      const lines = yield* printed;
      expect(lines).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const withItems =
  "# Title\n\n## CLI\n\n- `cairn lint` checks tasks. {#}\n- Plain item\n- Named {#prd.cli.named}\n";

it.effect("fills a list item's {#} after the headings and prints its ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(withItems, bare);
      yield* run(false);
      const [prd] = yield* readBoth;
      const lines = yield* printed;
      expect(prd).toBe(
        "# Title {#prd.title}\n\n## CLI {#prd.cli}\n\n- `cairn lint` checks tasks. {#prd.cli.cairn-lint}\n- Plain item\n- Named {#prd.cli.named}\n",
      );
      expect(lines).toContain("Added prd.cli.cairn-lint");
      expect(lines).not.toContain("Added prd.cli.plain-item");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("--check writes nothing and fails while an item still asks for an ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const identified = fullySet(withItems, "prd");
      const { readBoth, run } = yield* setup(identified, fullySet(bare, "spec"));
      const error = yield* Effect.flip(run(true));
      const files = yield* readBoth;
      const lines = yield* printed;
      expect(Schema.is(MissingSectionIds)(error)).toBe(true);
      expect(files).toEqual([identified, fullySet(bare, "spec")]);
      expect(lines).toEqual(["Missing prd.cli.cairn-lint"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const orphan = "- Before any heading {#}\n\n# Title {#prd.title}\n";

it.effect("an item with no heading above it is reported, left as written, and fails --check", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(orphan, fullySet(bare, "spec"));
      yield* run(false);
      const [prd] = yield* readBoth;
      const written = yield* printed;
      expect(prd).toBe(orphan);
      expect(written).toEqual([
        "Cannot fill the item at prd.md:1: no heading with an ID is above it",
      ]);
      const error = yield* Effect.flip(run(true));
      expect(Schema.is(MissingSectionIds)(error)).toBe(true);
      expect(error.message).toBe("1 headings or items lack an ID; run cairn ids");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a missing file fails with MissingFile", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, root, run } = yield* setup(bare, bare);
      yield* fs.remove(path.join(root, ".cairn", "spec.md"));
      const error = yield* Effect.flip(run(false));
      expect(Schema.is(MissingFile)(error)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Any document: ids makes --check pass, and a second run is a no-op.
it.effect.prop("after ids, --check passes and ids changes nothing", [Schema.String], ([text]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { readBoth, run } = yield* setup(text, text);
      yield* run(false);
      const first = yield* readBoth;
      yield* run(true);
      yield* run(false);
      const second = yield* readBoth;
      expect(second).toEqual(first);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
