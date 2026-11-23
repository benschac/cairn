import { expect, it } from "@effect/vitest";
import { Array, Option, Result, String } from "effect";

import { diffOptionsOf, itemIdOf, itemsOf, parsePatch } from "../src/diff.ts";
import { DiffStyle } from "../src/model.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import rangePatch from "./fixtures/range.patch?raw";

const parsed = (text: string) => Result.getOrThrow(parsePatch(text));

// The fixtures are this repository's own output: `git show --patch 5289657` and
// `git diff --patch 24774c3~1 24774c3`.

it("git show output parses into the commit message and one entry per file", () => {
  const patch = parsed(commitPatch);
  expect(Array.map(patch.files, (file) => file.name)).toEqual([
    "packages/contract/src/events.ts",
    "packages/contract/src/index.ts",
    "packages/contract/test/events.test.ts",
  ]);
  expect(Array.map(patch.files, (file) => file.type)).toEqual(["new", "change", "new"]);
  expect(
    Option.exists(patch.maybeMessage, (message) =>
      String.includes("Add the event schema with an actor")(message),
    ),
  ).toBe(true);
  expect(Array.every(patch.files, (file) => Array.isReadonlyArrayNonEmpty(file.hunks))).toBe(true);
});

it("git diff output parses into its files and carries no message", () => {
  const patch = parsed(rangePatch);
  expect(Array.map(patch.files, (file) => file.name)).toEqual([
    ".cairn/manifest.json",
    ".cairn/spec.json",
  ]);
  expect(Option.isNone(patch.maybeMessage)).toBe(true);
});

it("text with no patch in it has no files, and is not a failure", () => {
  expect(parsed("")).toEqual({ files: [], maybeMessage: Option.none() });
  expect(Array.isReadonlyArrayEmpty(parsed("not a patch at all\n").files)).toBe(true);
});

it("input the library cannot read becomes a failure value, not a throw", () => {
  // A caller that was handed something other than text, such as a body that did not decode.
  expect(Result.isFailure(parsePatch(Reflect.get({}, "text")))).toBe(true);
});

it.prop(
  "diffOptionsOf names the Highlights backend, both themes and the given style",
  [DiffStyle],
  ([style]) => {
    const options = diffOptionsOf(style);
    expect(options.preferredHighlighter).toBe("highlights");
    expect(options.theme).toEqual({ dark: "pierre-dark", light: "pierre-light" });
    expect(options.themeType).toBe("system");
    expect(options.diffStyle).toBe(style);
    expect(options.lineDiffType).toBe("word-alt");
    expect(options.hunkSeparators).toBe("line-info");
    expect(options.stickyHeaders).toBe(true);
  },
);

it("a list holds one diff item per file, with the ID diff:<path> and a starting version", () => {
  const { files } = parsed(commitPatch);
  const items = itemsOf(files);
  expect(Array.map(items, (item) => item.id)).toEqual(
    Array.map(files, (file) => `diff:${file.name}`),
  );
  expect(Array.every(items, (item) => item.type === "diff" && item.version === 0)).toBe(true);
  expect(itemIdOf("src/a.ts")).toBe("diff:src/a.ts");
});
