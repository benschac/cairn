import { PrdSectionId, Session, SpecSectionId, Step, type Link } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Result, Schema } from "effect";
import {
  Command,
  Mount,
  all,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
} from "foldkit/scene";

import { diffPathOf, rangeOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { aloneOf, linkOf, pathOfLink, trailLinkOf, trunkOf } from "../src/links.ts";
import { Message } from "../src/message.ts";
import { CopyLink, openLink, update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import { loaded, unmeasuredWires } from "./fixtures.ts";

const app = { update, view };
const decodeStep = Schema.decodeUnknownSync(Step);

const linked = (steps: ReadonlyArray<unknown>) =>
  openLink(
    loaded,
    Array.map(steps, (step) => decodeStep(step)),
  ).model;

const readerMounted = Mount.resolveAll(
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

/** The clipboard taking the path the click sent. */
const copied = (path: string) =>
  Command.resolve(
    CopyLink({ path }),
    // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
    Message.CompletedCopyLink({ isCopied: true, path }),
  );

/** The button that copies `path`, in the part of the page the selector names. */
const copyButton = (within: string, path: string) =>
  selector(`${within} [data-copy-link="${path}"]`);

// THE PRD

it("a PRD heading's Copy link copies its section alone, and reads copied once the clipboard took it", () => {
  const heading = copyButton('[data-prd-sec="prd.viewer"] .prd-sh', "/section/prd.viewer");
  scene(
    app,
    given(linked([{ id: "prd.viewer", kind: "section" }])),
    readerMounted,
    expect(heading).toHaveText("Copy link"),
    click(heading),
    Command.expectExact(CopyLink),
    copied("/section/prd.viewer"),
    expect(heading).toHaveText("copied"),
    // The pinned section's status line row holds the same path, so it reads copied too.
    expect(copyButton('[data-prd-sec="prd.viewer"] .prd-pinrow', "/section/prd.viewer")).toHaveText(
      "copied",
    ),
    // Another section's button is not the one that was copied.
    expect(copyButton('[data-prd-sec="prd.goal"] .prd-sh', "/section/prd.goal")).toHaveText(
      "Copy link",
    ),
  );
});

it("a refused copy leaves the button as it was", () => {
  const heading = copyButton('[data-prd-sec="prd.viewer"] .prd-sh', "/section/prd.viewer");
  scene(
    app,
    given(linked([{ id: "prd.viewer", kind: "section" }])),
    readerMounted,
    click(heading),
    Command.resolve(
      CopyLink({ path: "/section/prd.viewer" }),
      // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
      Message.CompletedCopyLink({ isCopied: false, path: "/section/prd.viewer" }),
    ),
    expect(heading).toHaveText("Copy link"),
  );
});

it("only the pinned section's status line row has a Copy link", () => {
  scene(
    app,
    given(linked([{ id: "prd.viewer", kind: "section" }])),
    readerMounted,
    expect(selector('[data-prd-sec="prd.viewer"] .prd-pinrow [data-copy-link]')).toExist(),
    expectAll(all.selector("[data-prd-pane] .prd-pinrow [data-copy-link]")).toHaveCount(1),
  );
});

// THE SPEC CARDS

it("a spec card's Copy link copies its section alone", () => {
  const task = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (candidate) =>
      Array.some(candidate.specSections, (id) => Schema.is(SpecSectionId)(id)),
    ),
  );
  const spec = Option.getOrThrow(Array.head(task.specSections));
  const prd = Option.getOrThrow(Array.head(task.prdSections));
  scene(
    app,
    given(linked([{ id: prd, kind: "section" }])),
    readerMounted,
    expect(copyButton(`[data-spec="${spec}"]`, `/section/${spec}`)).toHaveText("Copy link"),
    click(copyButton(`[data-spec="${spec}"]`, `/section/${spec}`)),
    Command.expectExact(CopyLink),
    copied(`/section/${spec}`),
    expect(copyButton(`[data-spec="${spec}"]`, `/section/${spec}`)).toHaveText("copied"),
  );
});

// THE DETAIL PANEL

const taskWithSpec = Option.getOrThrow(
  Array.findFirst(
    demoTrace.tasks,
    (candidate) =>
      Array.isReadonlyArrayNonEmpty(candidate.specSections) &&
      Array.isReadonlyArrayEmpty(candidate.commits),
  ),
);
const specId = Option.getOrThrow(Array.head(taskWithSpec.specSections));
const twoSteps = linked([
  { id: specId, kind: "section" },
  { id: taskWithSpec.id, kind: "task" },
]);
const TWO_STEP_PATH = `/section/${specId}/task/${taskWithSpec.id}`;

it("each step of the trail copies the path up to it, and the heading copies its node alone", () => {
  const trail = (path: string) => copyButton("[data-detail-trail]", path);
  scene(
    app,
    given(twoSteps),
    readerMounted,
    expectAll(all.selector("[data-detail-trail] [data-copy-link]")).toHaveCount(2),
    expect(trail(`/section/${specId}`)).toExist(),
    click(trail(TWO_STEP_PATH)),
    Command.expectExact(CopyLink),
    copied(TWO_STEP_PATH),
    expect(trail(TWO_STEP_PATH)).toHaveText("copied"),
    expect(trail(`/section/${specId}`)).toHaveText("Copy link"),
    // The heading's own button copies the shown task, with nothing before it.
    click(copyButton("[data-detail-content]", `/task/${taskWithSpec.id}`)),
    Command.expectExact(CopyLink),
    copied(`/task/${taskWithSpec.id}`),
  );
});

it("the two-step path is the link the model holds, cut at each step", () => {
  assert(pathOfLink(linkOf(twoSteps))).toBe(TWO_STEP_PATH);
  assert(pathOfLink(trailLinkOf(twoSteps, 0))).toBe(`/section/${specId}`);
  assert(pathOfLink(trailLinkOf(twoSteps, 1))).toBe(TWO_STEP_PATH);
});

// THE STACKS PANE

const stacks = stacksOf(demoTrace.tasks);
const withTrunk = Option.getOrThrow(
  Array.findFirst(stacks, (stack) => Array.length(trunkOf(stack, demoTrace.tasks)) >= 2),
);
const withoutTrunk = Option.getOrThrow(
  Array.findFirst(stacks, (stack) => Array.length(trunkOf(stack, demoTrace.tasks)) < 2),
);
const boxOf = (number: number) => `[data-stacks-pane] [data-stack="${number}"]`;

it("a stack box's corner copies /stack/<root>", () => {
  const corner = copyButton(boxOf(withTrunk.number), `/stack/${withTrunk.root}`);
  scene(
    app,
    given(linked([{ id: "prd.viewer", kind: "section" }])),
    readerMounted,
    expect(corner).toHaveText("Copy link"),
    click(corner),
    Command.expectExact(CopyLink),
    copied(`/stack/${withTrunk.root}`),
    expect(corner).toHaveText("copied"),
  );
});

it("a box whose finished trunk holds two tasks also copies /segment/<root>, and no other does", () => {
  const trunkButton = copyButton(boxOf(withTrunk.number), `/segment/${withTrunk.root}`);
  scene(
    app,
    given(linked([{ id: "prd.viewer", kind: "section" }])),
    readerMounted,
    expect(trunkButton).toHaveText("Copy link to finished trunk"),
    click(trunkButton),
    Command.expectExact(CopyLink),
    copied(`/segment/${withTrunk.root}`),
    expect(trunkButton).toHaveText("copied"),
    expect(selector(`${boxOf(withoutTrunk.number)} [data-copy-link^="/segment/"]`)).toBeAbsent(),
    expect(selector(`${boxOf(withoutTrunk.number)} [data-copy-link^="/stack/"]`)).toExist(),
    expectAll(all.selector("[data-stacks-pane] [data-copy-link^='/stack/']")).toHaveCount(
      Array.length(stacks),
    ),
  );
});

// THE CODE VIEW

const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Option.isSome(rangeOf(candidate))),
);
const { base, head } = Option.getOrThrow(rangeOf(task));
const FILE = "packages/contract/src/events.ts";
const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

/** A section, then the task's diff at its head with a file and lines, its patch received. */
const withLines = update(
  linked([
    { id: "prd.viewer", kind: "section" },
    { id: task.id, kind: "task" },
    { head, kind: "diff" },
    { kind: "file", path: FILE },
    { end: 3, kind: "lines", side: "new", start: 1 },
  ]),
  Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
).model;

const TO_FILE = `/task/${task.id}/diff/${head}/file/${encodeURIComponent(FILE)}`;

it("Copy link copies the whole path, and Copy alone copies the lines with their task, diff and file", () => {
  const whole = `/section/prd.viewer${TO_FILE}/lines/n1-3`;
  const alone = `${TO_FILE}/lines/n1-3`;
  scene(
    app,
    given(withLines),
    drawn,
    click(role("button", { name: "Copy alone" })),
    Command.expectExact(CopyLink),
    copied(alone),
    expect(role("button", { name: "copied" })).toExist(),
    click(role("button", { name: "Copy link" })),
    Command.expectExact(CopyLink),
    copied(whole),
  );
});

it("with no lines selected, Copy alone copies the file with its task and diff", () => {
  const noLines = update(
    linked([
      { id: task.id, kind: "task" },
      { head, kind: "diff" },
      { kind: "file", path: FILE },
    ]),
    Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
  ).model;
  scene(
    app,
    given(noLines),
    drawn,
    expect(selector("[data-code-bar]")).toExist(),
    click(role("button", { name: "Copy alone" })),
    Command.expectExact(CopyLink),
    copied(TO_FILE),
    // With nothing before the task, the whole path and the last step alone are the same text.
    expectAll(all.selector(`[data-code-bar] [data-copy-link="${TO_FILE}"]`)).toHaveCount(2),
  );
});

// THE SESSION PANE

const sessioned = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) =>
    Array.some(each.commits, (commit) => commit.session !== null),
  ),
);
const commit = Option.getOrThrow(
  Array.findFirst(sessioned.commits, (each) => each.session !== null),
);
const sessionId = `${commit.session}`;
const session = Schema.decodeUnknownSync(Session)({
  format: "claude-code",
  id: sessionId,
  notes: [],
  redactions: {},
  skipped: 0,
  taskId: "t1",
  turns: [
    {
      at: "2026-11-25T10:00:02.000Z",
      edits: [],
      failed: false,
      id: "t1",
      input: "ls",
      kind: "tool",
      name: "Bash",
      output: "a.ts",
      target: null,
    },
  ],
  version: 1,
});
const sessionShown = update(
  update(loaded, Message.ClickedOpenCode({ id: sessioned.id, maybeSha: Option.some(commit.sha) }))
    .model,
  Message.ReceivedSession({ id: sessionId, result: Result.succeed(session) }),
).model;

it("an opened turn copies the path up to its turn, and a closed one has no button", () => {
  const path = `/task/${sessioned.id}/commit/${commit.sha}/turn/${sessionId}/t1`;
  scene(
    app,
    given(sessionShown),
    expect(selector('[data-turn="t1"] [data-copy-link]')).toBeAbsent(),
    click(selector('[data-turn="t1"] button[aria-expanded]')),
    expect(copyButton('[data-turn="t1"]', path)).toHaveText("Copy link"),
    click(copyButton('[data-turn="t1"]', path)),
    Command.expectExact(CopyLink),
    copied(path),
    expect(copyButton('[data-turn="t1"]', path)).toHaveText("copied"),
  );
});

// aloneOf, on a link a button reads

it("aloneOf of the last step of a code link is the task, diff, file and lines, and of its first a section", () => {
  const link: Link = Array.map(
    [
      { id: "prd.viewer", kind: "section" },
      { id: task.id, kind: "task" },
      { head, kind: "diff" },
      { kind: "file", path: FILE },
      { end: 3, kind: "lines", side: "new", start: 1 },
    ],
    (step) => decodeStep(step),
  );
  assert(Option.map(aloneOf(link, 4), pathOfLink)).toEqual(Option.some(`${TO_FILE}/lines/n1-3`));
  assert(Option.map(aloneOf(link, 0), pathOfLink)).toEqual(Option.some("/section/prd.viewer"));
  assert(aloneOf(link, 5)).toEqual(Option.none());
});
