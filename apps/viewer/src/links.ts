import {
  Step,
  type PassageStep,
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
import { defineTaggedUnion } from "foldkit/schema";

import {
  commitOf,
  commitPathOf,
  diffPathOf,
  ownerOf,
  rangeOf,
  shortSha,
  taskOf,
} from "./codeView.ts";
import { describePatchNotParsed, parsePatch } from "./diff.ts";
import type { PatchData } from "./model.ts";
import { Range } from "./range.ts";
import { indexOf, type SearchIndex } from "./search.ts";

// RESOLUTION

/** A range in one prose block's visible text. The block is named by its offset in the markdown. */
export const BlockRange = Schema.Struct({ offset: Schema.Int, range: Range });
export type BlockRange = typeof BlockRange.Type;

/** What a step that opens needs to be shown: nothing more, a passage's marks, or a patch's route. */
export const Needs = defineTaggedUnion({
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

const isFinished = (task: TraceTask): boolean => Array.contains(FINISHED, task.status);

/**
 * The finished trunk of a stack: from its root, the run of `done` or `landed` tasks up to the
 * first fork or the first unfinished task. The task at a fork is the trunk's last. A root that is
 * not finished has no trunk.
 */
export const trunkOf = (
  stack: Stack,
  tasks: ReadonlyArray<TraceTask>,
): ReadonlyArray<TraceTask> => {
  const members = Array.filter(tasks, (task) => Record.has(stack.cells, task.id));
  // The root's own parent may close a cycle, so it is never a child.
  const childrenOf = (task: TraceTask) =>
    Array.filter(members, (child) => child.parent === task.id && child.id !== stack.root);
  const runFrom = (task: TraceTask): ReadonlyArray<TraceTask> =>
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
