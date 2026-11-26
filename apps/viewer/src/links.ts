import { UiSchema, UiStruct } from "@effect/ui";
import {
  PassageStep,
  PrdSectionId,
  SpecSectionId,
  Step,
  encodeLink,
  type SectionId,
  type Link,
  type LinkError,
  type Quote,
  type Session,
  type Trace,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import { stacksOf, type Stack } from "@cairn/core/stacks";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  Array,
  Data,
  Match,
  Number,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  pipe,
} from "effect";

import {
  commitOf,
  commitPathOf,
  diffPathOf,
  ownerOf,
  rangeOf,
  shortSha,
  shownCommitOf,
  taskOf,
} from "./codeView.ts";
import { describePatchNotParsed, parsePatch } from "./diff.ts";
import { isDemoBuild } from "./load.ts";
import {
  HighlightedTurn,
  Screen,
  SessionData,
  Shown,
  loadedTraceOf,
  type CodeScreen,
  type Model,
  type PassageSelection,
  type PatchData,
} from "./model.ts";
import { Range } from "./range.ts";
import { stackTaskSelectorOf, type ScrollTarget } from "./reader.ts";
import { indexOf, type SearchIndex } from "./search.ts";
import { Node } from "./trace.ts";
import { turnElementIdOf } from "./view/sessionView.ts";

// RESOLUTION

/** A range in one prose block's visible text. The block is named by its offset in the markdown. */
export const BlockRange = Schema.Struct({ offset: Schema.Int, range: Range });
export type BlockRange = typeof BlockRange.Type;

/** What a step that opens needs to be shown: nothing more, a passage's marks, or a patch's route. */
export const Needs = UiSchema.TaggedEnum({
  Nothing: {},
  Passage: { marks: Schema.Array(BlockRange) },
  Patch: { path: Schema.String },
});
export type Needs = typeof Needs.Type;

/** A step that opens, at its index in the link. A passage that changed opens as its section. */
export const OpenedStep = Schema.Struct({ index: Schema.Int, needs: Needs, step: Step });
export type OpenedStep = typeof OpenedStep.Type;

/** Why a step did not resolve. Only `passage-changed` lets the steps after it resolve. */
export const MissReason = Schema.Literals([
  "section-missing",
  "passage-changed",
  "task-missing",
  "stack-missing",
  "segment-missing",
  "commit-not-on-task",
  "commit-missing",
  "patch-unavailable",
  "file-not-in-diff",
  "lines-not-in-diff",
  "session-missing",
  "sessions-unavailable",
  "turn-missing",
  "notes-unavailable",
]);
export type MissReason = typeof MissReason.Type;

/** A step that did not resolve, why, and the sentence the notice shows for it. */
export const Miss = Schema.Struct({
  index: Schema.Int,
  message: Schema.String,
  reason: MissReason,
  step: Step,
});
export type Miss = typeof Miss.Type;

/**
 * How far a link resolves: the steps that open, the first step still waiting for its data, and
 * what did not resolve. At most one miss stops resolution, and it is the last; a passage that
 * changed does not stop it.
 */
export const Resolution = Schema.Struct({
  missing: Schema.Array(Miss),
  resolved: Schema.Array(OpenedStep),
  waiting: Schema.Option(Schema.Int),
});
export type Resolution = typeof Resolution.Type;

/**
 * The data the model has received that steps read. A patch or session still on its way is absent
 * or loading. The demo has no server, so it fetches neither.
 */
export interface Loaded {
  readonly isDemo: boolean;
  /** The patches by route path, as the model holds them. */
  readonly patches: Record.ReadonlyRecord<string, PatchData>;
  /** Each session that arrived, or why it could not be fetched, by session ID. */
  readonly sessions: Record.ReadonlyRecord<string, Result.Result<Session, string>>;
}

/** Whether a miss lets the steps after it resolve. */
export const isStopping = (miss: Miss): boolean => miss.reason !== "passage-changed";

// FINISHED TRUNKS

const FINISHED: ReadonlyArray<TraceTask["status"]> = ["done", "landed"];

/** What the finished trunk reads of a task. A `TraceTask` fits. */
type TrunkTask = Pick<TraceTask, "id" | "parent" | "status">;

const isFinished = (task: TrunkTask): boolean => Array.contains(FINISHED, task.status);

/**
 * The finished trunk of a stack: from its root, the run of `done` or `landed` tasks up to the
 * first fork or the first unfinished task. The task at a fork is the trunk's last. A root that is
 * not finished has no trunk.
 */
export const trunkOf = <Task extends TrunkTask>(
  stack: Stack,
  tasks: ReadonlyArray<Task>,
): ReadonlyArray<Task> => {
  const members = Array.filter(tasks, (task) => Record.has(stack.cells, task.id));
  // The root's own parent may close a cycle, so it is never a child.
  const childrenOf = (task: Task) =>
    Array.filter(members, (child) => child.parent === task.id && child.id !== stack.root);
  const runFrom = (task: Task): ReadonlyArray<Task> =>
    isFinished(task)
      ? Array.prepend(
          Array.match(childrenOf(task), {
            onEmpty: () => [],
            onNonEmpty: ([only, ...others]) =>
              Array.isReadonlyArrayEmpty(others) ? runFrom(only) : [],
          }),
          task,
        )
      : [];
  return Option.match(
    Array.findFirst(members, (task) => task.id === stack.root),
    { onNone: () => [], onSome: runFrom },
  );
};

// PASSAGES

/** A word of a block's visible text, where it sits there, and where it starts in the joined text. */
interface Word {
  readonly end: number;
  readonly joinedStart: number;
  readonly offset: number;
  readonly start: number;
  readonly text: string;
}

const WORD = /\S+/gu;

/** A block's words with their place in its visible text. */
const wordsOf = (offset: number, text: string) =>
  Array.map(Array.fromIterable(String.matchAll(WORD)(text)), (match) => {
    const start = Option.getOrElse(Option.fromUndefinedOr(match.index), () => 0);
    const word = Option.getOrElse(Array.head(match), () => "");
    return { end: start + String.length(word), offset, start, text: word };
  });

/**
 * Finds a passage in the prose blocks its section owns, as the prose index holds them. The
 * blocks' visible texts are joined with one space and every whitespace run is one space; the first
 * exact, case-sensitive match counts. It is mapped back to a range in each block it covers, in
 * order. None when the section has no such text.
 */
export const passageOf = (
  index: SearchIndex,
  section: (typeof PassageStep.Type)["section"],
  quote: Quote,
): Option.Option<ReadonlyArray<BlockRange>> => {
  // A section's ID is the same text whichever document's brand it carries.
  const id: string = section;
  const blocks = pipe(
    Array.findFirst(
      index.content,
      (entry) => entry.node.kind === "section" && entry.node.id === id,
    ),
    Option.match({
      onNone: () => [],
      onSome: (entry) =>
        Array.getSomes(
          Array.map(entry.fields, (field) =>
            Option.filter(
              Option.map(field.maybeOffset, (offset) => ({ offset, text: field.text })),
              () => field.kind === "prose",
            ),
          ),
        ),
    }),
  );
  const [, words] = Array.mapAccum(
    Array.flatMap(blocks, ({ offset, text }) => wordsOf(offset, text)),
    0,
    (joinedStart, word): readonly [number, Word] => [
      joinedStart + String.length(word.text) + 1,
      { end: word.end, joinedStart, offset: word.offset, start: word.start, text: word.text },
    ],
  );
  const joined = Array.join(
    Array.map(words, (word) => word.text),
    " ",
  );
  return Option.map(String.indexOf(quote)(joined), (from) => {
    const to = from + String.length(quote);
    const covered = Array.filterMap(words, (word) => {
      const wordEnd = word.joinedStart + String.length(word.text);
      return word.joinedStart < to && wordEnd > from
        ? Result.succeed({
            end: word.start + Number.min(to, wordEnd) - word.joinedStart,
            offset: word.offset,
            start: word.start + Number.max(0, from - word.joinedStart),
          })
        : Result.failVoid;
    });
    return Array.match(covered, {
      onEmpty: () => [],
      onNonEmpty: (pieces) =>
        Array.map(
          Array.groupWith(pieces, (self, that) => self.offset === that.offset),
          (group) => ({
            offset: Array.headNonEmpty(group).offset,
            range: { end: Array.lastNonEmpty(group).end, start: Array.headNonEmpty(group).start },
          }),
        ),
    });
  });
};

// CHECKING EACH STEP

/** What a step leaves for the one after it, which the ordering rules make the only reader. */
interface Carry {
  /** The file a `file` step found, for its `lines`. */
  readonly maybeFile: Option.Option<FileDiffMetadata>;
  /** The route of the patch a `diff` or `commit` step opens, kept by `file` and `lines`. */
  readonly maybePatch: Option.Option<string>;
  /** The task a `task` step found, for a `diff` or a `commit`. */
  readonly maybeTask: Option.Option<TraceTask>;
}

const NO_CARRY: Carry = {
  maybeFile: Option.none(),
  maybePatch: Option.none(),
  maybeTask: Option.none(),
};

interface Fault {
  readonly message: string;
  readonly reason: MissReason;
}

/** What checking one step found: it opens (perhaps with a note), it stops, or it waits for data. */
type Outcome = Data.TaggedEnum<{
  Open: {
    readonly carry: Carry;
    readonly maybeNote: Option.Option<Fault>;
    readonly needs: Needs;
    readonly step: Step;
  };
  Stop: { readonly fault: Fault };
  Wait: {};
}>;
const Outcome = Data.taggedEnum<Outcome>();

const opens = (step: Step, needs: Needs, carry: Carry = NO_CARRY): Outcome =>
  Outcome.Open({ carry, maybeNote: Option.none(), needs, step });

/** A step that opens code at a patch route, and the file in it a `file` step found. */
const opensPatch = (
  step: Step,
  path: string,
  maybeFile: Option.Option<FileDiffMetadata> = Option.none(),
): Outcome =>
  opens(step, Needs.Patch({ path }), {
    maybeFile,
    maybePatch: Option.some(path),
    maybeTask: Option.none(),
  });

const stops = (reason: MissReason, message: string): Outcome =>
  Outcome.Stop({ fault: { message, reason } });

const sectionOf = (trace: Trace, id: string): Option.Option<TraceSection> =>
  Array.findFirst(
    Array.appendAll(trace.prd.sections, trace.spec.sections),
    (section) => section.id === id,
  );

const deleted = (id: string): Outcome =>
  stops("section-missing", `No section has the ID ${id}: it was deleted.`);

/** The most of a quote the notice repeats. */
const QUOTE_PREVIEW = 80;

const previewOf = (quote: string): string =>
  String.length(quote) > QUOTE_PREVIEW ? `${String.takeLeft(quote, QUOTE_PREVIEW)}…` : quote;

/** The sentence the demo's diff pane shows, since it has no server to fetch a patch from. */
const DEMO_PATCH = "The diff needs `cairn serve`.";

/** The files of the patch at a route, or why there are none yet: a wait or a miss. */
const filesAt = (
  loaded: Loaded,
  path: string,
): Result.Result<ReadonlyArray<FileDiffMetadata>, Outcome> =>
  loaded.isDemo
    ? Result.fail(stops("patch-unavailable", DEMO_PATCH))
    : Option.match(Record.get(loaded.patches, path), {
        onNone: () => Result.fail(Outcome.Wait()),
        onSome: (data) =>
          Match.valueTags(data, {
            Failed: ({ message }) => Result.fail(stops("patch-unavailable", message)),
            Loaded: ({ text }) =>
              Result.match(parsePatch(text), {
                onFailure: (error) =>
                  Result.fail(stops("patch-unavailable", describePatchNotParsed(error))),
                onSuccess: ({ files }) => Result.succeed(files),
              }),
            Loading: () => Result.fail(Outcome.Wait()),
          }),
      });

interface Span {
  readonly end: number;
  readonly start: number;
}

/** The lines a file's hunks show on one side, as runs of consecutive lines in order. */
const shownRunsOf = (file: FileDiffMetadata, side: "new" | "old"): ReadonlyArray<Span> =>
  pipe(
    Array.filterMap(file.hunks, (hunk) => {
      const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
      const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
      return count > 0 ? Result.succeed({ end: start + count - 1, start }) : Result.failVoid;
    }),
    Array.sortWith((span) => span.start, Order.Number),
    Array.reduce(Array.empty<Span>(), (runs, span) =>
      Option.match(Array.last(runs), {
        onNone: () => [span],
        onSome: (last) =>
          span.start <= last.end + 1
            ? Array.append(Array.dropRight(runs, 1), {
                end: Number.max(last.end, span.end),
                start: last.start,
              })
            : Array.append(runs, span),
      }),
    ),
  );

const linesName = (start: number, end: number, side: "new" | "old"): string =>
  `${start === end ? `line ${start}` : `lines ${start}-${end}`}${side === "old" ? " on the old side" : ""}`;

/** Checks one step against the trace and the loaded data, given what the step before it left. */
const check = (trace: Trace, loaded: Loaded, carry: Carry, step: Step): Outcome =>
  Step.match(step, {
    commit: ({ sha }) =>
      Option.match(ownerOf(trace, sha), {
        onNone: () => stops("commit-missing", `No task in the trace has commit ${shortSha(sha)}.`),
        onSome: (owner) =>
          Option.match(
            Option.filter(carry.maybeTask, (task) => task.id !== owner.id),
            {
              onNone: () => opensPatch(step, commitPathOf(sha)),
              onSome: (task) =>
                stops(
                  "commit-not-on-task",
                  `Commit ${shortSha(sha)} is not on ${task.id}: it is on ${owner.id}.`,
                ),
            },
          ),
      }),
    diff: ({ head }) => {
      const notOnTask = (task: string) =>
        stops(
          "commit-not-on-task",
          `Commit ${shortSha(head)} is not on ${task}: the branch was restacked or rewritten after the link was copied.`,
        );
      return Option.match(carry.maybeTask, {
        onNone: () => notOnTask("the task before it"),
        onSome: (task) =>
          Option.match(commitOf(task, head), {
            onNone: () => notOnTask(task.id),
            onSome: () =>
              Option.match(rangeOf(task), {
                onNone: () => stops("patch-unavailable", `${task.id} has no diff to show.`),
                onSome: ({ base }) => opensPatch(step, diffPathOf(base, head)),
              }),
          }),
      });
    },
    file: ({ path }) =>
      Option.match(carry.maybePatch, {
        onNone: () => stops("file-not-in-diff", `\`${path}\` is not in a diff.`),
        onSome: (patch) =>
          Result.match(filesAt(loaded, patch), {
            onFailure: (outcome) => outcome,
            onSuccess: (files) =>
              Option.match(
                Array.findFirst(files, (file) => file.name === path),
                {
                  onNone: () => stops("file-not-in-diff", `\`${path}\` is not in that diff.`),
                  onSome: (file) => opensPatch(step, patch, Option.some(file)),
                },
              ),
          }),
      }),
    lines: ({ end, side, start }) => {
      const missing = (where: string) =>
        stops(
          "lines-not-in-diff",
          `${String.capitalize(linesName(start, end, side))} ${start === end ? "is" : "are"} not in ${where}.`,
        );
      return Option.match(Option.all({ file: carry.maybeFile, patch: carry.maybePatch }), {
        onNone: () => missing("a diff"),
        onSome: ({ file, patch }) =>
          Array.some(shownRunsOf(file, side), (run) => run.start <= start && end <= run.end)
            ? opensPatch(step, patch, Option.some(file))
            : missing(`the diff of \`${file.name}\``),
      });
    },
    note: () => stops("notes-unavailable", "Notes are not stored yet."),
    passage: ({ quote, section }) =>
      Option.match(sectionOf(trace, section), {
        onNone: () => deleted(section),
        onSome: (found) =>
          Option.match(passageOf(indexOf(trace), section, quote), {
            onNone: () =>
              Outcome.Open({
                carry: NO_CARRY,
                maybeNote: Option.some({
                  message: `The passage changed: "${previewOf(quote)}" is no longer in ${found.title}.`,
                  reason: "passage-changed",
                }),
                needs: Needs.Nothing(),
                step: { id: section, kind: "section" },
              }),
            onSome: (marks) => opens(step, Needs.Passage({ marks })),
          }),
      }),
    section: ({ id }) =>
      Option.isSome(sectionOf(trace, id)) ? opens(step, Needs.Nothing()) : deleted(id),
    segment: ({ root }) =>
      Option.isSome(
        Array.findFirst(
          stacksOf(trace.tasks),
          (stack) => stack.root === root && Array.length(trunkOf(stack, trace.tasks)) >= 2,
        ),
      )
        ? opens(step, Needs.Nothing())
        : stops(
            "segment-missing",
            `The stack from ${root} has no finished trunk of two or more tasks.`,
          ),
    stack: ({ root }) =>
      Array.some(stacksOf(trace.tasks), (stack) => stack.root === root)
        ? opens(step, Needs.Nothing())
        : stops("stack-missing", `No stack starts at task ${root}.`),
    task: ({ id }) =>
      Option.match(taskOf(trace, id), {
        onNone: () => stops("task-missing", `No task ${id} in the trace.`),
        onSome: (task) =>
          opens(step, Needs.Nothing(), {
            maybeFile: Option.none(),
            maybePatch: Option.none(),
            maybeTask: Option.some(task),
          }),
      }),
    turn: ({ session, turn }) =>
      !Array.some(
        Array.flatMap(trace.tasks, (task) => task.commits),
        (commit) => commit.session === session,
      )
        ? stops("session-missing", `No commit in the trace has session ${session}.`)
        : loaded.isDemo
          ? stops("sessions-unavailable", "Sessions need `cairn serve`.")
          : Option.match(Record.get(loaded.sessions, session), {
              onNone: () => Outcome.Wait(),
              onSome: Result.match({
                onFailure: (reason) =>
                  stops("session-missing", `Session ${session} did not load: ${reason}.`),
                onSuccess: (found) =>
                  Array.some(found.turns, (candidate) => candidate.id === turn)
                    ? opens(step, Needs.Nothing())
                    : stops("turn-missing", `Session ${session} has no turn ${turn}.`),
              }),
            }),
  });

/**
 * Walks a link's steps in order against the trace and the data the model has received. A step
 * whose patch or session has not arrived makes `waiting` its index, and resolution stops there.
 * A miss stops it too, except a passage that changed, which opens as its section. Pure.
 */
export const resolveLink = (trace: Trace, link: Link, loaded: Loaded): Resolution => {
  const walk = (
    index: number,
    carry: Carry,
    resolved: ReadonlyArray<OpenedStep>,
    missing: ReadonlyArray<Miss>,
  ): Resolution =>
    Option.match(Array.get(link, index), {
      onNone: () => ({ missing, resolved, waiting: Option.none() }),
      onSome: (step) => {
        const missOf = (fault: Fault): Miss => ({
          index,
          message: fault.message,
          reason: fault.reason,
          step,
        });
        return Outcome.$match(check(trace, loaded, carry, step), {
          Open: (opened) =>
            walk(
              index + 1,
              opened.carry,
              Array.append(resolved, { index, needs: opened.needs, step: opened.step }),
              Option.match(opened.maybeNote, {
                onNone: () => missing,
                onSome: (fault) => Array.append(missing, missOf(fault)),
              }),
            ),
          Stop: ({ fault }) => ({
            missing: Array.append(missing, missOf(fault)),
            resolved,
            waiting: Option.none(),
          }),
          Wait: () => ({ missing, resolved, waiting: Option.some(index) }),
        });
      },
    });
  return walk(0, NO_CARRY, [], []);
};

// THE NOTICE

/** How the notice names a step that opened. */
const stepNameOf: (step: Step) => string = Step.match({
  commit: ({ sha }) => `commit ${shortSha(sha)}`,
  diff: ({ head }) => `the diff at ${shortSha(head)}`,
  file: ({ path }) => `\`${path}\``,
  lines: ({ end, side, start }) => linesName(start, end, side),
  note: ({ id }) => `note ${id}`,
  passage: ({ section }) => `a passage of ${section}`,
  section: ({ id }) => `section ${id}`,
  segment: ({ root }) => `the finished trunk from ${root}`,
  stack: ({ root }) => `the stack from ${root}`,
  task: ({ id }) => `task ${id}`,
  turn: ({ turn }) => `turn ${turn}`,
});

/**
 * What the notice says about a link: why the address is not a link, or how far it opened and what
 * is missing. None for a link that opened whole, or is still waiting with nothing missing.
 */
export const noticeOf = (outcome: Result.Result<Resolution, LinkError>): Option.Option<string> =>
  Result.match(outcome, {
    onFailure: (error) => Option.some(`This address is not a Cairn link: ${error.message}.`),
    onSuccess: ({ missing, resolved }) =>
      Option.map(Option.liftPredicate(missing, Array.isReadonlyArrayNonEmpty), (misses) =>
        Array.join(
          Array.appendAll(
            Array.some(misses, isStopping)
              ? [
                  Option.match(Array.last(resolved), {
                    onNone: () => "Nothing in this link opened.",
                    onSome: (last) => `Opened as far as ${stepNameOf(last.step)}.`,
                  }),
                ]
              : [],
            Array.map(misses, (miss) => miss.message),
          ),
          " ",
        ),
      ),
  });

// WHAT IS ON SCREEN

const isPrdSection = Schema.is(PrdSectionId);
const isSpecSection = Schema.is(SpecSectionId);

const sectionStep = (id: PrdSectionId | SpecSectionId): Step => ({ id, kind: "section" });

/** The data a link's steps read, as the model holds it: a session still loading is not there yet. */
export const loadedOf = (model: Model): Loaded => ({
  isDemo: isDemoBuild(),
  patches: model.patches,
  sessions: Record.filterMap(
    model.sessions,
    (data): Result.Result<Result.Result<Session, string>, void> =>
      SessionData.match(data, {
        Failed: ({ message }) => Result.succeed(Result.fail(message)),
        Loaded: ({ session }) => Result.succeed(Result.succeed(session)),
        Loading: () => Result.failVoid,
      }),
  ),
});

/** A trail node as a step: a spec section or a task. A PRD section is the pin's, not the trail's. */
export const trailStepOf = (node: Node): Result.Result<Step, void> =>
  Node.match(node, {
    section: ({ id }) => (isSpecSection(id) ? Result.succeed(sectionStep(id)) : Result.failVoid),
    task: ({ id }) => Result.succeed<Step>({ id, kind: "task" }),
  });

/**
 * The code view's steps: its task unless the trail already ends on it, then the diff at the head
 * it shows or the commit, the file, the lines and the highlighted turn. A task with no commits
 * shows no code, so only its task step is written.
 */
const codeStepsOf = (model: Model, trace: Trace, code: CodeScreen): ReadonlyArray<Step> => {
  const taskSteps: ReadonlyArray<Step> = Option.exists(
    Array.last(model.detail),
    (node) => node.kind === "task" && node.id === code.taskId,
  )
    ? []
    : [{ id: code.taskId, kind: "task" }];
  return Option.match(taskOf(trace, code.taskId), {
    onNone: () => [],
    onSome: (task) => {
      const shownCommit = shownCommitOf(task, code.shown);
      return Option.match(
        Shown.match(code.shown, {
          OneCommit: ({ sha }) => Option.some<Step>({ kind: "commit", sha }),
          WholeTask: () =>
            Option.map(shownCommit, (commit): Step => ({ head: commit.sha, kind: "diff" })),
        }),
        {
          onNone: () => taskSteps,
          onSome: (opened) =>
            Array.flatten<ReadonlyArray<ReadonlyArray<Step>>>([
              taskSteps,
              [opened],
              Array.map(Array.fromOption(code.maybeFile), (path): Step => ({ kind: "file", path })),
              Option.isSome(code.maybeFile) ? Array.fromOption(code.maybeLines) : [],
              Array.fromOption(
                Option.map(
                  Option.all({
                    session: Option.flatMapNullishOr(shownCommit, (commit) => commit.session),
                    turn: model.maybeHighlightedTurn,
                  }),
                  ({ session, turn }): Step => ({ kind: "turn", session, turn: turn.id }),
                ),
              ),
            ]),
        },
      );
    },
  });
};

/**
 * The canonical link of what was opened, in this order: the pinned PRD section or a PRD passage in
 * its place, a spec passage, the focused stack or segment, the detail trail, the code view's task
 * when the trail does not end on it, the diff or commit, the file, the lines and the highlighted
 * turn. The section at the top of the PRD pane, the widths, the switches, the cards and the search
 * are each viewer's own and are not in it. Pure.
 */
export const linkOf = (model: Model): Link => {
  const { maybePassage, maybePinned } = model.reader;
  const prdPassage = Option.filter(maybePassage, (passage) =>
    Option.exists(maybePinned, (id) => id === passage.section),
  );
  const specPassage = Option.filter(maybePassage, (passage) => isSpecSection(passage.section));
  // A spec passage whose section implements no PRD section has no card, so opening it starts the
  // trail on its section. The passage step implies that first trail step, so it is not written.
  const isImpliedSection = (node: Node): boolean =>
    Option.exists(specPassage, (passage) => {
      const id: string = passage.section;
      return node.kind === "section" && id === node.id;
    }) &&
    Option.exists(
      Option.flatMap(loadedTraceOf(model.trace), (trace) =>
        Array.findFirst(trace.spec.sections, (section) => section.id === node.id),
      ),
      (section) => Array.isReadonlyArrayEmpty(section.keys.implements),
    );
  const trail = Option.match(Array.head(model.detail), {
    onNone: () => model.detail,
    onSome: (first) => (isImpliedSection(first) ? Array.drop(model.detail, 1) : model.detail),
  });
  return Array.flatten<ReadonlyArray<ReadonlyArray<Step>>>([
    Option.match(prdPassage, {
      onNone: () => Array.map(Array.fromOption(maybePinned), sectionStep),
      onSome: (passage) => [passage],
    }),
    Array.fromOption(specPassage),
    Array.fromOption(model.reader.maybeFocus),
    Array.filterMap(trail, trailStepOf),
    Option.match(
      Option.all({
        code: Option.liftPredicate(model.screen, Screen.guards.Code),
        trace: loadedTraceOf(model.trace),
      }),
      { onNone: () => [], onSome: ({ code, trace }) => codeStepsOf(model, trace, code) },
    ),
  ]);
};

const stepEquivalence = Schema.toEquivalence(Step);

/** How many steps two links share from their start. */
export const sharedLengthOf = (self: Link, that: Link): number =>
  Option.getOrElse(
    Array.findFirstIndex(Array.zip(self, that), ([one, other]) => !stepEquivalence(one, other)),
    () => Number.min(Array.length(self), Array.length(that)),
  );

// COPYING

/** The steps that only mean something after the step before them. */
const DEPENDENT: ReadonlyArray<Step["kind"]> = ["diff", "file", "lines"];

/**
 * The shortest link that opens the step at `index` by itself, or none when the link has no such
 * step. A section, passage, task, stack, segment, commit, turn or note is its own step. A diff is
 * its task and itself, a file is the diff or commit before it with its own steps, and lines are
 * those and the file. Pure.
 */
export const aloneOf = (link: Link, index: number): Option.Option<Link> =>
  Option.flatMap(Array.get(link, index), (step): Option.Option<Link> =>
    Array.contains(DEPENDENT, step.kind)
      ? Option.map(aloneOf(link, index - 1), (before) => Array.append(before, step))
      : Option.some([step]),
  );

/** A link as the path a button copies. A list of steps that breaks the ordering rules copies `/`. */
export const pathOfLink = (link: Link): string => Result.getOrElse(encodeLink(link), () => "/");

const decodeSectionId = Schema.decodeUnknownOption(Schema.Union([PrdSectionId, SpecSectionId]));

/**
 * The path of a section alone: what a heading's or a card's Copy link copies. An id that is not a
 * PRD or spec section's has no link, so it copies the root.
 */
export const sectionPathOf = (id: SectionId): string =>
  Option.match(decodeSectionId(id), {
    onNone: () => "/",
    onSome: (valid) => pathOfLink([sectionStep(valid)]),
  });

/** The most characters a quote holds; the contract's `Quote` says the same. */
export const QUOTE_LIMIT = 500;

const decodePassage = Schema.decodeUnknownOption(PassageStep);

/** The passage step a selection makes. None when its text is not a quote a link can hold. */
export const passageStepOf = ({
  quote,
  section,
}: PassageSelection): Option.Option<typeof PassageStep.Type> =>
  decodePassage({ kind: "passage", quote, section });

/** The passage step a selection makes, when the section's prose holds its quote. */
export const foundPassageOf = (
  trace: Trace,
  selection: PassageSelection,
): Option.Option<typeof PassageStep.Type> =>
  Option.filter(passageStepOf(selection), ({ quote, section }) =>
    Option.isSome(passageOf(indexOf(trace), section, quote)),
  );

/**
 * "Copy link to passage" for a selection: its section, and whether the text is too long to link.
 * None when the text is not one a link can quote, or when the section's prose does not hold it
 * (a fenced code block, a diagram and a key row are shown but are not prose), so no button is
 * shown for a link that would open as a changed passage.
 */
export interface PassageButton {
  readonly isOverLimit: boolean;
  readonly section: SectionId;
}

export const passageButtonOf = (
  trace: Trace,
  maybeSelection: Option.Option<PassageSelection>,
): Option.Option<PassageButton> =>
  Option.flatMap(maybeSelection, (selection): Option.Option<PassageButton> =>
    String.length(selection.quote) > QUOTE_LIMIT
      ? Option.some({ isOverLimit: true, section: selection.section })
      : Option.as(foundPassageOf(trace, selection), {
          isOverLimit: false,
          section: selection.section,
        }),
  );

/**
 * The paths the code view's buttons copy: the whole link, the link's last step alone, and the link
 * up to a turn, which is its own for each turn. `maybeCopied` is the path last written to the
 * clipboard, which reads "copied" in the button that holds it.
 */
export interface CopyLinks {
  readonly maybeAlone: Option.Option<string>;
  readonly maybeCopied: Option.Option<string>;
  readonly maybeTurn: (id: string) => Option.Option<string>;
  readonly maybeWhole: Option.Option<string>;
}

/** The link up to the turn `id`, when the code view has a session to hold it. */
const turnLinkOf = (model: Model, id: string): Option.Option<Link> =>
  Option.liftPredicate(
    linkOf(
      UiStruct.evolve(model, {
        maybeHighlightedTurn: () => Option.some(HighlightedTurn.make({ from: "session", id })),
      }),
    ),
    (link) => Option.exists(Array.last(link), (step) => step.kind === "turn" && step.turn === id),
  );

/** What the code view's copy buttons give for the model's link. */
export const copyLinksOf = (model: Model): CopyLinks => {
  const link = linkOf(model);
  return {
    maybeAlone: Option.map(aloneOf(link, Array.length(link) - 1), pathOfLink),
    maybeCopied: model.maybeCopiedLink,
    maybeTurn: (id) => Option.map(turnLinkOf(model, id), pathOfLink),
    maybeWhole: Option.map(Option.liftPredicate(link, Array.isReadonlyArrayNonEmpty), pathOfLink),
  };
};

/**
 * The link up to the trail's step at `index`: what comes before the trail (the pin, a passage, a
 * focus) and the trail cut after that step. The code view is not part of it.
 */
export const trailLinkOf = (model: Model, index: number): Link =>
  linkOf(
    UiStruct.evolve(model, {
      detail: Array.take(index + 1),
      screen: () => Screen.Reader(),
    }),
  );

// BRINGING A STEP INTO VIEW

/** The marks a link's passage is drawn with, in the PRD or the spec pane. */
export const LINK_PASSAGE_SELECTOR = "mark[data-link-passage]";

/**
 * The ranges the open passage covers in one document's prose blocks, by the block's offset, for
 * the pane that renders that document. A passage in the other document, or one whose text changed,
 * marks nothing here. Pure.
 */
export const linkedMarksOf = (
  trace: Trace,
  maybePassage: Option.Option<typeof PassageStep.Type>,
  document: "prd" | "spec",
): Record.ReadonlyRecord<string, ReadonlyArray<Range>> =>
  Option.match(
    Option.flatMap(
      Option.filter(maybePassage, ({ section }) => isPrdSection(section) === (document === "prd")),
      ({ quote, section }) => passageOf(indexOf(trace), section, quote),
    ),
    {
      onNone: () => ({}),
      onSome: (blocks) =>
        Record.fromIterableWith(blocks, ({ offset, range }) => [`${offset}`, [range]]),
    },
  );

const STACKS_PANE = "[data-stacks-pane]";

const prdHeadingSelector = (id: string): string =>
  `[data-prd-pane] [data-section="${id}"]:not([data-title])`;

const cardSelector = (id: string): string => `[data-spec="${id}"]`;

const chipSelector = stackTaskSelectorOf;

const sectionSelector = (id: string): string =>
  isPrdSection(id) ? prdHeadingSelector(id) : cardSelector(id);

/** The stack box a root starts, then its root's chip until the box is in the page. */
const boxSelectorsOf = (trace: Trace, root: string): ReadonlyArray<string> =>
  Array.append(
    Array.map(
      Array.fromOption(Array.findFirst(stacksOf(trace.tasks), (stack) => stack.root === root)),
      (stack) => `${STACKS_PANE} [data-stack="${stack.number}"]`,
    ),
    chipSelector(root),
  );

const targetOf = (
  block: ScrollTarget["block"],
  selectors: ReadonlyArray<string>,
): ReadonlyArray<ScrollTarget> => [{ block, selectors }];

const nearest = (selectors: ReadonlyArray<string>): ReadonlyArray<ScrollTarget> =>
  targetOf("nearest", selectors);

/**
 * Where a step that opened is brought into view: a PRD section's heading, a passage's first mark,
 * a spec section's card, a task's chip, a stack's box or a turn in the session pane. The code view
 * shows a diff, a commit and a file when it opens on them, so they scroll nothing.
 */
export const linkTargetsOf = (trace: Trace, step: Step): ReadonlyArray<ScrollTarget> =>
  Step.match(step, {
    commit: () => [],
    diff: () => [],
    file: () => [],
    lines: () => [],
    note: () => [],
    passage: ({ section }) => nearest([LINK_PASSAGE_SELECTOR, sectionSelector(section)]),
    section: ({ id }) =>
      isPrdSection(id) ? targetOf("start", [prdHeadingSelector(id)]) : nearest([cardSelector(id)]),
    segment: ({ root }) => nearest(boxSelectorsOf(trace, root)),
    stack: ({ root }) => nearest(boxSelectorsOf(trace, root)),
    task: ({ id }) => nearest([chipSelector(id)]),
    turn: ({ turn }) => nearest([`[id="${turnElementIdOf(turn)}"]`]),
  });
