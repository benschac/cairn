import { LinkError, Step, encodeLink } from "@cairn/contract";
import type { Sha } from "@cairn/contract";
import {
  Array,
  Number,
  Option,
  Predicate,
  Record,
  Result,
  Schema,
  SchemaIssue,
  String,
  Struct,
  pipe,
} from "effect";

/** What `cairn link` checks its arguments against, read from the repository. */
export interface LinkPlan {
  /** Every section ID that is a heading in `prd.md` or `spec.md`. */
  readonly sections: ReadonlyArray<string>;
  /** Each manifest task by ID, with its commits that carry its `Cairn-Task` trailer, newest first. */
  readonly tasks: Record.ReadonlyRecord<
    string,
    { readonly commits: ReadonlyArray<Sha>; readonly parent: string | null }
  >;
  /** Each commit git knows, with the task its trailer names. */
  readonly commits: Record.ReadonlyRecord<string, string | null>;
}

/** An argument `cairn link` refuses, with the token in `reason`. */
export class LinkArgError extends Schema.TaggedError<
  LinkArgError,
  { readonly brand: unique symbol }
>()("LinkArgError", { reason: Schema.String }) {
  override get message() {
    return this.reason;
  }
}

/** A step as the arguments give it, before the `Step` schema decodes it. */
type Raw = Readonly<Record<string, unknown>> & { readonly kind: string };

type Outcome = Result.Result<ReadonlyArray<Raw>, LinkArgError>;

/** What a flag does with its value, given the steps so far. */
type Handler = (value: string, steps: ReadonlyArray<Raw>, old: boolean, plan: LinkPlan) => Outcome;

const refuse = (reason: string) => Result.fail(new LinkArgError({ reason }));

const lastOf = (steps: ReadonlyArray<Raw>): Option.Option<Raw> => Array.last(steps);

/** The id of the last step, when it is a task. */
const lastTaskId = (steps: ReadonlyArray<Raw>): Option.Option<string> =>
  pipe(
    lastOf(steps),
    Option.filter((step) => step.kind === "task"),
    Option.flatMap((step) => Record.get(step, "id")),
    Option.filter(Predicate.isString),
  );

const lastKindIs = (steps: ReadonlyArray<Raw>, kind: string) =>
  Option.exists(lastOf(steps), (step) => step.kind === kind);

/** Whitespace runs as one space, trimmed: the form a `Quote` takes. */
const collapsed = (text: string) => pipe(text, String.replaceAll(/\s+/gu, " "), String.trim);

const RANGE = /^(\d+)(?:-(\d+))?$/u;

const newestOf = (plan: LinkPlan, id: string) =>
  pipe(
    Record.get(plan.tasks, id),
    Option.flatMap((task) => Array.head(task.commits)),
  );

const rootOf =
  (name: string) => (value: string, steps: ReadonlyArray<Raw>, _old: boolean, plan: LinkPlan) =>
    Option.match(Record.get(plan.tasks, value), {
      onNone: () => refuse(`unknown task ${value}`),
      onSome: ({ parent }) =>
        parent === null
          ? Result.succeed(Array.append(steps, { kind: name, root: value }))
          : refuse(`${value} is not the root of a stack, its parent is ${parent}`),
    });

const HANDLERS: Record.ReadonlyRecord<string, Handler> = {
  "--base": (_value, steps) => Result.succeed(steps),
  "--commit": (value, steps, _old, plan) =>
    Option.match(Record.get(plan.commits, value), {
      onNone: () => refuse(`unknown commit ${value}`),
      onSome: (taskId) =>
        pipe(
          lastTaskId(steps),
          Option.filter((id) => id !== taskId),
          Option.match({
            onNone: () => Result.succeed(Array.append(steps, { kind: "commit", sha: value })),
            onSome: (id) => refuse(`commit ${value} does not carry ${id}'s Cairn-Task trailer`),
          }),
        ),
    }),
  "--file": (value, steps, _old, plan) =>
    pipe(
      lastTaskId(steps),
      Option.match({
        onNone: () => Result.succeed(Array.append(steps, { kind: "file", path: value })),
        onSome: (id) =>
          Option.match(newestOf(plan, id), {
            onNone: () => refuse(`${id} has no commits, so it has no diff yet`),
            onSome: (head) =>
              Result.succeed(
                Array.appendAll(steps, [
                  { head, kind: "diff" },
                  { kind: "file", path: value },
                ]),
              ),
          }),
      }),
    ),
  "--line": (value, steps, old) =>
    !lastKindIs(steps, "file")
      ? refuse("--line must follow --file")
      : pipe(
          String.match(RANGE)(value),
          Option.flatMap(([, start = "", end = start]) =>
            Option.all({ end: Number.parse(end), start: Number.parse(start) }),
          ),
          Option.match({
            onNone: () => refuse(`--line expects 40 or 40-42, not ${value}`),
            onSome: ({ end, start }) =>
              Result.succeed(
                Array.append(steps, { end, kind: "lines", side: old ? "old" : "new", start }),
              ),
          }),
        ),
  "--note": (value, steps) => Result.succeed(Array.append(steps, { id: value, kind: "note" })),
  "--passage": (value, steps) =>
    pipe(
      lastOf(steps),
      Option.filter((step) => step.kind === "section"),
      Option.match({
        onNone: () => refuse("--passage must follow a section"),
        onSome: (section) =>
          Result.succeed(
            Array.append(Array.dropRight(steps, 1), {
              kind: "passage",
              quote: collapsed(value),
              section: section["id"],
            }),
          ),
      }),
    ),
  "--segment": rootOf("segment"),
  "--stack": rootOf("stack"),
  "--turn": (value, steps) =>
    pipe(
      String.match(/^([^/]+)\/(.+)$/su)(value),
      Option.match({
        onNone: () => refuse(`--turn expects <session>/<turn>, not ${value}`),
        onSome: ([, session, turn]) =>
          Result.succeed(Array.append(steps, { kind: "turn", session, turn })),
      }),
    ),
};

/** A bare token: a section, or a task in the manifest. */
const positional = (token: string, steps: ReadonlyArray<Raw>, plan: LinkPlan): Outcome =>
  String.startsWith("prd.")(token) || String.startsWith("spec.")(token)
    ? Array.contains(plan.sections, token)
      ? Result.succeed(Array.append(steps, { id: token, kind: "section" }))
      : refuse(`unknown section ${token}`)
    : Record.has(plan.tasks, token)
      ? Result.succeed(Array.append(steps, { id: token, kind: "task" }))
      : refuse(`unknown task ${token}`);

/** An option as typed: `--line 40` or `--line=40`, which `effect/cli` accepts both ways. */
const splitOption = (token: string) =>
  Option.match(String.match(/^(--[^=]+)=(.*)$/su)(token), {
    onNone: () => ({ inline: Option.none<string>(), name: token }),
    onSome: ([, name = token, value = ""]) => ({ inline: Option.some(value), name }),
  });

const readTokens = (
  tokens: ReadonlyArray<string>,
  steps: ReadonlyArray<Raw>,
  old: boolean,
  plan: LinkPlan,
): Outcome =>
  Array.match(tokens, {
    onEmpty: () => (old ? refuse("--old must be followed by --line") : Result.succeed(steps)),
    onNonEmpty: ([token, ...rest]) => {
      const { inline, name } = splitOption(token);
      if (old && name !== "--line") {
        return refuse("--old must be followed by --line");
      }
      if (name === "--old" && Option.isNone(inline)) {
        return readTokens(rest, steps, true, plan);
      }
      if (!String.startsWith("--")(token)) {
        return Result.flatMap(positional(token, steps, plan), (next) =>
          readTokens(rest, next, false, plan),
        );
      }
      return Option.match(Record.get(HANDLERS, name), {
        onNone: () => refuse(`unknown option ${name}`),
        onSome: (handler) =>
          Option.match(
            Option.match(inline, {
              onNone: () =>
                Option.map(Array.head(rest), (value) => ({ rest: Array.drop(rest, 1), value })),
              onSome: (value) => Option.some({ rest, value }),
            }),
            {
              onNone: () => refuse(`${name} needs a value`),
              onSome: (given) =>
                Result.flatMap(handler(given.value, steps, old, plan), (next) =>
                  readTokens(given.rest, next, false, plan),
                ),
            },
          ),
      });
    },
  });

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const decodeStep = Schema.decodeUnknownResult(Step);

/** A step decoded through the `Step` schema, so a bad argument is a `LinkError`, never a bad path. */
const stepOf = (raw: Raw, index: number): Result.Result<Step, LinkError> =>
  Result.mapError(decodeStep(raw), (error) => {
    const issue = Array.head(formatIssue(error.issue).issues);
    return new LinkError({
      field: pipe(
        issue,
        Option.map(({ path = [] }) => Array.join(Array.map(path, globalThis.String), ".")),
        Option.filter(String.isNonEmpty),
      ),
      index,
      reason: Option.match(issue, { onNone: () => error.message, onSome: Struct.get("message") }),
      step: raw.kind,
    });
  });

/**
 * The steps the arguments name, in the order given. `tokens` are the raw arguments after `link`,
 * because `effect/cli` loses the order of options and positional arguments. Every step is decoded
 * through the `Step` schema, so a bad argument fails and never reaches a path.
 */
export const stepsOfArgs = (
  tokens: ReadonlyArray<string>,
  plan: LinkPlan,
): Result.Result<ReadonlyArray<Step>, LinkArgError | LinkError> =>
  Result.flatMap(readTokens(tokens, [], false, plan), (raws) =>
    Result.all(Array.map(raws, stepOf)),
  );

/** The path of the link the arguments name, or why they are not a link. */
export const pathOfArgs = (
  tokens: ReadonlyArray<string>,
  plan: LinkPlan,
): Result.Result<string, LinkArgError | LinkError> =>
  Result.flatMap(stepsOfArgs(tokens, plan), encodeLink);
