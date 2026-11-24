import { Sha, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Predicate, Result, String, Struct } from "effect";
import {
  Command,
  all,
  click,
  expect,
  expectAll,
  given,
  Mount,
  role,
  scene,
  selector,
  within,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { vi } from "vitest";

import { FetchPatch } from "../src/command.ts";
import { RenderDiff } from "../src/diff.ts";
import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { view as appView } from "../src/view/view.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import rangePatch from "./fixtures/range.patch?raw";
import { canvasEnded, focusedDrawerHeading, loaded, mounted, taskButton } from "./fixtures.ts";

const sha = (character: string) => Sha.make(String.repeat(40)(character));

/** A task with two commits, the first with a session and the second without, and a task with none. */
const stackedBase = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) =>
    Option.exists(Array.head(t.commits), (commit) => Predicate.isNotNull(commit.session)),
  ),
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
const commitPath = (value: string) => `/api/commits/${sha(value)}`;

/** The diff mount of a loaded patch answers once it has parsed the patch and drawn it. */
const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

/** The fetch of a path is answered with its text, or with a failure. */
const fetched = (path: string, result: Result.Result<string, string>) =>
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Command.resolve(FetchPatch({ path }), Message.ReceivedPatch({ path, result }));

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
    fetched(wholePath, Result.succeed(rangePatch)),
    drawn,
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
    fetched(commitPath("a"), Result.succeed(commitPatch)),
    drawn,
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
    fetched(commitPath("b"), Result.succeed(commitPatch)),
    drawn,
    expect(treeCommit(sha("b"))).toHaveAttr("aria-current", "true"),
    expect(patch).toHaveAttr("data-patch-path", `/api/commits/${sha("b")}`),
    expect(treeFile("src/a.ts")).toBeAbsent(),
    expect(selector("[data-session-id]")).toBeAbsent(),
    click(treeFile("docs/c.md")),
    expectAll(all.selector("[aria-current]")).toHaveCount(2),
    click(treeTask(stacked.id)),
    Mount.expectEnded(RenderDiff),
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
  assert(appUpdate(there, Message.ClickedBackToCanvas()).model).toEqual(
    modifyFields(pinned, { patches: () => there.patches }),
  );
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

// PATCHES

it("opening a task asks for its patch route once, and shows it loading", () => {
  const opened = appUpdate(
    model,
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
  );
  assert(
    Array.map(
      Option.getOrElse(Option.fromUndefinedOr(opened.commands), () => []),
      (command) => [command.name, command.args],
    ),
  ).toEqual([["FetchPatch", { path: wholePath }]]);
  scene(app, given(opened.model), expect(patch).toContainText("Loading"));
});

it("a failed fetch shows its error, and selecting the path again fetches it again", () => {
  scene(
    app,
    given(
      after(
        Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
        Message.ReceivedPatch({ path: wholePath, result: Result.fail("unknown revision") }),
      ),
    ),
    expect(patch).toContainText("unknown revision"),
    click(treeCommit(sha("a"))),
    fetched(commitPath("a"), Result.succeed(commitPatch)),
    expect(patch).toHaveAttr("data-patch-path", commitPath("a")),
    drawn,
    click(treeTask(stacked.id)),
    Mount.expectEnded(RenderDiff),
    fetched(wholePath, Result.succeed(rangePatch)),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
    drawn,
  );
});

it("a loaded path is not fetched again, and a loading one is not fetched twice", () => {
  const loadedWhole = after(
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
  );
  scene(
    app,
    given(loadedWhole),
    drawn,
    click(treeCommit(sha("a"))),
    Mount.expectEnded(RenderDiff),
    fetched(commitPath("a"), Result.succeed(commitPatch)),
    drawn,
    // A scene tells mounts apart by name and position, so a loaded patch swapped for another
    // loaded patch is the same mount to it; the keyed element is checked in diff-view.scene.test.ts.
    click(treeTask(stacked.id)),
    Command.expectNone(),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
    click(treeCommit(sha("a"))),
    Command.expectNone(),
    expect(patch).toHaveAttr("data-patch-path", commitPath("a")),
  );
  const loading = appUpdate(
    appUpdate(model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })).model,
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
  );
  assert(loading.commands).toBeUndefined();
});

it("a loaded patch is handed to the mount whatever it holds, since only the mount parses it", () => {
  scene(
    app,
    given(
      after(
        Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
        Message.ReceivedPatch({ path: wholePath, result: Result.succeed("") }),
      ),
    ),
    expect(patch).toHaveAttr("data-patch-path", wholePath),
    drawn,
  );
});

it("the demo build fetches nothing and says the diff needs cairn serve", () => {
  vi.stubEnv("PROD", true);
  try {
    const opened = appUpdate(
      model,
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    );
    assert(opened.commands).toBeUndefined();
    scene(app, given(opened.model), expect(patch).toContainText("cairn serve"));
  } finally {
    vi.unstubAllEnvs();
  }
});
