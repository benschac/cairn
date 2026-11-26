import { Link, PrdSectionId, Quote, Step, type Trace } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Result, Schema, String, Struct, pipe } from "effect";

import { commitPathOf, diffPathOf, rangeOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import {
  isStopping,
  Needs,
  passageOf,
  resolveLink,
  trunkOf,
  type BlockRange,
  type Loaded,
  type MissReason,
  type Resolution,
} from "../src/links.ts";
import { PatchData } from "../src/model.ts";
import { indexOf } from "../src/search.ts";
import commitPatch from "./fixtures/commit.patch?raw";

const decodeStep = Schema.decodeUnknownSync(Step);
const isLink = Schema.is(Link);
const quoteOf = Schema.decodeSync(Quote);

/** The files of `git show --patch 5289657`, the fixture every loaded patch here holds. */
const PATCH_FILES = [
  "packages/contract/src/events.ts",
  "packages/contract/src/index.ts",
  "packages/contract/test/events.test.ts",
] as const;

// DEMO DATA

const commits = Array.flatMap(demoTrace.tasks, (task) => task.commits);
const sections = Array.appendAll(demoTrace.prd.sections, demoTrace.spec.sections);
const roots = Array.map(stacksOf(demoTrace.tasks), (stack) => stack.root);
const sessions = Array.dedupe(
  Array.flatMap(commits, (commit) => Array.fromNullishOr(commit.session)),
);

/** Every route a diff or a commit step over the demo can read. */
const patchPaths = Array.flatMap(demoTrace.tasks, (task) =>
  Array.flatMap(task.commits, (commit) =>
    Array.append(
      Array.fromOption(Option.map(rangeOf(task), ({ base }) => diffPathOf(base, commit.sha))),
      commitPathOf(commit.sha),
    ),
  ),
);

const pick = <A>(items: ReadonlyArray<A>, at: number): Option.Option<A> =>
  Array.isReadonlyArrayNonEmpty(items) ? Array.get(items, at % Array.length(items)) : Option.none();

const proseOf = (trace: Trace, section: string) =>
  pipe(
    Array.findFirst(indexOf(trace).content, (entry) => entry.node.id === section),
    Option.match({
      onNone: () => [],
      onSome: (entry) => Array.filter(entry.fields, (field) => field.kind === "prose"),
    }),
  );

/** The first words of a section's first prose block, when it has one. */
const quoteIn = (section: string): Option.Option<string> =>
  pipe(
    Array.head(proseOf(demoTrace, section)),
    Option.map((field) =>
      Array.join(Array.take(String.split(String.trim(field.text), /\s+/u), 4), " "),
    ),
    Option.filter(String.isNonEmpty),
  );

// GENERATED LINKS AND DATA

const Pick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000));

/**
 * One step to add: `kind` picks among the kinds that may follow the steps so far, `real` above 0
 * takes its ids from the demo (else they name nothing), and `which` picks which.
 */
const Choice = Schema.Struct({
  kind: Pick,
  real: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  which: Pick,
});
type Choice = typeof Choice.Type;

/** Up to six steps: the link is as long as `length` and the ordering rules let it be. */
const Choices = Schema.Struct({
  choices: Schema.Tuple([Choice, Choice, Choice, Choice, Choice, Choice]),
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(6)),
});
type Choices = typeof Choices.Type;

/**
 * What the model has received: every patch route in one state, and every session in one. The
 * demo is one case in four and a loaded patch half of the patch states, so files and lines open.
 */
const Received = Schema.Struct({
  demo: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  patch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5)),
  session: Schema.Literals(["absent", "failed"]),
});
type Received = typeof Received.Type;

const fakeSha = (which: number) => `${String.repeat(39)("e")}${(which % 16).toString(16)}`;

/** The fields of the step of each kind a choice makes, given the task right before it. */
const fieldsOf = (
  choice: Choice,
  maybeTask: Option.Option<(typeof demoTrace.tasks)[number]>,
): Record.ReadonlyRecord<Step["kind"], unknown> => {
  const { which } = choice;
  const orFake = <A>(maybe: Option.Option<A>, fake: A): A =>
    choice.real > 0 ? Option.getOrElse(maybe, () => fake) : fake;
  const section = orFake(
    Option.map(pick(sections, which), ({ id }) => id),
    `prd.gone-${which}`,
  );
  const root = orFake(pick(roots, which), `zz${which}`);
  const start = choice.real > 0 ? 1 + (which % 40) : 5000 + which;
  return {
    commit: {
      kind: "commit",
      sha: orFake(
        Option.map(pick(commits, which), ({ sha }) => sha),
        fakeSha(which),
      ),
    },
    diff: {
      head: orFake(
        Option.flatMap(maybeTask, (task) =>
          Option.map(pick(task.commits, which), ({ sha }) => sha),
        ),
        fakeSha(which),
      ),
      kind: "diff",
    },
    file: { kind: "file", path: orFake(pick(PATCH_FILES, which), `missing/${which}.ts`) },
    lines: {
      end: start + (which % 4),
      kind: "lines",
      side: which % 3 === 0 ? "old" : "new",
      start,
    },
    note: { id: `n_abcdef${which}`, kind: "note" },
    // A real section with `real` at 1 quotes words it does not hold: a passage that changed.
    passage: {
      kind: "passage",
      quote:
        choice.real > 1
          ? orFake(quoteIn(section), `no such words ${which}`)
          : `no such words ${which}`,
      section,
    },
    section: { id: section, kind: "section" },
    segment: { kind: "segment", root },
    stack: { kind: "stack", root },
    task: {
      id: orFake(
        Option.map(pick(demoTrace.tasks, which), ({ id }) => id),
        `zz${which}`,
      ),
      kind: "task",
    },
    turn: {
      kind: "turn",
      session: orFake<string>(pick(sessions, which), "s_nosuchsession"),
      turn: `turn-${which}`,
    },
  };
};

/** The step that goes deeper into code after each kind, which the generator picks more often. */
const DEEPER: Partial<Record<Step["kind"], Step["kind"]>> = {
  commit: "file",
  diff: "file",
  file: "lines",
  task: "diff",
};

/**
 * A well-ordered link built from the choices, each step taken from the kinds that may come next.
 * The step that goes deeper into code counts ten times, so diffs, files and lines are common.
 */
const linkOf = ({ choices, length }: Choices): Link =>
  Array.reduce(Array.take(choices, length), Array.empty<Step>(), (steps, choice) => {
    const maybeTask = pipe(
      Array.last(steps),
      Option.filter(Step.guards.task),
      Option.flatMap((step) => Array.findFirst(demoTrace.tasks, (task) => task.id === step.id)),
    );
    const fields = fieldsOf(choice, maybeTask);
    const deeper = pipe(
      Array.last(steps),
      Option.flatMap((step) => Option.fromUndefinedOr(DEEPER[step.kind])),
      Option.match({ onNone: () => [], onSome: (kind) => Array.replicate(kind, 9) }),
    );
    const next = Array.filter(
      Array.map(Array.appendAll(Step.discriminants, deeper), (kind) =>
        Array.append(steps, decodeStep(fields[kind])),
      ),
      isLink,
    );
    return Option.getOrElse(pick(next, choice.kind), () => steps);
  });

/** The states `Received.patch` picks from: not asked for, loading, failed, and loaded thrice. */
const PATCH_STATES: ReadonlyArray<Option.Option<PatchData>> = Array.appendAll(
  [
    Option.none(),
    Option.some(PatchData.Loading()),
    Option.some(PatchData.Failed({ message: "HTTP 500" })),
  ],
  Array.replicate(Option.some(PatchData.Loaded({ text: commitPatch })), 3),
);

const loadedOf = (received: Received): Loaded => ({
  isDemo: received.demo === 0,
  patches: Option.match(Option.flatten(Array.get(PATCH_STATES, received.patch)), {
    onNone: () => ({}),
    onSome: (state) => Record.fromIterableWith(patchPaths, (path) => [path, state]),
  }),
  sessions:
    received.session === "absent"
      ? {}
      : Record.fromIterableWith(sessions, (id) => [id, Result.fail("HTTP 404")]),
});

const NOTHING_LOADED: Loaded = { isDemo: false, patches: {}, sessions: {} };

/** The index of the miss that stopped resolution, or where it is waiting, or the link's end. */
const stopOf = (link: Link, resolution: Resolution): number =>
  pipe(
    Option.firstSomeOf([
      Option.map(Array.findFirst(resolution.missing, isStopping), (miss) => miss.index),
      resolution.waiting,
    ]),
    Option.getOrElse(() => Array.length(link)),
  );

const DATA_REASONS: ReadonlyArray<MissReason> = [
  "patch-unavailable",
  "file-not-in-diff",
  "lines-not-in-diff",
  "turn-missing",
];

it.prop(
  "the resolved steps are the link's steps up to the first stopping miss, a changed passage as its section",
  [Choices, Received],
  ([choices, received]) => {
    const link = linkOf(choices);
    const resolution = resolveLink(demoTrace, link, loadedOf(received));
    const changed = Array.map(
      Array.filter(resolution.missing, (miss) => miss.reason === "passage-changed"),
      (miss) => miss.index,
    );
    const expected = Array.map(Array.take(link, stopOf(link, resolution)), (step, index) =>
      step.kind === "passage" && Array.contains(changed, index)
        ? { id: step.section, kind: "section" }
        : step,
    );
    expect(Array.map(resolution.resolved, ({ step }) => step)).toEqual(expected);
    expect(Array.map(resolution.resolved, ({ index }) => index)).toEqual(
      Array.map(expected, (_, index) => index),
    );
  },
);

it.prop(
  "no step after a stopping miss resolves, and it is the only one and the last",
  [Choices, Received],
  ([choices, received]) => {
    const link = linkOf(choices);
    const resolution = resolveLink(demoTrace, link, loadedOf(received));
    const stopping = Array.filter(resolution.missing, isStopping);
    expect(Array.length(stopping)).toBeLessThanOrEqual(1);
    Array.forEach(stopping, (miss) => {
      expect(Array.every(resolution.resolved, ({ index }) => index < miss.index)).toBe(true);
      expect(Array.last(resolution.missing)).toEqual(Option.some(miss));
      expect(Option.isNone(resolution.waiting)).toBe(true);
    });
  },
);

it.prop(
  "waiting comes before any data-dependent miss",
  [Choices, Received],
  ([choices, received]) => {
    const link = linkOf(choices);
    Array.forEach([loadedOf(received), NOTHING_LOADED], (loaded) => {
      const resolution = resolveLink(demoTrace, link, loaded);
      Option.match(resolution.waiting, {
        onNone: () => undefined,
        onSome: (waiting) => {
          expect(
            Array.every(resolution.missing, (miss) => miss.index < waiting && !isStopping(miss)),
          ).toBe(true);
          expect(Array.length(resolution.resolved)).toBe(waiting);
        },
      });
    });
    // With nothing received yet, a step that reads a patch or a session waits instead of missing.
    const unloaded = resolveLink(demoTrace, link, NOTHING_LOADED);
    expect(Array.some(unloaded.missing, (miss) => Array.contains(DATA_REASONS, miss.reason))).toBe(
      false,
    );
  },
);

// EXAMPLES

const SECTION = "prd.deep-links.missing";
const QUOTE = quoteOf("It never opens a blank window. A passage that no longer");

const sectionStep = (id: string) => decodeStep({ id, kind: "section" });
const passageStep = (quote: string) => decodeStep({ kind: "passage", quote, section: SECTION });
const taskStep = (id: string) => decodeStep({ id, kind: "task" });

/** The text each range marks, read from its block in the trace's prose index. */
const markedTexts = (trace: Trace, marks: ReadonlyArray<BlockRange>) =>
  Array.map(marks, ({ offset, range }) =>
    pipe(
      Array.findFirst(proseOf(trace, SECTION), (field) =>
        Option.contains(field.maybeOffset, offset),
      ),
      Option.map((field) => String.slice(range.start, range.end)(field.text)),
    ),
  );

const withPrd = (markdown: (text: string) => string): Trace =>
  Struct.evolve(demoTrace, { prd: (prd) => Struct.evolve(prd, { markdown }) });

const heading = "### Links that no longer resolve {#prd.deep-links.missing}";

/** The demo's PRD with a paragraph added to the section before this one. */
const added = withPrd(
  String.replace(heading, `A paragraph added to another section.\n\n${heading}`),
);

it("a passage is found on the same text after a paragraph is added to another section", () => {
  // The search index keeps one trace, so everything read from the demo is read before the edited
  // trace's index is built, instead of rebuilding each in turn.
  const before = Option.getOrThrow(
    passageOf(indexOf(demoTrace), PrdSectionId.make(SECTION), QUOTE),
  );
  const marked = markedTexts(demoTrace, before);
  const after = Option.getOrThrow(passageOf(indexOf(added), PrdSectionId.make(SECTION), QUOTE));
  // The passage covers the end of one block and the start of the next.
  expect(Array.length(before)).toBe(2);
  expect(marked).toEqual([
    Option.some("It never opens a blank window."),
    Option.some("A passage that no longer"),
  ]);
  expect(markedTexts(added, after)).toEqual(marked);
  expect(Array.map(after, ({ offset }) => offset)).not.toEqual(
    Array.map(before, ({ offset }) => offset),
  );
  const resolution = resolveLink(added, [passageStep(QUOTE)], NOTHING_LOADED);
  expect(resolution.missing).toEqual([]);
  expect(Array.map(resolution.resolved, ({ needs }) => Needs.guards.Passage(needs))).toEqual([
    true,
  ]);
});

it("a word changed inside a passage gives passage-changed, and the next steps still resolve", () => {
  const edited = withPrd(String.replace("opens a blank window", "opens an empty window"));
  const link = [passageStep(QUOTE), taskStep("t1")];
  const resolution = resolveLink(edited, link, NOTHING_LOADED);
  expect(Array.map(resolution.missing, ({ index, reason }) => ({ index, reason }))).toEqual([
    { index: 0, reason: "passage-changed" },
  ]);
  expect(Array.map(resolution.resolved, ({ step }) => step)).toEqual([
    sectionStep(SECTION),
    taskStep("t1"),
  ]);
  expect(Array.map(resolution.missing, ({ message }) => message)).toEqual([
    `The passage changed: "${QUOTE}" is no longer in Links that no longer resolve.`,
  ]);
});

const reasonsOf = (trace: Trace, link: ReadonlyArray<Step>, loaded: Loaded = NOTHING_LOADED) =>
  Array.map(resolveLink(trace, link, loaded).missing, ({ index, reason }) => ({ index, reason }));

it("a trace with a section removed gives section-missing at that step", () => {
  const removed = Struct.evolve(demoTrace, {
    prd: (prd) =>
      Struct.evolve(prd, { sections: Array.filter((section) => section.id !== SECTION) }),
  });
  expect(reasonsOf(removed, [taskStep("t1"), sectionStep(SECTION)])).toEqual([
    { index: 1, reason: "section-missing" },
  ]);
  expect(reasonsOf(removed, [passageStep(QUOTE)])).toEqual([
    { index: 0, reason: "section-missing" },
  ]);
  expect(reasonsOf(demoTrace, [taskStep("t1"), sectionStep(SECTION)])).toEqual([]);
});

/** A task with two commits, and a commit of another task. */
const twoCommits = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (task) => Array.length(task.commits) >= 2),
);
const older = Option.getOrThrow(Array.head(twoCommits.commits));
const elsewhere = Option.getOrThrow(
  Array.findFirst(
    commits,
    (commit) => !Array.some(twoCommits.commits, ({ sha }) => sha === commit.sha),
  ),
);
const diffStep = (head: string) => decodeStep({ head, kind: "diff" });
const fileStep = (path: string) => decodeStep({ kind: "file", path });
const linesStep = (side: "new" | "old", start: number, end: number) =>
  decodeStep({ end, kind: "lines", side, start });

/** The patch fixture at the route of the task's diff as it stood at its older commit. */
const atOlder: Loaded = {
  isDemo: false,
  patches: Record.fromEntries([
    [
      diffPathOf(Option.getOrThrow(rangeOf(twoCommits)).base, older.sha),
      PatchData.Loaded({ text: commitPatch }),
    ],
  ]),
  sessions: {},
};

const toLines = (lines: ReadonlyArray<Step>) =>
  Array.appendAll(
    [taskStep(twoCommits.id), diffStep(older.sha), fileStep("packages/contract/src/index.ts")],
    lines,
  );

it("a diff head that is not on the task gives commit-not-on-task", () => {
  expect(reasonsOf(demoTrace, [taskStep(twoCommits.id), diffStep(elsewhere.sha)])).toEqual([
    { index: 1, reason: "commit-not-on-task" },
  ]);
  const resolved = resolveLink(
    demoTrace,
    [taskStep(twoCommits.id), diffStep(older.sha)],
    NOTHING_LOADED,
  );
  expect(resolved.missing).toEqual([]);
  expect(Array.map(resolved.resolved, ({ needs }) => needs)).toEqual([
    { _tag: "Nothing" },
    { _tag: "Patch", path: diffPathOf(Option.getOrThrow(rangeOf(twoCommits)).base, older.sha) },
  ]);
});

it("a loaded patch without the file gives file-not-in-diff, and one with it opens the file", () => {
  const link = [taskStep(twoCommits.id), diffStep(older.sha), fileStep("packages/cli/src/api.ts")];
  expect(reasonsOf(demoTrace, link, atOlder)).toEqual([{ index: 2, reason: "file-not-in-diff" }]);
  // Before the patch arrives the file step waits.
  expect(resolveLink(demoTrace, link, NOTHING_LOADED).waiting).toEqual(Option.some(2));
  expect(reasonsOf(demoTrace, toLines([]), atOlder)).toEqual([]);
});

it("lines outside every hunk give lines-not-in-diff, and lines inside one open", () => {
  // The fixture's hunk for index.ts is @@ -55,3 +55,5 @@: new lines 55 to 59, old 55 to 57.
  expect(reasonsOf(demoTrace, toLines([linesStep("new", 40, 56)]), atOlder)).toEqual([
    { index: 3, reason: "lines-not-in-diff" },
  ]);
  expect(reasonsOf(demoTrace, toLines([linesStep("old", 57, 58)]), atOlder)).toEqual([
    { index: 3, reason: "lines-not-in-diff" },
  ]);
  expect(reasonsOf(demoTrace, toLines([linesStep("new", 55, 59)]), atOlder)).toEqual([]);
  expect(reasonsOf(demoTrace, toLines([linesStep("old", 55, 57)]), atOlder)).toEqual([]);
});

it("a turn in the demo gives sessions-unavailable", () => {
  const session = Option.getOrThrow(Array.head(sessions));
  const turn = decodeStep({ kind: "turn", session, turn: "t-1" });
  expect(reasonsOf(demoTrace, [turn], { isDemo: true, patches: {}, sessions: {} })).toEqual([
    { index: 0, reason: "sessions-unavailable" },
  ]);
  expect(resolveLink(demoTrace, [turn], NOTHING_LOADED).waiting).toEqual(Option.some(0));
});

const segmentOf = (root: string) => decodeStep({ kind: "segment", root });

it("a segment opens only on a finished trunk of two or more tasks", () => {
  const stacks = stacksOf(demoTrace.tasks);
  Array.forEach(stacks, (stack) => {
    const trunk = trunkOf(stack, demoTrace.tasks);
    expect(Array.every(trunk, (task) => task.status === "done" || task.status === "landed")).toBe(
      true,
    );
    expect(reasonsOf(demoTrace, [segmentOf(stack.root)])).toEqual(
      Array.length(trunk) >= 2 ? [] : [{ index: 0, reason: "segment-missing" }],
    );
  });
  expect(Array.some(stacks, (stack) => Array.length(trunkOf(stack, demoTrace.tasks)) >= 2)).toBe(
    true,
  );
});
