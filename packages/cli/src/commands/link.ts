import type { Manifest, Sha } from "@cairn/contract";
import { sectionIdsOf } from "@cairn/core";
import { Array, Console, Effect, Layer, Option, Record, Stdio, Struct, pipe } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { layer as gitLayer } from "../git-live.ts";
import { Git } from "../git.ts";
import { pathOfArgs } from "../link-args.ts";
import type { LinkPlan } from "../link-args.ts";
import { MainCheckout } from "../main-checkout.ts";
import { loadManifest, loadPrd, loadSpec } from "../workspace.ts";

/** The port `cairn serve` uses. */
export const DEFAULT_BASE = "http://localhost:4310";

/** What `cairn link` and `cairn note add` check their arguments against, read from the repository. */
export const planOf = Effect.gen(function* () {
  const git = yield* Git;
  const [prd, spec, manifest] = yield* Effect.all([loadPrd, loadSpec, loadManifest]);
  const commits = yield* git.log(manifest);
  return {
    commits: Record.fromIterableWith(commits, ({ sha, taskId }) => [sha, taskId] as const),
    sections: Array.appendAll(sectionIdsOf(prd), sectionIdsOf(spec)),
    tasks: Record.fromIterableWith(manifest.tasks, (task: Manifest["tasks"][number]) => [
      task.id,
      {
        commits: Array.map(
          Array.filter(commits, ({ taskId }) => taskId === task.id),
          ({ sha }): Sha => sha,
        ),
        parent: task.parent,
      },
    ]),
  } satisfies LinkPlan;
});

/** The arguments after the `link` subcommand, in the order they were typed. */
const tokensAfterLink = Effect.map(
  Effect.flatMap(Stdio.Stdio, ({ args }) => args),
  (args) =>
    pipe(
      Array.findFirstIndex(args, (arg) => arg === "link"),
      Option.match({ onNone: () => [], onSome: (at) => Array.drop(args, at + 1) }),
    ),
);

/**
 * `cairn link`: prints the link the `tokens` name, after `base` (the path alone for an empty
 * `base`). It reads files and git and never writes. A token it refuses fails the command, which
 * exits 1.
 */
export const link = Effect.fn("link")(function* (options: {
  readonly base: string;
  readonly tokens: ReadonlyArray<string>;
}) {
  const plan = yield* planOf;
  const path = yield* Effect.fromResult(pathOfArgs(options.tokens, plan));
  yield* Console.log(`${options.base}${path}`);
});

/** The link arguments `cairn link` and `cairn note add` take, declared so `effect/cli` accepts them; each command reads them in order from the argv. */
export const linkArguments = {
  commit: Flag.String("commit").pipe(
    Flag.withDescription("A commit, by its full sha"),
    Flag.atLeast(0),
  ),
  file: Flag.String("file").pipe(
    Flag.withDescription("A file in the diff or commit before it"),
    Flag.atLeast(0),
  ),
  line: Flag.String("line").pipe(
    Flag.withDescription("A line, 40, or a range, 40-42, in the file before it"),
    Flag.atLeast(0),
  ),
  note: Flag.String("note").pipe(Flag.withDescription("A note, by its id"), Flag.atLeast(0)),
  old: Flag.Boolean("old").pipe(
    Flag.withDescription("Put the --line that follows on the old side of the diff"),
    Flag.withDefault(false),
  ),
  passage: Flag.String("passage").pipe(
    Flag.withDescription("Text quoted from the section right before it"),
    Flag.atLeast(0),
  ),
  refs: Argument.String("ref").pipe(
    Argument.withDescription("A section ID or a task ID, in the order to link them"),
    Argument.variadic(),
  ),
  segment: Flag.String("segment").pipe(
    Flag.withDescription("The finished trunk of the stack a root task starts"),
    Flag.atLeast(0),
  ),
  stack: Flag.String("stack").pipe(
    Flag.withDescription("The stack a root task starts"),
    Flag.atLeast(0),
  ),
  turn: Flag.String("turn").pipe(
    Flag.withDescription("A turn of an agent session, as <session>/<turn>"),
    Flag.atLeast(0),
  ),
};

export const linkCommand = Command.make(
  "link",
  Struct.assign(linkArguments, {
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "The origin to print before the path; an empty value prints the path alone",
      ),
      Flag.withDefault(DEFAULT_BASE),
    ),
  }),

  ({ base }) =>
    Effect.flatMap(tokensAfterLink, (tokens) => link({ base, tokens })).pipe(
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const root = yield* (yield* MainCheckout).root;
            return gitLayer(root);
          }),
        ),
      ),
    ),
).pipe(
  Command.withDescription("Print a link into the viewer to a section, task, commit, file or line"),
);
