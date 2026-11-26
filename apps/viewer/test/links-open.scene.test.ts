import { LinesStep, PrdSectionId, SpecSectionId, Step } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Order, Result, Schema, String, pipe } from "effect";
import { Mount, all, click, expect, expectAll, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { stackBoxesOf } from "../src/boxes.ts";
import { diffPathOf, rangeOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff, linesFromText, linesTextOf } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { indexOf } from "../src/search.ts";
import { openLink, update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import { loaded, unmeasuredWires } from "./fixtures.ts";

const app = { update, view };
const decodeStep = Schema.decodeUnknownSync(Step);
const decodeLines = Schema.decodeUnknownSync(LinesStep);
const isPrdSection = Schema.is(PrdSectionId);
const isSpecSection = Schema.is(SpecSectionId);

const linked = (steps: ReadonlyArray<unknown>) =>
  openLink(
    loaded,
    Array.map(steps, (step) => decodeStep(step)),
  ).model;

// A PASSAGE, IN THE PRD AND IN A SPEC CARD

/** The first words of a section's first prose block, which is a passage that is still found. */
const passageIn = (isDocument: (id: string) => boolean, needsImplements: boolean) =>
  Option.getOrThrow(
    Array.findFirst(indexOf(demoTrace).content, (entry) =>
      pipe(
        Option.liftPredicate(entry.node.id, isDocument),
        Option.filter(
          (id) =>
            !needsImplements ||
            Array.some(
              demoTrace.spec.sections,
              (section) =>
                section.id === id && Array.isReadonlyArrayNonEmpty(section.keys.implements),
            ),
        ),
        Option.flatMap((section) =>
          pipe(
            Array.findFirst(entry.fields, (field) => field.kind === "prose"),
            Option.map((field) => Array.take(String.split(String.trim(field.text), /\s+/u), 4)),
            Option.filter((words) => Array.length(words) === 4),
            Option.map((words) => ({ section, words })),
          ),
        ),
      ),
    ),
  );

const prdPassage = passageIn(isPrdSection, false);
const specPassage = passageIn(isSpecSection, true);

const passageStep = ({ section, words }: typeof prdPassage) => ({
  kind: "passage",
  quote: Array.join(words, " "),
  section,
});

const readerMounted = Mount.resolveAll(
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

const prdMarks = all.selector("[data-prd-pane] mark[data-link-passage]");
const specMarks = all.selector("[data-spec-pane] mark[data-link-passage]");

it("a PRD passage is underlined in the PRD pane, and nowhere else", () => {
  scene(
    app,
    given(linked([passageStep(prdPassage)])),
    readerMounted,
    expect(selector("[data-prd-pane] mark[data-link-passage]")).toContainText(
      Option.getOrThrow(Array.head(prdPassage.words)),
    ),
    expectAll(specMarks).toBeEmpty(),
  );
});

it("a spec passage is underlined in its open card, and not in the PRD pane", () => {
  scene(
    app,
    given(linked([passageStep(specPassage)])),
    readerMounted,
    expect(selector("[data-spec-pane] mark[data-link-passage]")).toContainText(
      Option.getOrThrow(Array.head(specPassage.words)),
    ),
    expectAll(prdMarks).toBeEmpty(),
  );
});

it("a link with no passage marks no text", () => {
  scene(
    app,
    given(linked([{ id: prdPassage.section, kind: "section" }])),
    readerMounted,
    expect(selector("mark[data-link-passage]")).toBeAbsent(),
  );
});

it("a search mark inside the passage still shows, inside the passage's mark", () => {
  const word = Option.getOrThrow(
    Array.last(Array.sort(prdPassage.words, Order.mapInput(Order.Number, String.length))),
  );
  const searching = update(
    linked([passageStep(prdPassage)]),
    Message.ChangedSearchQuery({ query: word }),
  ).model;
  scene(
    app,
    given(searching),
    readerMounted,
    expect(selector("mark[data-link-passage] mark[data-search-match]")).toExist(),
  );
});

// A FOCUSED STACK AND SEGMENT

const withTrunk = Option.getOrThrow(
  Array.findFirst(stackBoxesOf(demoTrace.tasks, {}), (box) => Option.isSome(box.maybeTrunk)),
);
const { stack: boxStack } = withTrunk;
const trunk = Option.getOrThrow(withTrunk.maybeTrunk);
const linkedBoxes = all.selector("[data-stacks-pane] [data-stack][data-linked]");
const linkedChips = all.selector("[data-stacks-pane] .chip[data-linked]");
const linkedSegments = all.selector("[data-stacks-pane] [data-segment][data-linked]");
const boxSelector = selector(`[data-stacks-pane] [data-stack="${boxStack.number}"]`);
const segmentSelector = selector(`[data-stacks-pane] [data-segment="${trunk.root}"]`);

it("a stack's box is marked linked, and no other box, segment or chip is", () => {
  scene(
    app,
    given(linked([{ kind: "stack", root: boxStack.root }])),
    readerMounted,
    expect(boxSelector).toHaveAttr("data-linked", ""),
    expectAll(linkedBoxes).toHaveCount(1),
    expectAll(linkedSegments).toBeEmpty(),
    expectAll(linkedChips).toBeEmpty(),
  );
});

it("a segment marks its box and the segment while the trunk is folded, and no chip", () => {
  scene(
    app,
    given(linked([{ kind: "segment", root: boxStack.root }])),
    readerMounted,
    expect(segmentSelector).toHaveAttr("aria-expanded", "false"),
    expect(boxSelector).toHaveAttr("data-linked", ""),
    expect(segmentSelector).toHaveAttr("data-linked", ""),
    expectAll(linkedBoxes).toHaveCount(1),
    expectAll(linkedSegments).toHaveCount(1),
    expectAll(linkedChips).toBeEmpty(),
  );
});

it("a segment marks its box and the chips of its trunk once it is unfolded, not the segment", () => {
  scene(
    app,
    given(linked([{ kind: "segment", root: boxStack.root }])),
    readerMounted,
    click(segmentSelector),
    expect(segmentSelector).toHaveAttr("aria-expanded", "true"),
    expect(boxSelector).toHaveAttr("data-linked", ""),
    expectAll(linkedBoxes).toHaveCount(1),
    expectAll(linkedSegments).toBeEmpty(),
    expectAll(linkedChips).toHaveCount(Array.length(trunk.tasks)),
  );
});

it("a link with no focus marks no box", () => {
  scene(
    app,
    given(linked([{ id: prdPassage.section, kind: "section" }])),
    readerMounted,
    expect(selector("[data-stacks-pane] [data-linked]")).toBeAbsent(),
  );
});

// THE LINES OF A DIFF

const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Option.isSome(rangeOf(candidate))),
);
const { base, head } = Option.getOrThrow(rangeOf(task));
const FILE = "packages/contract/src/events.ts";

/** The diff of a task at its head, with its patch received, as a link opened in a new window ends. */
const diffOf = (steps: ReadonlyArray<unknown>) =>
  update(
    linked(
      Array.appendAll(
        [
          { id: task.id, kind: "task" },
          { head, kind: "diff" },
        ],
        steps,
      ),
    ),
    Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
  ).model;

const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

it("the diff mount holds the lines a link selected, as the link writes them", () => {
  scene(
    app,
    given(
      diffOf([
        { kind: "file", path: FILE },
        { end: 3, kind: "lines", side: "new", start: 1 },
      ]),
    ),
    drawn,
    expect(selector("[data-patch-path]")).toHaveAttr("data-lines", "n1-3"),
    expect(selector("[data-patch-path]")).toHaveAttr("data-file", FILE),
  );
});

it("a line on the old side is written with its side", () => {
  scene(
    app,
    given(
      modifyFields(diffOf([{ kind: "file", path: FILE }]), {
        screen: (screen) =>
          Screen.guards.Code(screen)
            ? modifyFields(screen, {
                maybeLines: () =>
                  Option.some(decodeLines({ end: 2, kind: "lines", side: "old", start: 2 })),
              })
            : screen,
      }),
    ),
    drawn,
    expect(selector("[data-patch-path]")).toHaveAttr("data-lines", "o2"),
  );
});

it("a diff opened with no lines has no lines attribute", () => {
  scene(
    app,
    given(diffOf([{ kind: "file", path: FILE }])),
    drawn,
    expect(selector("[data-lines]")).toBeAbsent(),
  );
});

it.prop(
  "the lines attribute reads back as the lines it was written from",
  { lines: LinesStep },
  ({ lines }) => {
    assert(linesFromText(linesTextOf(lines))).toEqual(Option.some(lines));
  },
);

it("an attribute that is not lines reads as none", () => {
  assert(linesFromText("x4")).toEqual(Option.none());
  assert(linesFromText("n")).toEqual(Option.none());
  assert(linesFromText("n0")).toEqual(Option.none());
  assert(linesFromText("n5-2")).toEqual(Option.none());
});
