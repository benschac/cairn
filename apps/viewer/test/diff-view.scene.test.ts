import { UiStruct } from "@effect/ui";
import { Sha } from "@cairn/contract";
import { Locator } from "@effect/ui/testing";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Predicate, Option, Result, String, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { DiffStyle, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import rangePatch from "./fixtures/range.patch?raw";
import {
  both,
  byRole,
  containing,
  data,
  drawnDiff,
  inside,
  loaded,
  pushedUrl,
  styled,
  viewerScene,
} from "./fixtures.ts";

const sha = (character: string) => Sha.make(String.repeat(40)(character));

/** A task with one commit whose parent the trace does not hold, so its whole diff has a route. */
const base = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) => Array.isReadonlyArrayNonEmpty(t.commits)),
);
const task = Struct.evolve(base, {
  commits: () => [
    Struct.evolve(Option.getOrThrow(Array.head(base.commits)), {
      files: () => ["src/a.ts", "src/view/b.ts"],
      parents: () => [sha("0")],
      sha: () => sha("a"),
    }),
  ],
});
const trace = Struct.evolve(demoTrace, {
  tasks: (tasks) => Array.map(tasks, (t) => (t.id === task.id ? task : t)),
});
const model = UiStruct.evolve(loaded, { trace: () => TraceData.Success({ data: trace }) });
const wholePath = `/api/diffs/${sha("0")}/${sha("a")}`;

const after = (...messages: ReadonlyArray<Message>) =>
  Array.reduce(messages, model, (current, message) => appUpdate(current, message).model);

const withPatch = after(
  Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }),
  Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
);

const list = data("patch-path");
const styleOption = (name: string) => byRole("button", { name });
const treeFile = (path: string) => data("tree-file", path);

it.effect(
  "a loaded patch is an element with the diff mount, in the unified style, and nothing inside it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(withPatch);
      s.expectMount(RenderDiff({ session: Option.none(), text: rangePatch }))
        .expect(list)
        .toHaveAttribute("data-patch-path", wholePath)
        .expect(list)
        .toHaveAttribute("data-diff-style", "unified")
        .expect(list)
        .toHaveText("")
        .expect(both(list, styled("overflow-y", "auto")))
        .toExist()
        .pipe(drawnDiff);
    }),
);

/** The elements an Effect UI view gave this key. */
const keyedBy = (key: string): Locator.Locator => ({
  all: (root) =>
    Array.filter(
      Locator.elements(root),
      (node) => Predicate.hasProperty(node, "elementKey") && node.elementKey === key,
    ),
  description: `key ${key}`,
});

it.effect("the list is keyed by the patch's route path, so another patch is a new list", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(withPatch);
    s.expect(both(list, keyedBy(wholePath)))
      .toExist()
      .pipe(drawnDiff);
  }),
);

it.effect("a patch that has not loaded is a note with the same path attribute, and no mount", () =>
  Effect.gen(function* () {
    const opened = after(Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }));
    const s = yield* viewerScene(opened);
    s.expect(list)
      .toHaveAttribute("data-patch-path", wholePath)
      .expect(list)
      .toHaveText(containing("Loading"))
      .expect(list)
      .toHaveAttribute("data-diff-style", false);
  }),
);

it.effect(
  "the toggle flips the style, the pressed button and the attribute the mount watches",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(withPatch);
      s.pipe(drawnDiff)
        .expect(styleOption("Unified"))
        .toHaveAttribute("aria-pressed", "true")
        .expect(styleOption("Split"))
        .toHaveAttribute("aria-pressed", "false")
        .click(styleOption("Split"))
        .expect(list)
        .toHaveAttribute("data-diff-style", "split")
        .expect(styleOption("Split"))
        .toHaveAttribute("aria-pressed", "true")
        .expect(styleOption("Unified"))
        .toHaveAttribute("aria-pressed", "false")
        .click(styleOption("Unified"))
        .expect(list)
        .toHaveAttribute("data-diff-style", "unified")
        .expect(styleOption("Unified"))
        .toHaveAttribute("aria-pressed", "true");
    }),
);

it.effect("the toggle is in the top bar, whether or not the patch has loaded", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() })),
    );
    s.expect(inside(data("code-bar"), data("diff-style-toggle")))
      .toExist()
      .click(styleOption("Split"))
      .expect(styleOption("Split"))
      .toHaveAttribute("aria-pressed", "true");
  }),
);

it.effect("a tree file click sets data-file on the list, which the mount scrolls to", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(withPatch);
    s.pipe(drawnDiff)
      .expect(list)
      .toHaveAttribute("data-file", false)
      .click(treeFile("src/view/b.ts"))
      .pipe(pushedUrl)
      .expect(list)
      .toHaveAttribute("data-file", "src/view/b.ts")
      .expect(list)
      .toHaveAttribute("data-patch-path", wholePath)
      .click(treeFile("src/a.ts"))
      .pipe(pushedUrl)
      .expect(list)
      .toHaveAttribute("data-file", "src/a.ts");
  }),
);

it.effect("the diff pane does not scroll and the list fills it", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(withPatch);
    s.pipe(drawnDiff)
      .expect(both(data("code-pane", "diff"), styled("display", "flex")))
      .toExist()
      .expect(both(data("code-pane", "diff"), styled("overflow-y", "auto")))
      .toBeAbsent()
      .expect(both(list, styled("flex", "1")))
      .toExist();
  }),
);

it.prop(
  "ClickedDiffStyle sets the style whichever it was, and changes nothing else",
  [DiffStyle, DiffStyle],
  ([from, to]) => {
    const start = UiStruct.evolve(withPatch, { diffStyle: () => from });
    const next = appUpdate(start, Message.ClickedDiffStyle({ style: to })).model;
    assert(next).toEqual(UiStruct.evolve(start, { diffStyle: () => to }));
  },
);
