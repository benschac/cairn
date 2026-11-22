import { SectionId, Sha, TaskId, TraceJudgment } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Schema, String, Struct } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  Command,
  all,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
  within,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { FocusDrawerHeading, FocusNode } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { DRAWER_HEADING_ID, drawerView, type DrawerMessages } from "../src/drawer.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { Drawer } from "../src/model.ts";
import { chainOf, sectionTitleOf, type Node } from "../src/trace.ts";
import { update as appUpdate } from "../src/update.ts";
import { view as appView } from "../src/view/view.ts";
import {
  focusedDrawerHeading,
  focusedNode,
  loaded,
  mounted,
  sectionButton,
  taskButton,
} from "./fixtures.ts";

const sectionNode = (id: string): Node => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section",
});
const taskNode = (id: TaskId): Node => ({ id, kind: "task" });

const Msg = defineMessageUnion({ Close: {}, Commit: { sha: Sha }, Task: { id: TaskId } });
type Msg = typeof Msg.Type;

const messages: DrawerMessages<Msg> = {
  onClickCommit: (sha) => Msg.Commit({ sha }),
  onClickTask: (id) => Msg.Task({ id }),
  onClose: Msg.Close(),
};

/** The first task in the demo trace with a commit, and that commit. */
const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Array.isReadonlyArrayNonEmpty(candidate.commits)),
);
const commit = Option.getOrThrow(Array.head(task.commits));
const spec = Array.headNonEmpty(task.specSections);
const specId = Schema.decodeSync(SectionId)(spec);

const unanswered = Schema.decodeSync(TraceJudgment)({
  action: "none",
  answer: { description: "no key", unanswered: "Missing" },
  at: "2026-01-01T00:00:00.000Z",
  inputHash: String.repeat(64)("a"),
  message: "skipped",
  question: "size",
  round: 1,
  stale: false,
  target: { id: spec, kind: "section" },
  verdict: "unsure",
});

const trace = Struct.evolve(demoTrace, {
  judgments: () => [
    unanswered,
    Struct.evolve(unanswered, {
      answer: () => ({ probability: 0.25 }),
      question: () => "buildable" as const,
      target: () => ({ id: task.id, kind: "task" as const }),
      verdict: () => "flag" as const,
    }),
    Struct.evolve(unanswered, {
      answer: () => ({ confidence: 0.9, label: "opus", probabilities: { opus: 0.9 } }),
      question: () => "model" as const,
      target: () => ({ id: task.id, kind: "task" as const }),
      verdict: () => "pass" as const,
    }),
  ],
});

interface DrawerModel {
  readonly node: Node;
}

const view = (model: DrawerModel, h: HtmlBuilder<Msg>): Html =>
  drawerView(trace, model.node, Option.none(), h, messages);
const update = (model: DrawerModel, _message: Msg) => ({ model });

/** An update that keeps every message the drawer sends, in order. */
const recording = () => {
  const sent: Array<Msg> = [];
  return {
    sent,
    update: (model: DrawerModel, message: Msg) => {
      sent.push(message);
      return { model };
    },
  };
};

const open = (node: Node) => given<DrawerModel>({ node });

const drawer = (name: string) => role("complementary", { name });
const closeButton = role("button", { name: "Close" });
const commitButton = (sha: Sha) => {
  const found = Option.getOrThrow(
    Array.findFirst(
      Array.flatMap(trace.tasks, (candidate) => candidate.commits),
      (candidate) => candidate.sha === sha,
    ),
  );
  return role("button", { name: `${found.subject} ${String.takeLeft(sha, 7)}` });
};
/** A task listed in a section's drawer. */
const drawerTask = (id: string) => selector(`[data-drawer-task="${id}"]`);
const drawerTaskButton = role("button", { name: `${task.id} ${task.title}` });

it("every section's drawer lists exactly the tasks in its chain", () => {
  Array.forEach(Array.appendAll(trace.prd.sections, trace.spec.sections), (section) => {
    const tasks = chainOf(trace, sectionNode(section.id)).tasks;
    scene(
      { update, view },
      open(sectionNode(section.id)),
      expect(drawer(section.title)).toHaveAttr("aria-labelledby", DRAWER_HEADING_ID),
      expectAll(all.selector("[data-drawer-task]")).toHaveCount(HashSet.size(tasks)),
      ...Array.map(Array.fromIterable(tasks), (id) =>
        expect(selector(`[data-drawer-task="${id}"]`)).toExist(),
      ),
    );
  });
});

it("a section drawer shows each linked task's commits as buttons with the short sha", () => {
  const linked = Array.filter(trace.tasks, (candidate) =>
    HashSet.has(chainOf(trace, sectionNode(spec)).tasks, candidate.id),
  );
  assert(Array.isReadonlyArrayNonEmpty(linked)).toBe(true);
  scene(
    { update, view },
    open(sectionNode(spec)),
    ...Array.flatMap(linked, (candidate) =>
      Array.map(candidate.commits, (linkedCommit) =>
        expect(within(drawerTask(candidate.id), commitButton(linkedCommit.sha))).toContainText(
          String.takeLeft(linkedCommit.sha, 7),
        ),
      ),
    ),
  );
});

it("the section drawer is two clicks from a commit: its commit button sends onClickCommit", () => {
  const recorder = recording();
  scene(
    { update: recorder.update, view },
    open(sectionNode(spec)),
    click(within(drawerTask(task.id), commitButton(commit.sha))),
  );
  assert(recorder.sent).toEqual([Msg.Commit({ sha: commit.sha })]);
});

it("clicking a task in a section drawer and the close button send their messages", () => {
  const recorder = recording();
  scene(
    { update: recorder.update, view },
    open(sectionNode(spec)),
    click(drawerTaskButton),
    click(closeButton),
  );
  assert(recorder.sent).toEqual([Msg.Task({ id: task.id }), Msg.Close()]);
});

it("a spec section drawer lists its judgments, with the unanswered reason", () => {
  scene(
    { update, view },
    open(sectionNode(spec)),
    expect(selector('[data-drawer-judgment="size"]')).toContainText("Missing: no key"),
    expect(selector('[data-drawer-judgment="size"]')).toHaveAttr("data-verdict", "unsure"),
    expect(selector('[data-drawer-judgment="buildable"]')).toBeAbsent(),
  );
});

it("a PRD section drawer has no judgments", () => {
  const prd = Option.getOrThrow(Array.head(trace.prd.sections));
  scene(
    { update, view },
    open(sectionNode(prd.id)),
    expect(selector('[data-drawer-part="judgments"]')).toBeAbsent(),
  );
});

it("a task drawer shows commits, sessions, events, gate reasons and judgments", () => {
  scene(
    { update, view },
    open(taskNode(task.id)),
    expect(drawer(`${task.id} ${task.title}`)).toExist(),
    expect(within(selector('[data-drawer-part="commits"]'), commitButton(commit.sha))).toExist(),
    ...Array.map(task.sessions, (id) =>
      expect(role("link", { name: id })).toHaveAttr("href", `/api/sessions/${id}`),
    ),
    expect(selector('[data-drawer-part="events"] li')).toExist(),
    expect(selector('[data-gate-source="humanGate"]')).toExist(),
    expect(selector('[data-gate-source="effective"]')).toExist(),
    ...Array.map(task.humanGate.reasons, (reason) =>
      expect(selector('[data-gate-reasons="humanGate"]')).toContainText(reason),
    ),
    ...Array.map(task.gate.reasons, (reason) =>
      expect(selector('[data-gate-reasons="effective"]')).toContainText(reason),
    ),
    expect(selector('[data-drawer-judgment="buildable"]')).toContainText("probability 0.25"),
    expect(selector('[data-drawer-judgment="model"]')).toContainText("opus (confidence 0.9)"),
    expect(selector('[data-drawer-judgment="size"]')).toBeAbsent(),
  );
});

it("a task drawer sends the commit and close messages", () => {
  const recorder = recording();
  scene(
    { update: recorder.update, view },
    open(taskNode(task.id)),
    click(commitButton(commit.sha)),
    click(closeButton),
  );
  assert(recorder.sent).toEqual([Msg.Commit({ sha: commit.sha }), Msg.Close()]);
});

it("an unknown task opens an empty drawer titled by its id, with only its Close button", () => {
  scene(
    { update, view },
    open(taskNode(TaskId.make("t-missing"))),
    expect(drawer("t-missing")).toExist(),
    expectAll(all.role("button")).toHaveCount(1),
    expect(closeButton).toExist(),
  );
});

it("the drawer is a complementary landmark named by its heading, which can take focus", () => {
  scene(
    { update, view },
    open(sectionNode(spec)),
    expect(selector('[role="dialog"]')).toBeAbsent(),
    expect(within(drawer(sectionTitleOf(trace, specId)), role("heading", { level: 2 }))).toHaveAttr(
      "id",
      DRAWER_HEADING_ID,
    ),
    // Tabindex(-1) sets the tabIndex property: focusable from code, but not a tab stop.
    expect(role("heading", { level: 2 })).toHaveAttr("tabIndex", "-1"),
    expect(closeButton).not.toHaveAttr("aria-label"),
  );
});

const app = { update: appUpdate, view: appView };
const specButton = sectionButton("Spec", specId);
const taskCardButton = taskButton(task.id);
const specDrawer = drawer(sectionTitleOf(trace, specId));
const taskDrawer = drawer(`${task.id} ${task.title}`);
const taskCard = selector(`[data-column="stacks"] [data-task="${task.id}"]`);
const specHeading = selector(`[data-column="spec"] [data-section="${spec}"]`);

it("the app starts with the drawer closed", () => {
  assert(init().model.drawer).toEqual(Drawer.Closed());
  scene(app, given(loaded), mounted, expect(role("complementary")).toBeAbsent());
});

it("clicking a task node opens its drawer, still selects its chain, and close shuts it", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(taskCardButton),
    focusedDrawerHeading,
    expect(taskDrawer).toHaveAttr("data-drawer-id", task.id),
    expect(taskCard).toHaveAttr("data-highlighted", "true"),
    click(closeButton),
    focusedNode,
    expect(role("complementary")).toBeAbsent(),
  );
});

it("clicking a section opens the drawer, then a commit shows its files: two clicks", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    expect(specDrawer).toHaveAttr("data-drawer-id", spec),
    click(within(drawerTask(task.id), commitButton(commit.sha))),
    expect(selector(`[data-commit-detail="${commit.sha}"]`)).toExist(),
    ...Array.map(commit.files, (file) =>
      expect(selector(`[data-commit-detail="${commit.sha}"]`)).toContainText(file),
    ),
    click(closeButton),
    focusedNode,
    expect(selector("[data-commit-detail]")).toBeAbsent(),
  );
});

it("a commit click that is not in the trace opens no detail, and a task click in the drawer switches tasks", () => {
  const unknown = appUpdate(
    modifyFields(loaded, {
      drawer: () => Drawer.Open({ maybeCommitSha: Option.none(), node: sectionNode(spec) }),
    }),
    Message.ClickedCommit({ sha: Sha.make(String.repeat(40)("f")) }),
  ).model;
  scene(
    app,
    given(unknown),
    mounted,
    expect(specDrawer).toExist(),
    expect(selector("[data-commit-detail]")).toBeAbsent(),
    click(within(specDrawer, drawerTaskButton)),
    focusedDrawerHeading,
    expect(taskDrawer).toHaveAttr("data-drawer-id", task.id),
  );
});

it("clicking the node whose drawer is open closes the drawer and clears the highlight", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    expect(specDrawer).toExist(),
    expect(specHeading).toHaveAttr("data-highlighted", "true"),
    click(specButton),
    expect(role("complementary")).toBeAbsent(),
    expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
  );
});

it("clicking another node swaps the drawer and the highlight to it", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    click(taskCardButton),
    focusedDrawerHeading,
    expect(taskDrawer).toHaveAttr("data-drawer-id", task.id),
    expectAll(all.role("complementary")).toHaveCount(1),
    expect(taskCard).toHaveAttr("data-highlighted", "true"),
  );
});

it("closing the drawer clears the selection's highlight", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    click(closeButton),
    focusedNode,
    expect(role("complementary")).toBeAbsent(),
    expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
  );
});

it("a commit click while the drawer is closed leaves the model unchanged", () => {
  assert(appUpdate(loaded, Message.ClickedCommit({ sha: commit.sha })).model).toBe(loaded);
});

it.prop(
  "a task clicked in a drawer opens that task's drawer, whatever was open, never closing it",
  { drawer: Drawer, id: TaskId },
  ({ drawer: openBefore, id }) => {
    const opened = Drawer.Open({ maybeCommitSha: Option.none(), node: taskNode(id) });
    // Whatever was open, and that same task's drawer, which a click on its node would close.
    Array.forEach([openBefore, opened], (before) => {
      const next = appUpdate(
        modifyFields(loaded, { drawer: () => before }),
        Message.ClickedDrawerTask({ id }),
      ).model;
      assert(next.drawer).toEqual(opened);
    });
  },
);

it("a task clicked in the section drawer opens its drawer, and a click on its node closes it", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    click(within(specDrawer, drawerTaskButton)),
    focusedDrawerHeading,
    expect(taskDrawer).toHaveAttr("data-drawer-id", task.id),
    expect(taskCard).toHaveAttr("data-highlighted", "true"),
    click(taskCardButton),
    expect(role("complementary")).toBeAbsent(),
  );
});

it("the clicked commit's detail sits inside the drawer", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(taskCardButton),
    focusedDrawerHeading,
    click(within(taskDrawer, commitButton(commit.sha))),
    expect(within(taskDrawer, selector(`[data-commit-detail="${commit.sha}"]`))).toExist(),
  );
});

it("opening a drawer focuses its heading, and closing it focuses the node that opened it", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    Command.expectExact(FocusDrawerHeading),
    focusedDrawerHeading,
    click(within(specDrawer, drawerTaskButton)),
    Command.expectExact(FocusDrawerHeading),
    focusedDrawerHeading,
    click(closeButton),
    // Focus goes back to the button of the node the drawer was open on.
    Command.resolve(FocusNode({ node: taskNode(task.id) }), Message.CompletedFocusNode()),
    Command.expectNone(),
    expect(role("complementary")).toBeAbsent(),
  );
});

it("the click that closes a drawer from its node moves no focus: it is already on that node", () => {
  scene(
    app,
    given(loaded),
    mounted,
    click(specButton),
    focusedDrawerHeading,
    click(specButton),
    Command.expectNone(),
    expect(role("complementary")).toBeAbsent(),
  );
});
