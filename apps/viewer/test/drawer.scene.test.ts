import { SectionId, Sha, TaskId, TraceJudgment } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Schema, String, Struct } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { all, click, expect, expectAll, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { drawerView, type DrawerMessages } from "../src/drawer.ts";
import { Message, init, update as appUpdate, view as appView } from "../src/main.ts";
import { chainOf, type Node } from "../src/trace.ts";
import { loaded, mounted } from "./fixtures.ts";

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
  drawerView(trace, model.node, h, messages);
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

it("every section's drawer lists exactly the tasks in its chain", () => {
  Array.forEach(Array.appendAll(trace.prd.sections, trace.spec.sections), (section) => {
    const tasks = chainOf(trace, sectionNode(section.id)).tasks;
    scene(
      { update, view },
      open(sectionNode(section.id)),
      expect(selector('[role="dialog"]')).toHaveAttr("aria-label", `Details for ${section.title}`),
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
        expect(
          selector(`[data-drawer-task="${candidate.id}"] [data-commit="${linkedCommit.sha}"]`),
        ).toContainText(String.takeLeft(linkedCommit.sha, 7)),
      ),
    ),
  );
});

it("the section drawer is two clicks from a commit: its commit button sends onClickCommit", () => {
  const recorder = recording();
  scene(
    { update: recorder.update, view },
    open(sectionNode(spec)),
    click(selector(`[data-drawer-task="${task.id}"] [data-commit="${commit.sha}"]`)),
  );
  assert(recorder.sent).toEqual([Msg.Commit({ sha: commit.sha })]);
});

it("clicking a task in a section drawer and the close button send their messages", () => {
  const recorder = recording();
  scene(
    { update: recorder.update, view },
    open(sectionNode(spec)),
    click(selector(`[data-open-task="${task.id}"]`)),
    click(selector("[data-close]")),
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
    expect(selector('[role="dialog"]')).toHaveAttr(
      "aria-label",
      `Details for ${task.id} ${task.title}`,
    ),
    expect(selector(`[data-drawer-part="commits"] [data-commit="${commit.sha}"]`)).toExist(),
    ...Array.map(task.sessions, (id) =>
      expect(selector(`[data-session="${id}"]`)).toHaveAttr("href", `/api/sessions/${id}`),
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
    click(selector(`[data-commit="${commit.sha}"]`)),
    click(selector("[data-close]")),
  );
  assert(recorder.sent).toEqual([Msg.Commit({ sha: commit.sha }), Msg.Close()]);
});

it("an unknown task opens an empty dialog titled by its id", () => {
  scene(
    { update, view },
    open(taskNode(TaskId.make("t-missing"))),
    expect(selector('[role="dialog"]')).toHaveAttr("aria-label", "Details for t-missing"),
    expect(selector("[data-commit]")).toBeAbsent(),
  );
});

it("the app starts with the drawer closed", () => {
  assert(Option.isNone(init().model.maybeDrawer)).toBe(true);
  scene(
    { update: appUpdate, view: appView },
    given(loaded),
    mounted,
    expect(selector("[data-drawer]")).toBeAbsent(),
  );
});

it("clicking a task node opens its drawer, still selects its chain, and close shuts it", () => {
  scene(
    { update: appUpdate, view: appView },
    given(loaded),
    mounted,
    click(selector(`[data-column="stacks"] [data-task="${task.id}"]`)),
    expect(selector('[data-drawer="task"]')).toHaveAttr("data-drawer-id", task.id),
    expect(selector(`[data-column="stacks"] [data-task="${task.id}"]`)).toHaveAttr(
      "data-highlighted",
      "true",
    ),
    click(selector("[data-close]")),
    expect(selector("[data-drawer]")).toBeAbsent(),
  );
});

it("clicking a section opens the drawer, then a commit shows its files: two clicks", () => {
  scene(
    { update: appUpdate, view: appView },
    given(loaded),
    mounted,
    click(selector(`[data-column="spec"] [data-section="${spec}"]`)),
    expect(selector('[data-drawer="section"]')).toHaveAttr("data-drawer-id", spec),
    click(selector(`[data-drawer-task="${task.id}"] [data-commit="${commit.sha}"]`)),
    expect(selector(`[data-commit-detail="${commit.sha}"]`)).toExist(),
    ...Array.map(commit.files, (file) =>
      expect(selector(`[data-commit-detail="${commit.sha}"]`)).toContainText(file),
    ),
    click(selector("[data-close]")),
    expect(selector("[data-commit-detail]")).toBeAbsent(),
  );
});

it("a commit click that is not in the trace opens no detail, and a task click in the drawer switches tasks", () => {
  const unknown = appUpdate(
    modifyFields(loaded, { maybeDrawer: () => Option.some(sectionNode(spec)) }),
    Message.ClickedCommit({ sha: Sha.make(String.repeat(40)("f")) }),
  ).model;
  scene(
    { update: appUpdate, view: appView },
    given(unknown),
    mounted,
    expect(selector('[data-drawer="section"]')).toExist(),
    expect(selector("[data-commit-detail]")).toBeAbsent(),
    click(selector(`[data-open-task="${task.id}"]`)),
    expect(selector('[data-drawer="task"]')).toHaveAttr("data-drawer-id", task.id),
  );
});
