import { LinkFromPath, NoteId, SessionId, TaskStep } from "@cairn/contract";
import type { Step } from "@cairn/contract";
import { NoteKind } from "@cairn/contract";
import {
  Array,
  Console,
  Effect,
  Layer,
  Option,
  Schema,
  Stdio,
  Stream,
  String,
  Struct,
  flow,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { layer as gitLayer } from "../git-live.ts";
import { LinkArgError, stepsOfArgs } from "../link-args.ts";
import { MainCheckout } from "../main-checkout.ts";
import { TraceStore } from "../trace-store.ts";
import { DEFAULT_BASE, linkArguments, planOf } from "./link.ts";

/** The flags that are the note's own, not link arguments. */
const OWN_FLAGS = ["--author", "--body", "--kind", "--session"];

/**
 * The tokens without the note's own flags, as `--flag value` and as `--flag=value`. What is left are
 * the link arguments, because `stepsOfArgs` refuses a flag it does not know.
 */
const withoutOwnFlags = (tokens: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.match(tokens, {
    onEmpty: () => [],
    onNonEmpty: ([token, ...rest]) =>
      Option.match(String.match(/^(--[^=]+)(=.*)?$/su)(token), {
        onNone: () => Array.prepend(withoutOwnFlags(rest), token),
        onSome: ([, name = token, inline]) =>
          Array.contains(OWN_FLAGS, name)
            ? withoutOwnFlags(inline === undefined ? Array.drop(rest, 1) : rest)
            : Array.prepend(withoutOwnFlags(rest), token),
      }),
  });

/** The arguments after the first `word`. */
const afterWord =
  (word: string) =>
  (args: ReadonlyArray<string>): ReadonlyArray<string> =>
    Option.match(
      Array.findFirstIndex(args, (arg) => arg === word),
      { onNone: () => [], onSome: (at) => Array.drop(args, at + 1) },
    );

/** The arguments after `note` and then `add`, in the order they were typed. */
const tokensAfterAdd = Effect.map(
  Effect.flatMap(Stdio.Stdio, ({ args }) => args),
  flow(afterWord("note"), afterWord("add")),
);

/** All of standard input, as text. */
const readStdin = Effect.flatMap(Stdio.Stdio, ({ stdin }) =>
  Stream.mkString(Stream.decodeText(stdin)),
);

/** The id of the last task among the steps. */
const lastTaskOf = (steps: ReadonlyArray<Step>) =>
  Option.map(Array.findLast(steps, Schema.is(TaskStep)), ({ id }) => id);

/**
 * `cairn note add`: stores a note anchored at the link the `tokens` name, which may hold the note's
 * own flags too, and prints `<note id> <link to the note>`, `/note/<id>` after `DEFAULT_BASE`. The body is `body`, else standard
 * input. A link argument it refuses, or no link arguments, fails the command, which exits 1.
 */
export const noteAdd = Effect.fn("noteAdd")(function* (options: {
  readonly author: string;
  readonly body: Option.Option<string>;
  readonly kind: NoteKind;
  readonly session: Option.Option<string>;
  readonly tokens: ReadonlyArray<string>;
}) {
  const store = yield* TraceStore;
  const plan = yield* planOf;
  const steps = yield* Effect.fromResult(stepsOfArgs(withoutOwnFlags(options.tokens), plan));
  if (Array.isReadonlyArrayEmpty(steps)) {
    return yield* new LinkArgError({ reason: "a note needs link arguments to anchor it" });
  }
  const anchor = yield* Schema.encodeEffect(LinkFromPath)(steps);
  const session = yield* Option.match(options.session, {
    onNone: () => Effect.succeed(Option.none<SessionId>()),
    onSome: (id) => Effect.map(Schema.decodeUnknownEffect(SessionId)(id), Option.some),
  });
  const task = yield* Option.match(lastTaskOf(steps), {
    onNone: () =>
      Option.match(session, {
        onNone: () => Effect.succeed(null),
        onSome: (id) => Effect.map(store.get(id), ({ taskId }) => taskId),
      }),
    onSome: Effect.succeed,
  });
  const body = yield* Option.match(options.body, {
    onNone: () => readStdin,
    onSome: Effect.succeed,
  });
  const note = yield* store.addNote({
    anchor,
    author: options.author,
    body,
    kind: options.kind,
    resolvedAt: null,
    session: Option.getOrNull(session),
    status: "open",
    task,
  });
  // A `note` step ends a link and may not follow code, so the note's link is the note alone.
  const path = yield* Schema.encodeEffect(LinkFromPath)([{ id: note.id, kind: "note" as const }]);
  yield* Console.log(`${note.id} ${DEFAULT_BASE}${path}`);
  return note;
});

/** `cairn note resolve`: marks the note resolved and prints `<id> resolved`. */
export const noteResolve = Effect.fn("noteResolve")(function* (id: string) {
  const store = yield* TraceStore;
  const noteId = yield* Schema.decodeUnknownEffect(NoteId)(id);
  const note = yield* store.resolveNote(noteId);
  yield* Console.log(`${note.id} resolved`);
  return note;
});

/** The git layer of the main checkout. */
const gitOfCheckout = Layer.unwrap(
  Effect.gen(function* () {
    const root = yield* (yield* MainCheckout).root;
    return gitLayer(root);
  }),
);

const addCommand = Command.make(
  "add",
  Struct.assign(linkArguments, {
    author: Flag.String("author").pipe(
      Flag.withDescription("Who wrote it: agent:t2, human:Ada or orchestrator"),
    ),
    body: Flag.optional(
      Flag.String("body").pipe(
        Flag.withDescription("The note, as markdown; standard input when it is not given"),
      ),
    ),
    kind: Flag.Literals("kind", NoteKind.literals).pipe(Flag.withDescription("note or review")),
    session: Flag.optional(
      Flag.String("session").pipe(Flag.withDescription("The session the note hangs off")),
    ),
  }),
  ({ author, body, kind, session }) =>
    Effect.flatMap(tokensAfterAdd, (tokens) =>
      noteAdd({ author, body, kind, session, tokens }),
    ).pipe(Effect.asVoid, Effect.provide(Layer.mergeAll(TraceStore.layer, gitOfCheckout))),
).pipe(Command.withDescription("Store a note or a review finding anchored at a link"));

const resolveCommand = Command.make(
  "resolve",
  { id: Argument.String("id").pipe(Argument.withDescription("The note to resolve")) },
  ({ id }) => noteResolve(id).pipe(Effect.asVoid, Effect.provide(TraceStore.layer)),
).pipe(Command.withDescription("Mark a note resolved"));

export const noteCommand = Command.make("note").pipe(
  Command.withDescription("Add a note or a review finding, or resolve one"),
  Command.withSubcommands([addCommand, resolveCommand]),
);
