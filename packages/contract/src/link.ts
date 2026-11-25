import {
  Array,
  Effect,
  Number,
  Option,
  Record,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  String,
  pipe,
} from "effect";

import { PrdSectionId, SpecSectionId, TaskId } from "./ids.ts";
import { SessionId, Sha } from "./trailers.ts";

/**
 * Text with no lone surrogate. `encodeURIComponent` throws on one, so a link argument that is
 * free text has to be well formed to be written.
 */
const WELL_FORMED = /^[^\u{D800}-\u{DFFF}]*$/u;

const wellFormed = Schema.isPattern(WELL_FORMED, { expected: "text with no lone surrogate" });

/**
 * `.` and `..` are dot segments: a browser drops them from a URL's path, percent-encoded or not,
 * so no argument can be one.
 */
const notDotSegment = Schema.isPattern(/^(?!\.\.?$)/u, { expected: "text other than . or .." });

/** Free text in a link, such as a file path or a turn's id. */
const LinkText = Schema.NonEmptyString.check(wellFormed, notDotSegment);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Selected text: 1 to 500 characters, whitespace runs collapsed to one space, trimmed. */
export const Quote = Schema.String.check(
  Schema.isMaxLength(500),
  Schema.isPattern(/^\S+(?: \S+)*$/u, {
    expected: "text with single spaces between words and none at either end",
  }),
  wellFormed,
  notDotSegment,
).pipe(Schema.brand("Quote"));
export type Quote = typeof Quote.Type;

/** A note's id, on the pattern of `SessionId`. */
export const NoteId = Schema.String.check(Schema.isPattern(/^n_[a-z0-9]{6,}$/u)).pipe(
  Schema.brand("NoteId"),
);
export type NoteId = typeof NoteId.Type;

const AnySectionId = Schema.Union([PrdSectionId, SpecSectionId]);

const LinkSha = Sha.annotate({ message: "expected 40 lowercase hex characters" });

/** A PRD or spec section, or a PRD list item, by its id. */
export const SectionStep = Schema.Struct({ id: AnySectionId, kind: Schema.Literal("section") });

/** Text quoted from a section, so the link survives edits elsewhere in the document. */
export const PassageStep = Schema.Struct({
  kind: Schema.Literal("passage"),
  quote: Quote,
  section: AnySectionId,
});

export const TaskStep = Schema.Struct({ id: TaskId, kind: Schema.Literal("task") });

/** The stack that `root` starts. A root's id does not move when the plan changes; a number does. */
export const StackStep = Schema.Struct({ kind: Schema.Literal("stack"), root: TaskId });

/** The finished trunk of the stack that `root` starts. */
export const SegmentStep = Schema.Struct({ kind: Schema.Literal("segment"), root: TaskId });

/** The task before it, as its stacked diff stood at `head`. */
export const DiffStep = Schema.Struct({ head: LinkSha, kind: Schema.Literal("diff") });

export const CommitStep = Schema.Struct({ kind: Schema.Literal("commit"), sha: LinkSha });

/** A file in the diff or commit before it, relative to the repo root. */
export const FileStep = Schema.Struct({ kind: Schema.Literal("file"), path: LinkText });

/** A line or a range of lines in the file before it, on the new or the old side. */
export const LinesStep = Schema.Struct({
  end: PositiveInt,
  kind: Schema.Literal("lines"),
  side: Schema.Literals(["new", "old"]),
  start: PositiveInt,
}).check(
  Schema.makeFilter(({ end, start }) =>
    Number.isLessThanOrEqualTo(start, end)
      ? undefined
      : { issue: "must not be less than start", path: ["end"] },
  ),
);

/** A turn of an agent session, by the turn's id. */
export const TurnStep = Schema.Struct({
  kind: Schema.Literal("turn"),
  session: SessionId,
  turn: LinkText,
});

export const NoteStep = Schema.Struct({ id: NoteId, kind: Schema.Literal("note") });

export const Step = Schema.Union([
  SectionStep,
  PassageStep,
  TaskStep,
  StackStep,
  SegmentStep,
  DiffStep,
  CommitStep,
  FileStep,
  LinesStep,
  TurnStep,
  NoteStep,
]).pipe(Schema.toTaggedUnion("kind"));
export type Step = typeof Step.Type;

export type StepKind = Step["kind"];

/** Why a path is not a link, or a list of steps is not well formed. */
export class LinkError extends Schema.TaggedError<LinkError, { readonly brand: unique symbol }>()(
  "LinkError",
  {
    /** The field of the step, when the fault is in one. */
    field: Schema.Option(Schema.String),
    index: Schema.Int,
    reason: Schema.String,
    /** The step's name as the path wrote it. */
    step: Schema.String,
  },
) {
  /** For example `step 3 (file): must follow a diff or a commit`. */
  override get message(): string {
    const field = Option.match(this.field, { onNone: () => "", onSome: (name) => `.${name}` });
    return `step ${this.index} (${this.step})${field}: ${this.reason}`;
  }
}

const linkError = (index: number, step: string, field: Option.Option<string>, reason: string) =>
  new LinkError({ field, index, reason, step });

/** The steps each step must come directly after, when it has to follow one. */
const PREDECESSORS: Record.ReadonlyRecord<StepKind, ReadonlyArray<StepKind>> = {
  commit: [],
  diff: ["task"],
  file: ["diff", "commit"],
  lines: ["file"],
  note: [],
  passage: [],
  section: [],
  segment: [],
  stack: [],
  task: [],
  turn: [],
};

/** Steps that end a link: nothing comes after them. */
const LAST: ReadonlyArray<StepKind> = ["turn", "note"];

/** Steps that open code: after one, only these may follow. */
const CODE: ReadonlyArray<StepKind> = ["diff", "commit"];
const AFTER_CODE: ReadonlyArray<StepKind> = ["file", "lines", "turn"];

const firstOf = (steps: ReadonlyArray<Step>, kinds: ReadonlyArray<StepKind>) =>
  Array.findFirst(steps, (step) => Array.contains(kinds, step.kind));

/** The rule a step breaks, given the steps before it. */
const ruleBroken = (earlier: ReadonlyArray<Step>, step: Step): Option.Option<string> =>
  Option.firstSomeOf([
    Option.map(firstOf(earlier, LAST), ({ kind }) => `must not come after a ${kind}`),
    Array.contains(AFTER_CODE, step.kind)
      ? Option.none()
      : Option.map(firstOf(earlier, CODE), ({ kind }) => `must not come after a ${kind}`),
    pipe(
      Option.liftPredicate(PREDECESSORS[step.kind], Array.isReadonlyArrayNonEmpty),
      Option.filter((kinds) =>
        Option.match(Array.last(earlier), {
          onNone: () => true,
          onSome: (before) => !Array.contains(kinds, before.kind),
        }),
      ),
      Option.map(
        (kinds) =>
          `must follow ${Array.join(
            Array.map(kinds, (kind) => `a ${kind}`),
            " or ",
          )}`,
      ),
    ),
  ]);

/** The first step of `link` that breaks an ordering rule. */
const misplaced = (link: ReadonlyArray<Step>): Option.Option<LinkError> =>
  Array.findFirst(link, (step, index) =>
    Option.map(ruleBroken(Array.take(link, index), step), (reason) =>
      linkError(index, step.kind, Option.none(), reason),
    ),
  );

/** A list of steps that follows the ordering rules. */
export const Link = Schema.Array(Step).check(
  Schema.makeFilter((link) =>
    Option.match(misplaced(link), { onNone: () => undefined, onSome: (error) => error.message }),
  ),
);
export type Link = typeof Link.Type;

/** The path segments after a step's name, in order. */
const FIELDS = {
  commit: ["sha"],
  diff: ["head"],
  file: ["path"],
  lines: ["range"],
  note: ["id"],
  passage: ["section", "quote"],
  section: ["id"],
  segment: ["root"],
  stack: ["root"],
  task: ["id"],
  turn: ["session", "turn"],
} as const satisfies Record<StepKind, Array.NonEmptyReadonlyArray<string>>;

const isStepKind = Schema.is(Schema.Literals(Step.discriminants));

const SIDES: Record.ReadonlyRecord<string, "new" | "old"> = { n: "new", o: "old" };

const LETTERS = { new: "n", old: "o" } as const;

const linesText = ({ end, side, start }: typeof LinesStep.Type) =>
  `${LETTERS[side]}${start}${start === end ? "" : `-${end}`}`;

/** The arguments a step is written with, before encoding. */
const argumentsOf: (step: Step) => ReadonlyArray<string> = Step.match({
  commit: ({ sha }) => [sha],
  diff: ({ head }) => [head],
  file: ({ path }) => [path],
  lines: (step) => [linesText(step)],
  note: ({ id }) => [id],
  passage: ({ quote, section }) => [section, quote],
  section: ({ id }) => [id],
  segment: ({ root }) => [root],
  stack: ({ root }) => [root],
  task: ({ id }) => [id],
  turn: ({ session, turn }) => [session, turn],
});

const write = (link: ReadonlyArray<Step>): string =>
  pipe(
    Array.flatMap(link, (step) =>
      Array.prepend(Array.map(argumentsOf(step), encodeURIComponent), step.kind),
    ),
    Array.join("/"),
    (path) => `/${path}`,
  );

const LINES = /^([no])(\d+)(?:-(\d+))?$/u;

/** A `lines` argument such as `n40` or `o12-14` as the step's fields. */
const readRange = (range: string): Option.Option<Record<string, unknown>> =>
  pipe(
    String.match(LINES)(range),
    Option.flatMap(([, side = "", start = "", end = start]) =>
      Option.all({
        end: Number.parse(end),
        side: Record.get(SIDES, side),
        start: Number.parse(start),
      }),
    ),
  );

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const decodeStep = Schema.decodeUnknownResult(Step);

/** The fields of a step, decoded through the step's schema. */
const readStep = (
  index: number,
  kind: StepKind,
  args: ReadonlyArray<string>,
): Result.Result<Step, LinkError> =>
  Result.gen(function* () {
    const fields = FIELDS[kind];
    const raw = yield* Result.all(
      Array.map(fields, (field, at) =>
        pipe(
          Array.get(args, at),
          Result.fromOption(() => linkError(index, kind, Option.some(field), "missing")),
          Result.flatMap((arg) =>
            Result.try({
              catch: () => linkError(index, kind, Option.some(field), "bad percent-encoding"),
              try: () => decodeURIComponent(arg),
            }),
          ),
          Result.map((value) => [field, value] as const),
        ),
      ),
    );
    const named = Record.fromEntries(raw);
    const input = yield* kind === "lines"
      ? Result.fromOption(Option.flatMap(Record.get(named, "range"), readRange), () =>
          linkError(index, kind, Option.none(), "expected n40, n40-42, o12 or o12-14"),
        )
      : Result.succeed<Record<string, unknown>>(named);
    return yield* Result.mapError(decodeStep(Record.set(input, "kind", kind)), (error) => {
      const issue = Array.head(formatIssue(error.issue).issues);
      return linkError(
        index,
        kind,
        pipe(
          issue,
          Option.map(({ path = [] }) => Array.join(Array.map(path, globalThis.String), ".")),
          Option.filter(String.isNonEmpty),
        ),
        Option.match(issue, { onNone: () => error.message, onSome: ({ message }) => message }),
      );
    });
  });

/** Reads the steps from the path segments after the leading `/`, one step at a time. */
const readSteps = (
  segments: ReadonlyArray<string>,
  index: number,
  steps: ReadonlyArray<Step>,
): Result.Result<ReadonlyArray<Step>, LinkError> =>
  Array.match(segments, {
    onEmpty: () => Result.succeed(steps),
    onNonEmpty: ([name, ...rest]) => {
      if (!isStepKind(name)) {
        return Result.fail(linkError(index, name, Option.none(), "not a step"));
      }
      const arity = Array.length(FIELDS[name]);
      return Result.flatMap(readStep(index, name, Array.take(rest, arity)), (step) =>
        readSteps(Array.drop(rest, arity), index + 1, Array.append(steps, step)),
      );
    },
  });

/**
 * Reads a link from a URL path. Every id decodes through its own contract schema, and the steps
 * must follow the ordering rules. A trailing `/` is accepted.
 */
export const decodeLink = (path: string): Result.Result<Link, LinkError> => {
  const [first, ...rest] = String.split(path, "/");
  if (String.isNonEmpty(first)) {
    return Result.fail(linkError(0, first, Option.none(), "a link starts with /"));
  }
  const segments = pipe(
    Array.last(rest),
    Option.filter(String.isEmpty),
    Option.match({ onNone: () => rest, onSome: () => Array.dropRight(rest, 1) }),
  );
  return Result.flatMap(readSteps(segments, 0, []), (link) =>
    Option.match(misplaced(link), {
      onNone: () => Result.succeed(link),
      onSome: Result.fail,
    }),
  );
};

/** Writes a link as a URL path, refusing a list of steps that breaks an ordering rule. */
export const encodeLink = (link: ReadonlyArray<Step>): Result.Result<string, LinkError> =>
  Option.match(misplaced(link), {
    onNone: () => Result.succeed(write(link)),
    onSome: Result.fail,
  });

/**
 * A link's URL path and its steps. Decoding reads a link and encoding writes one; it is the only
 * definition of a link, so a link the viewer copies and one `cairn link` prints are the same text.
 */
export const LinkFromPath = Schema.String.pipe(
  Schema.decodeTo(
    Schema.toType(Link),
    SchemaTransformation.transformEffect({
      decode: (path) =>
        Result.match(decodeLink(path), {
          onFailure: (error) =>
            Effect.fail(
              new SchemaIssue.InvalidValue({ message: error.message }, Option.some(path)),
            ),
          onSuccess: Effect.succeed,
        }),
      encode: (link) => Effect.succeed(write(link)),
    }),
  ),
);
