import { LinesStep, PrdSectionId, SpecSectionId, Step } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Order, Result, Schema, String, pipe } from "effect";
import { modifyFields } from "foldkit/struct";

import { stackBoxesOf } from "../src/boxes.ts";
import { diffPathOf, rangeOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff, linesFromText, linesTextOf } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { indexOf } from "../src/search.ts";
import { openLink, update } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import {
  both,
  containing,
  data,
  inside,
  loaded,
  readerMounted,
  tag,
  viewerScene,
  withClass,
  type ViewerSteps,
} from "./fixtures.ts";
import { viewerBridge } from "../src/app.ts";
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

const passageMark = both(tag("mark"), data("link-passage"));
const prdMarks = inside(data("prd-pane"), passageMark);
const specMarks = inside(data("spec-pane"), passageMark);

it.effect("a PRD passage is underlined in the PRD pane, and nowhere else", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([passageStep(prdPassage)]));
    s.pipe(readerMounted)
      .expect(prdMarks)
      .toHaveText(containing(Option.getOrThrow(Array.head(prdPassage.words))))
      .expect(specMarks)
      .toHaveCount(0);
  }),
);

it.effect("a spec passage is underlined in its open card, and not in the PRD pane", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([passageStep(specPassage)]));
    s.pipe(readerMounted)
      .expect(specMarks)
      .toHaveText(containing(Option.getOrThrow(Array.head(specPassage.words))))
      .expect(prdMarks)
      .toHaveCount(0);
  }),
);

it.effect("a link with no passage marks no text", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([{ id: prdPassage.section, kind: "section" }]));
    s.pipe(readerMounted).expect(passageMark).toBeAbsent();
  }),
);

it.effect("a search mark inside the passage still shows, inside the passage's mark", () =>
  Effect.gen(function* () {
    const word = Option.getOrThrow(
      Array.last(Array.sort(prdPassage.words, Order.mapInput(Order.Number, String.length))),
    );
    const searching = update(
      linked([passageStep(prdPassage)]),
      Message.ChangedSearchQuery({ query: word }),
    ).model;
    const s = yield* viewerScene(searching);
    s.pipe(readerMounted)
      .expect(inside(passageMark, data("search-match")))
      .toExist();
  }),
);

// A FOCUSED STACK AND SEGMENT

const withTrunk = Option.getOrThrow(
  Array.findFirst(stackBoxesOf(demoTrace.tasks, {}), (box) => Option.isSome(box.maybeTrunk)),
);
const { stack: boxStack } = withTrunk;
const trunk = Option.getOrThrow(withTrunk.maybeTrunk);
const stacksPane = data("stacks-pane");
const linkedBoxes = inside(stacksPane, both(data("stack"), data("linked")));
const linkedChips = inside(stacksPane, both(withClass("chip"), data("linked")));
const linkedSegments = inside(stacksPane, both(data("segment"), data("linked")));
const boxSelector = inside(stacksPane, data("stack", `${boxStack.number}`));
const segmentSelector = inside(stacksPane, data("segment", trunk.root));

it.effect("a stack's box is marked linked, and no other box, segment or chip is", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([{ kind: "stack", root: boxStack.root }]));
    s.pipe(readerMounted)
      .expect(boxSelector)
      .toHaveAttribute("data-linked", "")
      .expect(linkedBoxes)
      .toHaveCount(1)
      .expect(linkedSegments)
      .toHaveCount(0)
      .expect(linkedChips)
      .toHaveCount(0);
  }),
);

it.effect("a segment marks its box and the segment while the trunk is folded, and no chip", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([{ kind: "segment", root: boxStack.root }]));
    s.pipe(readerMounted)
      .expect(segmentSelector)
      .toHaveAttribute("aria-expanded", "false")
      .expect(boxSelector)
      .toHaveAttribute("data-linked", "")
      .expect(segmentSelector)
      .toHaveAttribute("data-linked", "")
      .expect(linkedBoxes)
      .toHaveCount(1)
      .expect(linkedSegments)
      .toHaveCount(1)
      .expect(linkedChips)
      .toHaveCount(0);
  }),
);

it.effect(
  "a segment marks its box and the chips of its trunk once it is unfolded, not the segment",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(linked([{ kind: "segment", root: boxStack.root }]));
      s.pipe(readerMounted)
        .click(segmentSelector)
        .expect(segmentSelector)
        .toHaveAttribute("aria-expanded", "true")
        .expect(boxSelector)
        .toHaveAttribute("data-linked", "")
        .expect(linkedBoxes)
        .toHaveCount(1)
        .expect(linkedSegments)
        .toHaveCount(0)
        .expect(linkedChips)
        .toHaveCount(Array.length(trunk.tasks));
    }),
);

it.effect("a link with no focus marks no box", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(linked([{ id: prdPassage.section, kind: "section" }]));
    s.pipe(readerMounted)
      .expect(inside(stacksPane, data("linked")))
      .toBeAbsent();
  }),
);

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

/** The diff mount answering, as the page's diff renderer does. */
const drawn = (s: ViewerSteps) =>
  s.mounted(viewerBridge.mountOf(RenderDiff), Message.CompletedRenderDiff());

it.effect("the diff mount holds the lines a link selected, as the link writes them", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      diffOf([
        { kind: "file", path: FILE },
        { end: 3, kind: "lines", side: "new", start: 1 },
      ]),
    );
    s.pipe(drawn)
      .expect(data("patch-path"))
      .toHaveAttribute("data-lines", "n1-3")
      .expect(data("patch-path"))
      .toHaveAttribute("data-file", FILE);
  }),
);

it.effect("a line on the old side is written with its side", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      modifyFields(diffOf([{ kind: "file", path: FILE }]), {
        screen: (screen) =>
          Screen.guards.Code(screen)
            ? modifyFields(screen, {
                maybeLines: () =>
                  Option.some(decodeLines({ end: 2, kind: "lines", side: "old", start: 2 })),
              })
            : screen,
      }),
    );
    s.pipe(drawn).expect(data("patch-path")).toHaveAttribute("data-lines", "o2");
  }),
);

it.effect("a diff opened with no lines has no lines attribute", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(diffOf([{ kind: "file", path: FILE }]));
    s.pipe(drawn).expect(data("lines")).toBeAbsent();
  }),
);

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
