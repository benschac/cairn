import { Sha } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, MutableRef, Option, Result, String, Struct } from "effect";
import type { Html } from "foldkit/html";
import { Mount, click, expect, given, role, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { DiffStyle, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { patchView } from "../src/view/diffView.ts";
import { view as appView } from "../src/view/view.ts";
import rangePatch from "./fixtures/range.patch?raw";
import { loaded } from "./fixtures.ts";

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
const model = modifyFields(loaded, { trace: () => TraceData.Success({ data: trace }) });
const wholePath = `/api/diffs/${sha("0")}/${sha("a")}`;

const app = { update: appUpdate, view: appView };

const after = (...messages: ReadonlyArray<Message>) =>
  Array.reduce(messages, model, (current, message) => appUpdate(current, message).model);

const withPatch = after(
  Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }),
  Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
);

const list = selector("[data-patch-path]");
const styleOption = (name: string) => role("button", { name });
const treeFile = (path: string) => selector(`[data-tree-file="${path}"]`);

/** The diff mount of a loaded patch answers once it has drawn the patch. */
const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

it("a loaded patch is an element with the diff mount, in the unified style, and nothing inside it", () => {
  scene(
    app,
    given(withPatch),
    Mount.expectExact(RenderDiff({ text: rangePatch })),
    expect(list).toHaveAttr("data-patch-path", wholePath),
    expect(list).toHaveAttr("data-diff-style", "unified"),
    expect(list).toBeEmpty(),
    expect(list).toHaveStyle("overflow-y", "auto"),
    drawn,
  );
});

it("the list is keyed by the patch's route path, so another patch is a new list", () => {
  const built = MutableRef.make<Html>(null);
  scene(
    {
      update: (current: null, _message: Message) => ({ model: current }),
      view: (_current: null, h) => {
        const body = patchView(withPatch.patches, wholePath, "unified", Option.none(), h);
        MutableRef.set(built, body);
        return { body, title: "diff" };
      },
    },
    given(null),
    drawn,
  );
  assert(Option.map(Option.fromNullOr(MutableRef.get(built)), ({ key }) => key)).toEqual(
    Option.some(wholePath),
  );
});

it("a patch that has not loaded is a note with the same path attribute, and no mount", () => {
  const opened = after(Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }));
  scene(
    app,
    given(opened),
    expect(list).toHaveAttr("data-patch-path", wholePath),
    expect(list).toContainText("Loading"),
    expect(list).not.toHaveAttr("data-diff-style"),
    Mount.expectNone(),
  );
});

it("the toggle flips the style, the pressed button and the attribute the mount watches", () => {
  scene(
    app,
    given(withPatch),
    drawn,
    expect(styleOption("Unified")).toHaveAttr("aria-pressed", "true"),
    expect(styleOption("Split")).toHaveAttr("aria-pressed", "false"),
    click(styleOption("Split")),
    expect(list).toHaveAttr("data-diff-style", "split"),
    expect(styleOption("Split")).toHaveAttr("aria-pressed", "true"),
    expect(styleOption("Unified")).toHaveAttr("aria-pressed", "false"),
    click(styleOption("Unified")),
    expect(list).toHaveAttr("data-diff-style", "unified"),
    expect(styleOption("Unified")).toHaveAttr("aria-pressed", "true"),
  );
});

it("the toggle is in the top bar, whether or not the patch has loaded", () => {
  scene(
    app,
    given(after(Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }))),
    expect(selector("[data-code-bar] [data-diff-style-toggle]")).toExist(),
    click(styleOption("Split")),
    expect(styleOption("Split")).toHaveAttr("aria-pressed", "true"),
  );
});

it("a tree file click sets data-file on the list, which the mount scrolls to", () => {
  scene(
    app,
    given(withPatch),
    drawn,
    expect(list).not.toHaveAttr("data-file"),
    click(treeFile("src/view/b.ts")),
    expect(list).toHaveAttr("data-file", "src/view/b.ts"),
    expect(list).toHaveAttr("data-patch-path", wholePath),
    click(treeFile("src/a.ts")),
    expect(list).toHaveAttr("data-file", "src/a.ts"),
  );
});

it("the diff pane does not scroll and the list fills it", () => {
  scene(
    app,
    given(withPatch),
    drawn,
    expect(selector('[data-code-pane="diff"]')).toHaveStyle("display", "flex"),
    expect(selector('[data-code-pane="diff"]')).not.toHaveStyle("overflow-y", "auto"),
    expect(list).toHaveStyle("flex", "1"),
  );
});

it.prop(
  "ClickedDiffStyle sets the style whichever it was, and changes nothing else",
  [DiffStyle, DiffStyle],
  ([from, to]) => {
    const start = modifyFields(withPatch, { diffStyle: () => from });
    const next = appUpdate(start, Message.ClickedDiffStyle({ style: to })).model;
    assert(next).toEqual(modifyFields(start, { diffStyle: () => to }));
  },
);
