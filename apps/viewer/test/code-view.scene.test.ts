import { Sha, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, String, Struct } from "effect";
import { all, click, expect, expectAll, given, role, scene, selector, within } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { view as appView } from "../src/view/view.ts";
import { canvasEnded, focusedDrawerHeading, loaded, mounted, taskButton } from "./fixtures.ts";

const sha = (character: string) => Sha.make(String.repeat(40)(character));

/** A task with two commits, the second without a session, and a task with none. */
const stackedBase = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) => Array.isReadonlyArrayNonEmpty(t.commits)),
);
const template = Option.getOrThrow(Array.head(stackedBase.commits));
const first = Struct.evolve(template, {
  files: () => ["src/a.ts", "src/view/b.ts"],
  parents: () => [sha("0")],
  sha: () => sha("a"),
  subject: () => "First",
});
const second = Struct.evolve(template, {
  files: () => ["src/view/b.ts", "docs/c.md"],
  parents: () => [sha("a")],
  session: () => null,
  sha: () => sha("b"),
  subject: () => "Second",
});
const stacked = Struct.evolve(stackedBase, { commits: () => [first, second] });
const bare = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) => Array.isReadonlyArrayEmpty(t.commits)),
);
const trace = Struct.evolve(demoTrace, {
  tasks: (tasks) => Array.map(tasks, (t) => (t.id === stacked.id ? stacked : t)),
});
const model = modifyFields(loaded, { trace: () => TraceData.Success({ data: trace }) });

const app = { update: appUpdate, view: appView };

const openCodeButton = role("button", { name: "Open code" });
const backButton = role("button", { name: "Back to canvas" });
const treeTask = (id: string) => selector(`[data-tree-task="${id}"]`);
const treeCommit = (value: string) => selector(`[data-tree-commit="${value}"]`);
const treeFile = (path: string) => selector(`[data-tree-file="${path}"]`);
const patch = selector("[data-patch-path]");
const wholePath = `/api/diffs/${sha("0")}/${sha("b")}`;
const drawer = role("complementary");

/** The model after these messages, from the loaded trace. */
const after = (...messages: ReadonlyArray<Message>) =>
  Array.reduce(messages, model, (current, message) => appUpdate(current, message).model);

it("Open code on a task opens its whole diff, and its tree row is the current one", () => {
  scene(
    app,
    given(model),
    mounted,
    click(taskButton(stacked.id)),
    focusedDrawerHeading,
    click(within(drawer, openCodeButton)),
    ...canvasEnded(),
    expect(treeTask(stacked.id)).toHaveAttr("aria-current", "true"),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
    expect(selector("[data-shown]")).toContainText("2 commits"),
    expect(selector("[data-shown]")).toContainText(
      `${String.takeLeft(sha("0"), 7)}..${String.takeLeft(sha("b"), 7)}`,
    ),
    expect(selector("[data-code-bar]")).toContainText(stacked.branch),
  );
});

it("a drawer commit opens that commit, and the session pane shows its session", () => {
  scene(
    app,
    given(model),
    mounted,
    click(taskButton(stacked.id)),
    focusedDrawerHeading,
    click(within(drawer, role("button", { name: `First ${String.takeLeft(sha("a"), 7)}` }))),
    ...canvasEnded(),
    expect(treeCommit(sha("a"))).toHaveAttr("aria-current", "true"),
    expectAll(all.selector("[aria-current]")).toHaveCount(1),
    expect(patch).toHaveAttr("data-patch-path", `/api/commits/${sha("a")}`),
    expect(selector("[data-shown]")).toContainText("First"),
    expect(selector("[data-session-id]")).toHaveAttr("data-session-id", `${template.session}`),
  );
});

it("the tree selects a task, a commit and a file, one current row at a time", () => {
  scene(
    app,
    given(after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }))),
    expect(treeFile("src/a.ts")).toExist(),
    expect(treeFile("docs/c.md")).toExist(),
    click(treeFile("src/view/b.ts")),
    expect(treeFile("src/view/b.ts")).toHaveAttr("aria-current", "true"),
    expect(patch).toHaveAttr("data-file", "src/view/b.ts"),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
    click(treeCommit(sha("b"))),
    expect(treeCommit(sha("b"))).toHaveAttr("aria-current", "true"),
    expect(patch).toHaveAttr("data-patch-path", `/api/commits/${sha("b")}`),
    expect(treeFile("src/a.ts")).toBeAbsent(),
    expect(selector("[data-session-id]")).toBeAbsent(),
    click(treeFile("docs/c.md")),
    expectAll(all.selector("[aria-current]")).toHaveCount(2),
    click(treeTask(stacked.id)),
    expect(treeTask(stacked.id)).toHaveAttr("aria-current", "true"),
    expectAll(all.selector("[aria-current]")).toHaveCount(1),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
  );
});

it("the tree is three panes of the right widths, each pane scrolling on its own", () => {
  scene(
    app,
    given(after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }))),
    expect(selector('[data-code-pane="tree"]')).toHaveStyle("width", "280px"),
    expect(selector('[data-code-pane="tree"]')).toHaveStyle("overflow-y", "auto"),
    expect(selector('[data-code-pane="session"]')).toHaveStyle("width", "420px"),
    expect(selector('[data-code-pane="session"]')).toHaveStyle("overflow-y", "auto"),
    expect(selector('[data-code-pane="diff"]')).toExist(),
  );
});

it("a task with no commits opens with a middle pane that says so", () => {
  scene(
    app,
    given(after(Message.ClickedOpenCode({ id: bare.id, maybeSha: Option.none() }))),
    expect(patch).toBeAbsent(),
    expect(selector('[data-code-pane="diff"]')).toContainText("This task has no commits."),
    expect(selector('[data-code-pane="session"]')).toContainText("No session"),
  );
});

it("back to canvas returns the canvas with its pins and drawer as they were", () => {
  const pinned = after(Message.ClickedNode({ node: { id: stacked.id, kind: "task" } }));
  const there = appUpdate(
    pinned,
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
  ).model;
  scene(
    app,
    given(there),
    expect(selector("[data-code-view]")).toExist(),
    click(backButton),
    mounted,
    expect(selector(`[data-task="${stacked.id}"]`)).toHaveAttr("data-highlighted", "true"),
    expect(drawer).toExist(),
    expect(selector("[data-code-view]")).toBeAbsent(),
  );
});

it("opening the code view and going back changes only the screen", () => {
  const pinned = after(Message.ClickedNode({ node: { id: stacked.id, kind: "task" } }));
  const there = appUpdate(
    pinned,
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("a")) }),
  ).model;
  assert(there.screen).toEqual(
    Screen.Code({
      maybeFile: Option.none(),
      shown: Shown.OneCommit({ sha: sha("a") }),
      taskId: stacked.id,
    }),
  );
  assert(appUpdate(there, Message.ClickedBackToCanvas()).model).toEqual(pinned);
});

const inCode = after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("a")) }));
const missing = TaskId.make("missing");

it("messages that name nothing the trace or the screen holds are ignored", () => {
  const cases: ReadonlyArray<readonly [typeof model, Message]> = [
    [model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("f")) })],
    [model, Message.ClickedOpenCode({ id: bare.id, maybeSha: Option.some(sha("a")) })],
    [model, Message.ClickedOpenCode({ id: missing, maybeSha: Option.none() })],
    [model, Message.ClickedTreeTask({ id: stacked.id })],
    [model, Message.ClickedTreeCommit({ sha: sha("a") })],
    [model, Message.ClickedTreeFile({ path: "src/a.ts" })],
    [model, Message.ClickedBackToCanvas()],
    [inCode, Message.ClickedTreeCommit({ sha: sha("f") })],
    [inCode, Message.ClickedTreeFile({ path: "docs/c.md" })],
    [inCode, Message.ClickedTreeTask({ id: missing })],
    [init().model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })],
  ];
  Array.forEach(cases, ([start, message]) => {
    assert(appUpdate(start, message).model).toEqual(start);
  });
});
