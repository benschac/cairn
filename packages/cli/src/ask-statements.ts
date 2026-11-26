import { PrdSectionId } from "@cairn/contract";
import type { Section, StatementId } from "@cairn/contract";
import { itemsOf, sectionsOf, settle, statementsOf, withDrafts } from "@cairn/core";
import type { DraftAnswer } from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  HashSet,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  Terminal,
  pipe,
} from "effect";
import { TerminalCapabilities } from "effect/cli";

import { Planner } from "./planner.ts";

/** What `cairn plan` asks about each draft statement. */
export const DRAFT_QUESTION = "Is this what you meant? [a]ccept, [r]ewrite, [d]elete, [s]kip:";
/** What it asks for after `r`. */
export const REWRITE_QUESTION = "Your words:";

/**
 * The warning that ends a run that planned against `count` drafts. A part run counts only the
 * part's (`spec.planning.planning-a-part`).
 */
export const draftWarning = (count: number, inPart = false) =>
  inPart
    ? `Warning: planned against ${count} draft statement(s) in this part.`
    : `Warning: planned against ${count} draft statement(s). Confirm them in .cairn/prd.md, or run cairn plan again to be asked.`;

/** The IDs a part run is held to, or none for a run of the whole PRD: a statement counts when its owner is among them. */
export type Owners = Option.Option<HashSet.HashSet<string>>;

const ownedBy = (owners: Owners) => (owner: string) =>
  Option.match(owners, { onNone: () => true, onSome: (ids) => HashSet.has(ids, owner) });

const decodePrdSectionId = Schema.decodeUnknownOption(PrdSectionId);

/** The statements of `prd`, with the sections and items they were read from. */
const readOf = (prd: string) => {
  const sections = sectionsOf(prd);
  const items = itemsOf(prd, sections);
  return { items, sections, statements: statementsOf(prd, sections, items) };
};

/** The number of drafts `prd` still has: statements that begin `Draft:`, and with `owners`, those they own. */
export const draftCountOf = (prd: string, owners: Owners = Option.none()): number =>
  Array.length(
    Array.filter(readOf(prd).statements, ({ draft, owner }) => draft && ownedBy(owners)(owner)),
  );

/**
 * The parts of `prd` to draft statements for, in document order: every section but the level 1
 * heading, and every list item, that has an ID and no statement. With `only`, just the sections
 * and items named there (planning again names the sections nothing covers, a part run the part).
 */
export const targetsOf = (
  prd: string,
  only: Option.Option<ReadonlyArray<string>>,
): ReadonlyArray<PrdSectionId> => {
  const { items, sections, statements } = readOf(prd);
  const described = HashSet.fromIterable<string>(Array.map(statements, ({ owner }) => owner));
  const named = ({ id }: { readonly id: string | undefined }) =>
    Option.match(only, {
      onNone: () => true,
      onSome: (ids) => Array.some(ids, (found) => found === id),
    });
  const candidates = Array.appendAll(
    Array.map(
      Array.filter(sections, (section) => section.level > 1 && named(section)),
      ({ id, line }) => ({ id, line }),
    ),
    Array.map(Array.filter(items, named), ({ id, line }) => ({ id, line })),
  );
  return pipe(
    Array.sort(
      candidates,
      Order.mapInput(Order.Number, ({ line }: { readonly line: number }) => line),
    ),
    Array.filter(({ id }) => id !== undefined && !HashSet.has(described, id)),
    Array.map(({ id }) => decodePrdSectionId(id)),
    Array.getSomes,
  );
};

/**
 * Asks the planner for drafts for `targets` and writes them into `prd` with `save`, which is
 * given the whole new text. Returns the new text; with no targets it asks nothing.
 */
export const draftStatements = <E, R>(
  prd: string,
  targets: ReadonlyArray<PrdSectionId>,
  save: (prd: string) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    if (!Array.isReadonlyArrayNonEmpty(targets)) {
      return prd;
    }
    const planner = yield* Planner;
    const replies = yield* planner.statements(prd, targets);
    const drafted = withDrafts(prd, replies);
    if (Array.isReadonlyArrayNonEmpty(drafted.added)) {
      yield* save(drafted.markdown);
      yield* Effect.forEach(drafted.added, (id) => Console.log(`Drafted ${id}`), {
        discard: true,
      });
    }
    return drafted.markdown;
  });

/** A draft that waits for an answer, with the title of the section it is in. */
interface Pending {
  readonly id: StatementId;
  readonly title: string;
  /** The draft's words, without `Draft: `. */
  readonly words: string;
}

/** The title of the section `owner` is, or of the section the item `owner` is in. */
const titleOf = (
  sections: ReadonlyArray<Section>,
  items: ReturnType<typeof readOf>["items"],
  owner: string,
): string =>
  pipe(
    Array.findFirst(sections, (section) => section.id === owner),
    Option.orElse(() =>
      pipe(
        Array.findFirst(items, (item) => item.id === owner),
        Option.flatMap((item) =>
          Array.findFirst(sections, (section) => section.id === item.section),
        ),
      ),
    ),
    Option.match({ onNone: () => owner, onSome: ({ title }) => title }),
  );

/** The drafts of `prd` that have an ID, in document order; with `owners`, only the ones they own. */
const pendingOf = (prd: string, owners: Owners): ReadonlyArray<Pending> => {
  const { items, sections, statements } = readOf(prd);
  return Array.filterMap(statements, ({ draft, id, owner, text }) =>
    draft && id !== undefined && ownedBy(owners)(owner)
      ? Result.succeed({
          id,
          title: titleOf(sections, items, owner),
          words: String.replace(/^Draft: /u, "")(text),
        })
      : Result.failVoid,
  );
};

/** What a line of input stands for. Anything else leaves the draft as it is. */
const CHOICES: Readonly<Record<string, "accept" | "delete" | "rewrite">> = {
  a: "accept",
  accept: "accept",
  d: "delete",
  delete: "delete",
  r: "rewrite",
  rewrite: "rewrite",
};

const SKIP: DraftAnswer = { _tag: "skip" };

/** The state of a run of questions: the PRD as it is, the title last shown, and whether the person has quit. */
interface Asked {
  readonly prd: string;
  readonly quit: boolean;
  readonly shown: Option.Option<string>;
}

/**
 * Whether this run asks: not with `--yes` or `--dry-run`, and not when stdin or stdout is not a
 * terminal, which `TerminalCapabilities.canPrompt` says.
 */
const asks = Effect.fn("askStatements.asks")(function* (options: {
  readonly dryRun?: boolean | undefined;
  readonly yes: boolean;
}) {
  const { canPrompt } = yield* TerminalCapabilities.TerminalCapabilities;
  return canPrompt && !options.yes && options.dryRun !== true;
});

/**
 * Asks about each draft of `prd` in document order: its section's title once, then the draft, then
 * whether it is what the person meant. `save` writes the PRD after each answer, so an interrupted
 * run keeps what was answered. A run that does not ask (see `asks`) leaves every draft as it is.
 * An empty rewrite, an answer that is none of the four and the end of input leave the draft
 * alone; the end of input also stops the questions. With `owners`, a part run asks only about the
 * drafts they own, and a draft outside them is not asked about or changed. Returns the PRD as it
 * is after the answers.
 */
export const askStatements = Effect.fn("askStatements")(function* <E, R>(
  prd: string,
  options: { readonly dryRun?: boolean | undefined; readonly yes: boolean },
  save: (prd: string) => Effect.Effect<void, E, R>,
  owners: Owners = Option.none(),
) {
  const pending = pendingOf(prd, owners);
  if (!Array.isReadonlyArrayNonEmpty(pending) || !(yield* asks(options))) {
    return prd;
  }
  const terminal = yield* Terminal.Terminal;
  /** The next line the person types: none at the end of input. */
  const line = (question: string) =>
    terminal.display(`${question} `).pipe(
      Effect.andThen(terminal.readLine),
      Effect.map((typed) => Option.some(String.trim(typed))),
      Effect.catchTag("QuitError", () => Effect.succeed(Option.none<string>())),
    );
  const end = yield* Effect.reduce(
    pending,
    (): Asked => ({ prd, quit: false, shown: Option.none() }),
    (state, { id, title, words }) =>
      Effect.gen(function* () {
        if (state.quit) {
          return state;
        }
        if (!Option.contains(state.shown, title)) {
          yield* Console.log(title);
        }
        yield* Console.log(`  ${words}`);
        const typed = yield* line(DRAFT_QUESTION);
        const [answer, quit]: readonly [DraftAnswer, boolean] = yield* Option.match(typed, {
          onNone: () => Effect.succeed([SKIP, true] as const),
          onSome: (text) =>
            Option.match(Record.get(CHOICES, String.toLowerCase(text)), {
              onNone: () => Effect.succeed([SKIP, false] as const),
              onSome: (picked) =>
                picked === "rewrite"
                  ? Effect.map(
                      line(REWRITE_QUESTION),
                      Option.match({
                        onNone: () => [SKIP, true] as const,
                        onSome: (own) => [{ _tag: "rewrite", text: own }, false] as const,
                      }),
                    )
                  : Effect.succeed([{ _tag: picked }, false] as const),
            }),
        });
        const next = settle(state.prd, id, answer);
        if (next !== state.prd) {
          yield* save(next);
        }
        return { prd: next, quit, shown: Option.some(title) };
      }),
  );
  return end.prd;
});
