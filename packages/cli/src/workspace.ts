import { Event, EventJson, Manifest, SpecIndex, SpecIndexJson } from "@cairn/contract";
import {
  Array,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
  SchemaIssue,
  String,
} from "effect";

import { MainCheckout, type NotARepository } from "./main-checkout.ts";

export const CAIRN_DIRECTORY = ".cairn";

/** A file Cairn needs is not in `.cairn/`, as opposed to being there and malformed. */
export class MissingFile extends Schema.TaggedError<
  MissingFile,
  { readonly brand: unique symbol }
>()("MissingFile", {
  file: Schema.String,
}) {
  override get message() {
    return `${this.file} does not exist`;
  }
}

/** A file is there but the operating system would not give it to us. */
export class UnreadableFile extends Schema.TaggedError<
  UnreadableFile,
  { readonly brand: unique symbol }
>()("UnreadableFile", {
  file: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.file} could not be read: ${this.reason}`;
  }
}

/**
 * A file is there but does not decode through the contract. `line` is the 1-based line
 * of `events.jsonl` and is none for a whole-file JSON document; `path` is the dotted
 * field path inside the document or line (empty when the text is not JSON at all).
 */
export class MalformedFile extends Schema.TaggedError<
  MalformedFile,
  { readonly brand: unique symbol }
>()("MalformedFile", {
  file: Schema.String,
  line: Schema.Option(Schema.Int),
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    const where = Option.match(this.line, {
      onNone: () => this.file,
      onSome: (line) => `${this.file}:${line}`,
    });
    return `${where}${String.isEmpty(this.path) ? "" : ` at ${this.path}`}: ${this.detail}`;
  }
}

export type WorkspaceError = MissingFile | UnreadableFile | MalformedFile;

const ManifestJson = Schema.fromJsonString(Manifest);

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** Every problem the schema found, as one error naming the file, the line and the first problem's field path. */
const malformed = (file: string, line: Option.Option<number>, error: Schema.SchemaError) => {
  const issues = formatIssue(error.issue).issues;
  const first = Array.head(issues);
  return new MalformedFile({
    detail: Array.join(
      Array.map(issues, (issue) => issue.message),
      "; ",
    ),
    file,
    line,
    path: Option.match(first, {
      onNone: () => "",
      onSome: (issue) =>
        Array.join(
          Array.map(
            Option.getOrElse(Option.fromNullishOr(issue.path), () => []),
            (segment) => (Predicate.isPropertyKey(segment) ? segment : segment.key).toString(),
          ),
          ".",
        ),
    }),
  });
};

/** Reads `.cairn/<name>`: none when the file is absent. */
const readText = Effect.fn("workspace.readText")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const file = path.join(root, CAIRN_DIRECTORY, name);
  return yield* fs.exists(file).pipe(
    Effect.flatMap((present) =>
      present ? Effect.asSome(fs.readFileString(file)) : Effect.succeedNone,
    ),
    Effect.mapError((error) => new UnreadableFile({ file, reason: error.message })),
    Effect.map((text) => ({ file, text })),
  );
});

const decodeDocument =
  <S extends Schema.Decoder<unknown> & { readonly Encoded: string }>(schema: S) =>
  (file: string, text: string): Effect.Effect<S["Type"], MalformedFile, S["DecodingServices"]> =>
    Schema.decodeEffect(schema)(text).pipe(
      Effect.mapError((error) => malformed(file, Option.none(), error)),
    );

type Loaded<A> = Effect.Effect<
  A,
  WorkspaceError | NotARepository,
  FileSystem.FileSystem | Path.Path | MainCheckout
>;

/** A required file: absent is `MissingFile`. */
const required = <A>(
  name: string,
  decode: (file: string, text: string) => Effect.Effect<A, MalformedFile>,
): Loaded<A> =>
  readText(name).pipe(
    Effect.flatMap(({ file, text }) =>
      Effect.fromOption(text).pipe(
        Effect.mapError(() => new MissingFile({ file })),
        Effect.flatMap((content) => decode(file, content)),
      ),
    ),
  );

/** An optional file: absent is none. */
const optional = <A>(
  name: string,
  decode: (file: string, text: string) => Effect.Effect<A, MalformedFile>,
): Loaded<Option.Option<A>> =>
  readText(name).pipe(
    Effect.flatMap(({ file, text }) =>
      Option.match(text, {
        onNone: () => Effect.succeed(Option.none<A>()),
        onSome: (content) => decode(file, content).pipe(Effect.asSome),
      }),
    ),
  );

/** `.cairn/prd.md` as text. Absent is `MissingFile`. */
export const loadPrd: Loaded<string> = required("prd.md", (_file, text) => Effect.succeed(text));

/** `.cairn/spec.md` as text. Absent is `MissingFile`. */
export const loadSpec: Loaded<string> = required("spec.md", (_file, text) => Effect.succeed(text));

/** `.cairn/manifest.json`. Absent is `MissingFile`; a wrong field is `MalformedFile` with its path. */
export const loadManifest: Loaded<Manifest> = required(
  "manifest.json",
  decodeDocument(ManifestJson),
);

/** `.cairn/spec.json`, the spec index. Absent is none: it is derived and `cairn plan` writes it. */
export const loadSpecIndex: Loaded<Option.Option<SpecIndex>> = optional(
  "spec.json",
  decodeDocument(SpecIndexJson),
);

/**
 * `.cairn/events.jsonl`, one event per line, oldest first. Absent, empty and blank
 * lines (a trailing newline) are no events. A bad line fails with its 1-based number.
 */
export const loadEvents: Loaded<ReadonlyArray<Event>> = readText("events.jsonl").pipe(
  Effect.flatMap(({ file, text }) =>
    Effect.forEach(
      Array.filter(
        Array.map(String.split("\n")(Option.getOrElse(text, () => "")), (content, index) => ({
          content,
          line: index + 1,
        })),
        ({ content }) => !String.isEmpty(String.trim(content)),
      ),
      ({ content, line }) =>
        Schema.decodeEffect(EventJson)(content).pipe(
          Effect.mapError((error) => malformed(file, Option.some(line), error)),
        ),
    ),
  ),
);
