import type { FileEdit, Session, Turn } from "@cairn/contract";
import {
  Array,
  HashMap,
  Match,
  Option,
  Predicate,
  Record,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

/** What the store keeps beside the log: the session's identity, redaction counts and notes. */
export type StoredSession = Pick<Session, "id" | "notes" | "redactions" | "taskId">;

// Claude Code's log format. Each schema holds only the fields the reader uses.

const Header = Schema.Struct({
  message: Schema.Record(Schema.String, Schema.Unknown),
  type: Schema.String,
  uuid: Schema.String,
});

const KindOnly = Schema.Struct({ type: Schema.String });

const TextBlock = Schema.Struct({ text: Schema.String, type: Schema.Literal("text") });

const ToolUseBlock = Schema.Struct({
  id: Schema.String,
  input: Schema.Unknown,
  name: Schema.String,
  type: Schema.Literal("tool_use"),
});

const ToolResultBlock = Schema.Struct({
  content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  is_error: Schema.optionalKey(Schema.Boolean),
  tool_use_id: Schema.String,
  type: Schema.Literal("tool_result"),
});

const Block = Schema.Union([TextBlock, ToolUseBlock, ToolResultBlock]);

const UserLine = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  }),
  timestamp: Schema.DateTimeUtcFromString,
  toolUseResult: Schema.optionalKey(Schema.Unknown),
  type: Schema.Literal("user"),
  uuid: Schema.String,
});

const AssistantLine = Schema.Struct({
  message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
  timestamp: Schema.DateTimeUtcFromString,
  type: Schema.Literal("assistant"),
  uuid: Schema.String,
});

/** The `toolUseResult` of an edit, an overwrite or a created file. */
const FileResult = Schema.Struct({
  content: Schema.optionalKey(Schema.String),
  filePath: Schema.String,
  structuredPatch: Schema.optionalKey(
    Schema.Array(Schema.Struct({ lines: Schema.Array(Schema.String) })),
  ),
  type: Schema.optionalKey(Schema.String),
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeHeader = Schema.decodeUnknownOption(Header);
const decodeKind = Schema.decodeUnknownOption(KindOnly);
const decodeBlock = Schema.decodeUnknownOption(Block);
const decodeUser = Schema.decodeUnknownOption(UserLine);
const decodeAssistant = Schema.decodeUnknownOption(AssistantLine);
const decodeFileResult = Schema.decodeUnknownOption(FileResult);
const decodeInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeText = Schema.decodeUnknownOption(TextBlock);

/** What a tool result line says about one tool call. */
interface ToolResult {
  readonly edits: ReadonlyArray<FileEdit>;
  readonly failed: boolean;
  readonly id: string;
  readonly output: string;
}

/** What one log line contributes. */
interface Reading {
  readonly hasHeader: boolean;
  readonly results: ReadonlyArray<ToolResult>;
  readonly skipped: boolean;
  readonly turns: ReadonlyArray<Turn>;
}

const NOTHING: Reading = { hasHeader: false, results: [], skipped: false, turns: [] };
const SKIPPED: Reading = { hasHeader: false, results: [], skipped: true, turns: [] };

/** The values of the `Some`s `f` returns, in order. */
const choose = <A, B>(
  xs: ReadonlyArray<A>,
  f: (a: A, index: number) => Option.Option<B>,
): ReadonlyArray<B> => Array.getSomes(Array.map(xs, f));

const linesOf = (text: string): ReadonlyArray<string> => String.split(text, /\r?\n/u);

/** The lines a diff adds or removes, by their marker. */
const markedLines = (lines: ReadonlyArray<string>, marker: string): ReadonlyArray<string> =>
  choose(lines, (line) =>
    String.startsWith(marker)(line) ? Option.some(String.slice(1)(line)) : Option.none(),
  );

/** `filePath` relative to `cwd`, or nothing when it is outside it. */
const relativeTo = (cwd: string, filePath: string): Option.Option<string> => {
  const prefix = `${String.replace(/\/+$/u, "")(cwd)}/`;
  return pipe(
    Option.liftPredicate(filePath, String.startsWith(prefix)),
    Option.map(String.slice(prefix.length)),
    Option.filter(
      (path) => String.isNonEmpty(path) && !Array.contains(String.split(path, "/"), ".."),
    ),
  );
};

const editOf = (cwd: Option.Option<string>, toolUseResult: unknown): Option.Option<FileEdit> =>
  Option.gen(function* () {
    const result = yield* decodeFileResult(toolUseResult);
    const path = yield* Option.flatMap(cwd, (dir) => relativeTo(dir, result.filePath));
    const patch = Array.flatMap(
      Option.getOrElse(Option.fromUndefinedOr(result.structuredPatch), () => []),
      ({ lines }) => lines,
    );
    const created = result.type === "create" && Predicate.isNotUndefined(result.content);
    const content = pipe(
      Option.fromUndefinedOr(result.content),
      Option.map(String.replace(/\r?\n$/u, "")),
      Option.filter(String.isNonEmpty),
      Option.map(linesOf),
      Option.getOrElse((): ReadonlyArray<string> => []),
    );
    return created
      ? { added: content, path, removed: [] }
      : { added: markedLines(patch, "+"), path, removed: markedLines(patch, "-") };
  });

/** The text of a tool result's `content`: a string, or the `text` blocks of a list. */
const outputOf = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : pipe(
        Option.fromUndefinedOr(content),
        Option.map((blocks) =>
          Array.join(
            choose(blocks, (block) => Option.map(decodeText(block), ({ text }) => text)),
            "\n",
          ),
        ),
        Option.getOrElse(() => ""),
      );

/** The one-line summary of a call: its file, command or pattern. */
const targetOf = (input: unknown): Option.Option<string> =>
  Option.flatMap(decodeInput(input), (fields) =>
    Option.firstSomeOf(
      Array.map(["file_path", "notebook_path", "path", "command", "pattern", "url"], (key) =>
        Option.filter(Record.get(fields, key), Predicate.isString),
      ),
    ),
  );

const readUser = (json: unknown): Reading =>
  Option.match(decodeUser(json), {
    onNone: () => SKIPPED,
    onSome: ({ cwd, message, timestamp, toolUseResult, uuid }) => {
      const blocks = choose(Predicate.isString(message.content) ? [] : message.content, (raw) =>
        decodeBlock(raw),
      );
      const text = Predicate.isString(message.content)
        ? message.content
        : Array.join(
            choose(blocks, (block) =>
              block.type === "text" ? Option.some(block.text) : Option.none(),
            ),
            "\n",
          );
      const edit = editOf(Option.fromUndefinedOr(cwd), toolUseResult);
      return {
        hasHeader: false,
        results: choose(blocks, (block, index) =>
          block.type === "tool_result"
            ? Option.some({
                edits: index === 0 ? Option.toArray(edit) : [],
                failed: block.is_error === true,
                id: block.tool_use_id,
                output: outputOf(block.content),
              })
            : Option.none(),
        ),
        skipped: false,
        turns: String.isNonEmpty(text)
          ? [{ at: timestamp, id: uuid, kind: "prompt" as const, text }]
          : [],
      };
    },
  });

const readAssistant = (json: unknown): Reading =>
  Option.match(decodeAssistant(json), {
    onNone: () => SKIPPED,
    onSome: ({ message, timestamp, uuid }) => ({
      hasHeader: false,
      results: [],
      skipped: false,
      turns: choose(message.content, (raw, index): Option.Option<Turn> =>
        Option.flatMap(decodeBlock(raw), (block) => {
          if (block.type === "text") {
            return String.isNonEmpty(block.text)
              ? Option.some({
                  at: timestamp,
                  id: `${uuid}:${index}`,
                  kind: "reply" as const,
                  text: block.text,
                })
              : Option.none();
          }
          if (block.type === "tool_use") {
            return Option.some({
              at: timestamp,
              edits: [],
              failed: false,
              id: block.id,
              input: Option.getOrElse(encodeJson(block.input), () => ""),
              kind: "tool" as const,
              name: block.name,
              output: "",
              target: Option.getOrNull(targetOf(block.input)),
            });
          }
          return Option.none();
        }),
      ),
    }),
  });

const readLine = (line: string): Reading => {
  const json = decodeJson(line);
  const kind = Option.flatMap(json, decodeKind);
  const header = Option.isSome(Option.flatMap(json, decodeHeader));
  const reading = Option.match(Option.all({ json, kind }), {
    // Not JSON, or JSON without a type: unreadable, so counted.
    onNone: () => SKIPPED,
    onSome: ({ json: value, kind: { type } }) =>
      Match.value(type).pipe(
        Match.when("user", () => readUser(value)),
        Match.when("assistant", () => readAssistant(value)),
        Match.orElse(() => NOTHING),
      ),
  });
  return Struct.evolve(reading, { hasHeader: () => header });
};

/** A tool turn with the result its line carried. */
const withResult = (turn: Turn, results: HashMap.HashMap<string, ToolResult>): Turn =>
  turn.kind === "tool"
    ? Option.match(HashMap.get(results, turn.id), {
        onNone: () => turn,
        onSome: ({ edits, failed, output }) =>
          Struct.evolve(turn, { edits: () => edits, failed: () => failed, output: () => output }),
      })
    : turn;

/**
 * Reads a redacted Claude Code log (JSONL) into a `Session`. Prompts, replies
 * and tool calls come in log order, each tool call carrying the output and
 * file edits of its result. A line of a type the reader uses that does not
 * decode is counted in `skipped`; any other type is ignored. A log with no
 * line holding a type, a uuid and a message has `format: "unknown"`.
 */
export const sessionOf = (log: string, stored: StoredSession): Session => {
  const readings = Array.map(
    Array.filter(linesOf(log), (line) => String.isNonEmpty(String.trim(line))),
    readLine,
  );
  const results = HashMap.fromIterable(
    Array.map(
      Array.flatMap(readings, ({ results: found }) => found),
      (result) => [result.id, result] as const,
    ),
  );
  return {
    format: Array.some(readings, ({ hasHeader }) => hasHeader) ? "claude-code" : "unknown",
    id: stored.id,
    notes: stored.notes,
    redactions: stored.redactions,
    skipped: Array.length(Array.filter(readings, ({ skipped }) => skipped)),
    taskId: stored.taskId,
    turns: pipe(
      Array.flatMap(readings, ({ turns }) => turns),
      Array.dedupeWith((a, b) => a.id === b.id),
      Array.map((turn) => withResult(turn, results)),
    ),
    version: 1,
  };
};
