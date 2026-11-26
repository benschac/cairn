import { PrdSectionId, SectionId, Session, SpecSectionId, Step, type Link } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema, String, pipe } from "effect";

import { Locator } from "@effect/ui/testing";
import { diffPathOf, rangeOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { aloneOf, linkOf, pathOfLink, trailLinkOf, trunkOf } from "../src/links.ts";
import { Message } from "../src/message.ts";
import { indexOf } from "../src/search.ts";
import { quoteOf } from "../src/subscription/selection.ts";
import { CopyLink, openLink, update } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import {
  attrStartingWith,
  attr,
  both,
  byRole,
  containing,
  data,
  detailDividerRunning,
  drawnDiff,
  inside,
  loaded,
  pushedUrl,
  readerMounted,
  resolved,
  tag,
  viewerScene,
  withClass,
  type ViewerSteps,
} from "./fixtures.ts";

const decodeStep = Schema.decodeUnknownSync(Step);

const linked = (steps: ReadonlyArray<unknown>) =>
  openLink(
    loaded,
    Array.map(steps, (step) => decodeStep(step)),
  ).model;

/** The clipboard taking the path the click sent. */
const copied = (path: string) =>
  resolved(CopyLink, Message.CompletedCopyLink({ isCopied: true, path }));

/** The button that copies `path`, in the part of the page `within` finds. */
const copyButton = (within: Locator.Locator, path: string) =>
  inside(within, data("copy-link", path));

/** The click asked the clipboard, and nothing else. */
const copying = (s: ViewerSteps) => s.expectExact(CopyLink);

// THE PRD

it.effect(
  "a PRD heading's Copy link copies its section alone, and reads copied once the clipboard took it",
  () =>
    Effect.gen(function* () {
      const heading = copyButton(
        inside(data("prd-sec", "prd.viewer"), withClass("prd-sh")),
        "/section/prd.viewer",
      );
      const s = yield* viewerScene(linked([{ id: "prd.viewer", kind: "section" }]));
      s.pipe(readerMounted)
        .expect(heading)
        .toHaveText("Copy link")
        .click(heading)
        .pipe(copying, copied("/section/prd.viewer"))
        .expect(heading)
        .toHaveText("copied")
        // The pinned section's status line row holds the same path, so it reads copied too.
        .expect(
          copyButton(
            inside(data("prd-sec", "prd.viewer"), withClass("prd-pinrow")),
            "/section/prd.viewer",
          ),
        )
        .toHaveText("copied")
        // Another section's button is not the one that was copied.
        .expect(
          copyButton(inside(data("prd-sec", "prd.goal"), withClass("prd-sh")), "/section/prd.goal"),
        )
        .toHaveText("Copy link");
    }),
);

it.effect("a refused copy leaves the button as it was", () =>
  Effect.gen(function* () {
    const heading = copyButton(
      inside(data("prd-sec", "prd.viewer"), withClass("prd-sh")),
      "/section/prd.viewer",
    );
    const s = yield* viewerScene(linked([{ id: "prd.viewer", kind: "section" }]));
    s.pipe(readerMounted)
      .click(heading)
      .pipe(
        resolved(
          CopyLink,
          Message.CompletedCopyLink({ isCopied: false, path: "/section/prd.viewer" }),
        ),
      )
      .expect(heading)
      .toHaveText("Copy link");
  }),
);

it.effect("only the pinned section's status line row has a Copy link", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([{ id: "prd.viewer", kind: "section" }]));
    s.pipe(readerMounted)
      .expect(
        inside(inside(data("prd-sec", "prd.viewer"), withClass("prd-pinrow")), data("copy-link")),
      )
      .toExist()
      .expect(inside(inside(data("prd-pane"), withClass("prd-pinrow")), data("copy-link")))
      .toHaveCount(1);
  }),
);

// THE SPEC CARDS

it.effect("a spec card's Copy link copies its section alone", () =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(
      Array.findFirst(demoTrace.tasks, (candidate) =>
        Array.some(candidate.specSections, (id) => Schema.is(SpecSectionId)(id)),
      ),
    );
    const spec = Option.getOrThrow(Array.head(task.specSections));
    const prd = Option.getOrThrow(Array.head(task.prdSections));
    const button = copyButton(data("spec", spec), `/section/${spec}`);
    const s = yield* viewerScene(linked([{ id: prd, kind: "section" }]));
    s.pipe(readerMounted)
      .expect(button)
      .toHaveText("Copy link")
      .click(button)
      .pipe(copying, copied(`/section/${spec}`))
      .expect(button)
      .toHaveText("copied");
  }),
);

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

it.effect(
  "each step of the trail copies the path up to it, and the heading copies its node alone",
  () =>
    Effect.gen(function* () {
      const trail = (path: string) => copyButton(data("detail-trail"), path);
      const s = yield* viewerScene(twoSteps);
      s.pipe(readerMounted, detailDividerRunning)
        .expect(inside(data("detail-trail"), data("copy-link")))
        .toHaveCount(2)
        .expect(trail(`/section/${specId}`))
        .toExist()
        .click(trail(TWO_STEP_PATH))
        .pipe(copying, copied(TWO_STEP_PATH))
        .expect(trail(TWO_STEP_PATH))
        .toHaveText("copied")
        .expect(trail(`/section/${specId}`))
        .toHaveText("Copy link")
        // The heading's own button copies the shown task, with nothing before it.
        .click(copyButton(data("detail-content"), `/task/${taskWithSpec.id}`))
        .pipe(copying, copied(`/task/${taskWithSpec.id}`));
    }),
);

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
const boxOf = (number: number) => inside(data("stacks-pane"), data("stack", `${number}`));

it.effect("a stack box's corner copies /stack/<root>", () =>
  Effect.gen(function* () {
    const corner = copyButton(boxOf(withTrunk.number), `/stack/${withTrunk.root}`);
    const s = yield* viewerScene(linked([{ id: "prd.viewer", kind: "section" }]));
    s.pipe(readerMounted)
      .expect(corner)
      .toHaveText("Copy link")
      .click(corner)
      .pipe(copying, copied(`/stack/${withTrunk.root}`))
      .expect(corner)
      .toHaveText("copied");
  }),
);

it.effect(
  "a box whose finished trunk holds two tasks also copies /segment/<root>, and no other does",
  () =>
    Effect.gen(function* () {
      const trunkButton = copyButton(boxOf(withTrunk.number), `/segment/${withTrunk.root}`);
      const s = yield* viewerScene(linked([{ id: "prd.viewer", kind: "section" }]));
      s.pipe(readerMounted)
        .expect(trunkButton)
        .toHaveText("Copy link to finished trunk")
        .click(trunkButton)
        .pipe(copying, copied(`/segment/${withTrunk.root}`))
        .expect(trunkButton)
        .toHaveText("copied")
        .expect(inside(boxOf(withoutTrunk.number), attrStartingWith("data-copy-link", "/segment/")))
        .toBeAbsent()
        .expect(inside(boxOf(withoutTrunk.number), attrStartingWith("data-copy-link", "/stack/")))
        .toExist()
        .expect(inside(data("stacks-pane"), attrStartingWith("data-copy-link", "/stack/")))
        .toHaveCount(Array.length(stacks));
    }),
);

// THE CODE VIEW

const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Option.isSome(rangeOf(candidate))),
);
const { base, head } = Option.getOrThrow(rangeOf(task));
const FILE = "packages/contract/src/events.ts";
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

it.effect(
  "Copy link copies the whole path, and Copy alone copies the lines with their task, diff and file",
  () =>
    Effect.gen(function* () {
      const whole = `/section/prd.viewer${TO_FILE}/lines/n1-3`;
      const alone = `${TO_FILE}/lines/n1-3`;
      const s = yield* viewerScene(withLines);
      s.pipe(drawnDiff)
        .click(byRole("button", { name: "Copy alone" }))
        .pipe(copying, copied(alone))
        .expect(byRole("button", { name: "copied" }))
        .toExist()
        .click(byRole("button", { name: "Copy link" }))
        .pipe(copying, copied(whole));
    }),
);

it.effect("with no lines selected, Copy alone copies the file with its task and diff", () =>
  Effect.gen(function* () {
    const noLines = update(
      linked([
        { id: task.id, kind: "task" },
        { head, kind: "diff" },
        { kind: "file", path: FILE },
      ]),
      Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
    ).model;
    const s = yield* viewerScene(noLines);
    s.pipe(drawnDiff)
      .expect(data("code-bar"))
      .toExist()
      .click(byRole("button", { name: "Copy alone" }))
      .pipe(copying, copied(TO_FILE))
      // With nothing before the task, the whole path and the last step alone are the same text.
      .expect(inside(data("code-bar"), data("copy-link", TO_FILE)))
      .toHaveCount(2);
  }),
);

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

it.effect("an opened turn copies the path up to its turn, and a closed one has no button", () =>
  Effect.gen(function* () {
    const path = `/task/${sessioned.id}/commit/${commit.sha}/turn/${sessionId}/t1`;
    const turn = both(tag("li"), data("turn", "t1"));
    const s = yield* viewerScene(sessionShown);
    s.expect(inside(turn, data("copy-link")))
      .toBeAbsent()
      .click(inside(turn, both(tag("button"), attr("aria-expanded"))))
      .pipe(pushedUrl)
      .expect(copyButton(turn, path))
      .toHaveText("Copy link")
      .click(copyButton(turn, path))
      .pipe(copying, copied(path))
      .expect(copyButton(turn, path))
      .toHaveText("copied");
  }),
);

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

// A SELECTED PASSAGE

/** The first four words of a section's first prose block: text a link to the section still finds. */
const quoteIn = (id: string) =>
  Option.getOrThrow(
    pipe(
      Array.findFirst(indexOf(demoTrace).content, (entry) => entry.node.id === id),
      Option.flatMap((entry) => Array.findFirst(entry.fields, (field) => field.kind === "prose")),
      Option.map((field) => Array.join(Array.take(String.split(quoteOf(field.text), " "), 4), " ")),
      Option.filter((quote) => Array.length(String.split(quote, " ")) === 4),
    ),
  );

const PRD_QUOTE = quoteIn("prd.viewer");
/** The reader with nothing opened. */
const reading = linked([]);
const selecting = (model: typeof loaded, section: string, quote: string) =>
  update(model, Message.SelectedPassage({ quote, section: SectionId.make(section) })).model;
const passageStepOf = (section: string, quote: string) =>
  decodeStep({ kind: "passage", quote, section });
const PRD_PATH = pathOfLink([passageStepOf("prd.viewer", PRD_QUOTE)]);
const passageButton = (section: string) => data("copy-passage", section);
const statusLine = data("status-line", "prd.viewer");
const markedPassage = (pane: string) => inside(data(pane), both(tag("mark"), data("link-passage")));

it.effect(
  "Copy link to passage pins the section, marks the passage and copies the link up to it",
  () =>
    Effect.gen(function* () {
      assert(String.startsWith("/passage/prd.viewer/")(PRD_PATH)).toBe(true);
      const s = yield* viewerScene(selecting(reading, "prd.viewer", PRD_QUOTE));
      s.pipe(readerMounted)
        .expect(data("copy-passage"))
        .toHaveCount(1)
        .expect(passageButton("prd.viewer"))
        .toHaveText("Copy link to passage")
        .expect(statusLine)
        .toHaveAttribute("aria-pressed", "false")
        .click(passageButton("prd.viewer"))
        .pipe(pushedUrl, copying, copied(PRD_PATH))
        .expect(statusLine)
        .toHaveAttribute("aria-pressed", "true")
        .expect(markedPassage("prd-pane"))
        .toHaveText(containing(Option.getOrThrow(Array.head(String.split(PRD_QUOTE, " ")))))
        // The pinned row's own Copy link holds the same path, so it reads copied too.
        .expect(
          copyButton(inside(data("prd-sec", "prd.viewer"), withClass("prd-pinrow")), PRD_PATH),
        )
        .toHaveText("copied");
    }),
);

it.effect(
  "the passage button is in the selected section's row alone, and leaves with the selection",
  () =>
    Effect.gen(function* () {
      const selected = selecting(reading, "prd.viewer", PRD_QUOTE);
      const first = yield* viewerScene(selected);
      first
        .pipe(readerMounted)
        .expect(
          inside(
            inside(data("prd-sec", "prd.viewer"), withClass("prd-pinrow")),
            data("copy-passage"),
          ),
        )
        .toExist()
        .expect(inside(data("prd-sec", "prd.goal"), data("copy-passage")))
        .toBeAbsent();
      const second = yield* viewerScene(update(selected, Message.ClearedPassageSelection()).model);
      second.pipe(readerMounted).expect(data("copy-passage")).toHaveCount(0);
    }),
);

/** A PRD section's prose block of 600 or more characters, collapsed as a quote is. */
const LONG_PROSE = Option.getOrThrow(
  Array.findFirst(
    Array.flatMap(indexOf(demoTrace).content, (entry) =>
      Array.map(
        Array.filter(
          entry.fields,
          (field) => field.kind === "prose" && String.length(quoteOf(field.text)) >= 600,
        ),
        (field) => ({ section: entry.node.id, text: quoteOf(field.text) }),
      ),
    ),
    ({ section }) => Schema.is(PrdSectionId)(section),
  ),
);

it.effect("a selection over 500 characters disables the passage button, and 500 does not", () =>
  Effect.gen(function* () {
    const tooLong = Array.join(Array.replicate("word", 101), " ");
    assert(String.length(tooLong)).toBe(504);
    const over = yield* viewerScene(selecting(reading, "prd.viewer", tooLong));
    over
      .pipe(readerMounted)
      .expect(passageButton("prd.viewer"))
      .toBeDisabled()
      .expect(passageButton("prd.viewer"))
      .toHaveAttribute("title", "Select at most 500 characters to link to them.");
    const prose = LONG_PROSE.text;
    const from = Option.getOrThrow(
      Array.findFirst(Array.range(0, 60), (start) =>
        Option.exists(
          Option.all({
            first: Array.get(String.split(prose, ""), start),
            last: Array.get(String.split(prose, ""), start + 499),
          }),
          ({ first, last }) => first !== " " && last !== " ",
        ),
      ),
    );
    const atLimit = String.slice(from, from + 500)(prose);
    assert(String.length(atLimit)).toBe(500);
    const within = yield* viewerScene(selecting(reading, LONG_PROSE.section, atLimit));
    within
      .pipe(readerMounted)
      .expect(passageButton(LONG_PROSE.section))
      .toBeDisabled(false)
      .expect(passageButton(LONG_PROSE.section))
      .toHaveAttribute("title", false);
  }),
);

it.effect(
  "a selection the section's prose does not hold, as one in a code block, shows no button",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(
        selecting(reading, "prd.viewer", `${PRD_QUOTE} and then some words nobody wrote`),
      );
      s.pipe(readerMounted).expect(statusLine).toExist().expect(data("copy-passage")).toBeAbsent();
    }),
);

it.effect("a selection that is not a quote a link can hold shows no button", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(selecting(reading, "prd.viewer", ".."));
    s.pipe(readerMounted).expect(statusLine).toExist().expect(data("copy-passage")).toBeAbsent();
  }),
);

const specCard = Option.getOrThrow(
  Array.findFirst(demoTrace.spec.sections, (section) =>
    Option.isSome(
      Option.liftPredicate(section.id, Schema.is(SpecSectionId)).pipe(
        Option.filter(() => Array.isReadonlyArrayNonEmpty(section.keys.implements)),
        Option.flatMap((id) => Option.liftThrowable(() => quoteIn(id))()),
      ),
    ),
  ),
);
const SPEC_QUOTE = quoteIn(specCard.id);
const SPEC_PRD = Option.getOrThrow(Array.head(specCard.keys.implements));

it.effect(
  "on a spec card, Copy link to passage pins what the section implements and copies up to the passage",
  () =>
    Effect.gen(function* () {
      const path = pathOfLink([
        decodeStep({ id: SPEC_PRD, kind: "section" }),
        passageStepOf(specCard.id, SPEC_QUOTE),
      ]);
      const button = inside(data("spec", specCard.id), data("copy-passage", specCard.id));
      const s = yield* viewerScene(
        selecting(linked([{ id: SPEC_PRD, kind: "section" }]), specCard.id, SPEC_QUOTE),
      );
      s.pipe(readerMounted)
        .expect(data("copy-passage"))
        .toHaveCount(1)
        .click(button)
        .pipe(pushedUrl, copying, copied(path))
        .expect(markedPassage("spec-pane"))
        .toHaveText(containing(Option.getOrThrow(Array.head(String.split(SPEC_QUOTE, " ")))));
    }),
);

it("copying a passage keeps the trail and the code view the person has open", () => {
  const trailed = selecting(twoSteps, "prd.viewer", PRD_QUOTE);
  const opened = update(
    trailed,
    Message.ClickedCopyPassageLink({ section: SectionId.make("prd.viewer") }),
  );
  assert(pathOfLink(linkOf(opened.model))).toBe(`${PRD_PATH}${TWO_STEP_PATH}`);
  assert(Array.map(opened.model.detail, (node) => node.id)).toEqual([specId, taskWithSpec.id]);
});

it("the click does nothing for a section the selection is not in", () => {
  const selected = selecting(reading, "prd.viewer", PRD_QUOTE);
  const clicked = update(
    selected,
    Message.ClickedCopyPassageLink({ section: SectionId.make("prd.goal") }),
  );
  assert(clicked.model).toEqual(selected);
  assert(Option.getOrElse(Option.fromNullishOr(clicked.commands), () => [])).toEqual([]);
});

// SELECTED DIFF LINES

/** The task's diff at its head, a file open in it and no lines, its patch received. */
const fileOpen = update(
  linked([
    { id: task.id, kind: "task" },
    { head, kind: "diff" },
    { kind: "file", path: FILE },
  ]),
  Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
).model;

const OTHER_FILE = "packages/contract/src/index.ts";
const OTHER_TO_FILE = `/task/${task.id}/diff/${head}/file/${encodeURIComponent(OTHER_FILE)}`;

it("SelectedDiffLines sets the lines, and the link gains its lines step", () => {
  const before = linkOf(fileOpen);
  assert(Option.exists(Array.last(before), (step) => step.kind === "lines")).toBe(false);
  const selected = update(
    fileOpen,
    Message.SelectedDiffLines({ end: 3, path: FILE, side: "new", start: 1 }),
  ).model;
  assert(Array.drop(linkOf(selected), Array.length(before))).toEqual([
    decodeStep({ end: 3, kind: "lines", side: "new", start: 1 }),
  ]);
  assert(pathOfLink(linkOf(selected))).toBe(`${TO_FILE}/lines/n1-3`);
  // Copy alone picks the lines up with the task, the diff and the file.
  assert(
    Option.map(aloneOf(linkOf(selected), Array.length(linkOf(selected)) - 1), pathOfLink),
  ).toEqual(Option.some(`${TO_FILE}/lines/n1-3`));
  // Selecting again replaces them, and clearing the selection removes them.
  const replaced = update(
    selected,
    Message.SelectedDiffLines({ end: 7, path: FILE, side: "old", start: 7 }),
  ).model;
  assert(pathOfLink(linkOf(replaced))).toBe(`${TO_FILE}/lines/o7`);
  assert(linkOf(update(replaced, Message.ClearedDiffLines()).model)).toEqual(before);
});

it("lines selected in a file nobody opened in the tree open that file and join the link", () => {
  const noFile = update(
    linked([
      { id: task.id, kind: "task" },
      { head, kind: "diff" },
    ]),
    Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
  ).model;
  const selected = update(
    noFile,
    Message.SelectedDiffLines({ end: 3, path: FILE, side: "new", start: 1 }),
  ).model;
  assert(pathOfLink(linkOf(selected))).toBe(`${TO_FILE}/lines/n1-3`);
  // Lines in another file than the open one move the file with them.
  const moved = update(
    fileOpen,
    Message.SelectedDiffLines({ end: 9, path: OTHER_FILE, side: "new", start: 9 }),
  ).model;
  assert(pathOfLink(linkOf(moved))).toBe(`${OTHER_TO_FILE}/lines/n9`);
});

it("lines change nothing with no code view open", () => {
  assert(
    update(loaded, Message.SelectedDiffLines({ end: 3, path: FILE, side: "new", start: 1 })).model,
  ).toEqual(loaded);
  assert(update(loaded, Message.ClearedDiffLines()).model).toEqual(loaded);
});

it("a range that is not lines leaves the file with none", () => {
  const selected = update(
    fileOpen,
    Message.SelectedDiffLines({ end: 3, path: FILE, side: "new", start: 1 }),
  ).model;
  assert(
    linkOf(
      update(selected, Message.SelectedDiffLines({ end: 1, path: FILE, side: "new", start: 3 }))
        .model,
    ),
  ).toEqual(linkOf(fileOpen));
});
