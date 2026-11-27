import { PrdSectionId } from "@cairn/contract";
import type { Config, Section, StatementId } from "@cairn/contract";
import {
  draftQuestions,
  itemsOf,
  partQuestions,
  sectionsOf,
  settle,
  statementsOf,
  withDrafts,
  yesNoOf,
} from "@cairn/core";
import type { DraftAnswer, DraftInput, Drafted, PartInput } from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  Equal,
  HashSet,
  Match,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  Terminal,
  pipe,
} from "effect";
import type { Decision } from "effect/ai";
import { TerminalCapabilities } from "effect/cli";

import { Judge } from "./judge.ts";
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

/** What the judge reads of `id`: a section's title, its own body and its child headings, or an item's text. */
const partInputOf = (read: ReturnType<typeof readOf>, id: string): PartInput => {
  const { items, sections } = read;
  return pipe(
    Array.findFirst(sections, (section) => section.id === id),
    Option.map(({ body, title }): PartInput => ({
      body,
      children: Array.map(
        Array.filter(sections, (child) => child.parent === id),
        ({ title: childTitle }) => childTitle,
      ),
      id,
      title,
    })),
    Option.orElse(() =>
      Option.map(
        Array.findFirst(items, (item) => item.id === id),
        ({ text }): PartInput => ({
          body: text,
          children: Array.map(
            Array.filter(items, (child) => child.parent === id),
            (child) => child.text,
          ),
          id,
          title: text,
        }),
      ),
    ),
    Option.getOrElse((): PartInput => ({ body: "", children: [], id, title: id })),
  );
};

/** The line the plan prints for a target that is left out. */
export const noDraftLine = (id: string, probability: number) =>
  `no draft  ${id} (describes nothing to build, ${probability.toFixed(2)})`;

/**
 * The targets to draft for (`spec.planning.done-when.judging-drafts`): asks the judge
 * `partQuestions` about each, and leaves out, printing it, a target whose `describesBuild`
 * reads `no`. `unsure`, unanswered, a failed judge and no judge keep every target, and a run with
 * no judge does not ask.
 */
export const partsToDraft = Effect.fn("askStatements.partsToDraft")(function* (
  prd: string,
  targets: ReadonlyArray<PrdSectionId>,
  thresholds: Pick<Config["judge"], "flag" | "pass">,
) {
  const judge = yield* Effect.serviceOption(Judge);
  if (Option.isNone(judge) || !Array.isReadonlyArrayNonEmpty(targets)) {
    return targets;
  }
  const read = readOf(prd);
  const outcomes = yield* judge.value
    .ask(
      partQuestions,
      Array.map(targets, (id) => ({ input: partInputOf(read, id), label: id })),
    )
    .pipe(
      Effect.catchTag("JudgeError", (error) =>
        Console.log(`Judging failed: ${error.message}`).pipe(Effect.as([])),
      ),
    );
  const left = Array.filterMap(Array.zip(targets, outcomes), ([id, { describesBuild }]) =>
    Result.match(describesBuild, {
      onFailure: () => Result.failVoid,
      onSuccess: ({ probability }) =>
        yesNoOf(describesBuild, thresholds) === "no"
          ? Result.succeed({ id, probability })
          : Result.failVoid,
    }),
  );
  yield* Effect.forEach(left, ({ id, probability }) => Console.log(noDraftLine(id, probability)), {
    discard: true,
  });
  return Array.filter(targets, (id) => !Array.some(left, (gone) => gone.id === id));
});

/** The PRD after drafting, and the IDs of the drafts that run added to it. */
export interface Drafts {
  readonly added: ReadonlyArray<StatementId>;
  readonly markdown: string;
}

/**
 * Asks the planner for drafts for `targets` and writes them into `prd` with `save`, which is
 * given the whole new text. Returns the new text and the IDs it added; with no targets it asks
 * nothing.
 */
export const draftStatements = <E, R>(
  prd: string,
  targets: ReadonlyArray<PrdSectionId>,
  save: (prd: string) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    if (!Array.isReadonlyArrayNonEmpty(targets)) {
      return { added: [], markdown: prd };
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
    return { added: drafted.added, markdown: drafted.markdown };
  });

/** A draft that waits for an answer, with the title of the section it is in. */
interface Pending {
  readonly id: StatementId;
  /** The section or item the draft is under. */
  readonly owner: PrdSectionId;
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
          owner,
          title: titleOf(sections, items, owner),
          words: String.replace(/^Draft: /u, "")(text),
        })
      : Result.failVoid,
  );
};

/** The judge's note lines under drafts, by the draft's ID. They are printed and never written. */
export type Notes = Readonly<Record<string, string>>;

/** The answers a note reads: each of `draftQuestions`' decisions. */
type DraftOutcomes = Readonly<
  Record<
    "faithful" | "namesImplementation" | "needsPerson" | "observable",
    Decision.Outcome<Decision.Probability>
  >
>;

/** What a note says of each answer that reads yes or no, in the order a note lists them. */
const NOTE_WORDS = [
  {
    after: "",
    name: "faithful",
    no: "does not say what the section asks",
    yes: "says what the section asks",
  },
  {
    after: "",
    name: "namesImplementation",
    no: "names no file, function or test",
    yes: "names a file, function or test",
  },
  { after: "", name: "observable", no: "a person could not see it", yes: "a person could see it" },
  {
    after: ", consider <!-- human -->",
    name: "needsPerson",
    no: "a test could settle it",
    yes: "only a person can settle it",
  },
] as const;

/** The line under a draft for the answers that are not `unsure`, or none when every answer is. */
const noteOf = (
  outcomes: DraftOutcomes,
  thresholds: Pick<Config["judge"], "flag" | "pass">,
): Option.Option<string> =>
  Array.match(
    Array.filterMap(NOTE_WORDS, ({ after, name, no, yes }) =>
      Result.match(outcomes[name], {
        onFailure: () => Result.failVoid,
        onSuccess: ({ probability }) =>
          Match.value(yesNoOf(outcomes[name], thresholds)).pipe(
            Match.when("yes", () => Result.succeed(`${yes} (${probability.toFixed(2)})${after}`)),
            Match.when("no", () => Result.succeed(`${no} (${probability.toFixed(2)})`)),
            Match.orElse(() => Result.failVoid),
          ),
      }),
    ),
    {
      onEmpty: () => Option.none(),
      onNonEmpty: (parts) => Option.some(`  judge: ${Array.join(parts, " · ")}`),
    },
  );

/**
 * `prd` without its statements: each one with an ID is deleted as `settle` deletes it, with the
 * `Done when:` line its list leaves empty. What is left is what the sections and items ask for, so
 * a judge asked whether a statement says what its section asks does not read the statement in it.
 */
const withoutStatements = (prd: string): string =>
  Array.reduce(
    Array.getSomes(Array.map(readOf(prd).statements, ({ id }) => Option.fromUndefinedOr(id))),
    prd,
    (text, id) => settle(text, id, { _tag: "delete" }),
  );

/** What the judge reads of a draft: its words, and its section's title and own body, read from a PRD `withoutStatements`. */
const draftInputOf = (
  read: ReturnType<typeof readOf>,
  owner: string,
  words: string,
): DraftInput => {
  const { body, children, title } = partInputOf(read, owner);
  // An item's own body is its text and the items nested under it; a section's children are headings.
  const nested = Array.some(read.items, ({ id }) => id === owner) ? children : [];
  return {
    section: {
      body: Array.join(
        Array.prepend(
          Array.map(nested, (text) => `- ${text}`),
          body,
        ),
        "\n",
      ),
      title,
    },
    statement: words,
  };
};

/** A part's drafts that name code: their IDs and words, as the judge read them. */
interface Refused {
  readonly ids: ReadonlyArray<StatementId>;
  readonly target: PrdSectionId;
  readonly words: ReadonlyArray<string>;
}

/**
 * The text of `withDrafts`' result with a new `Done when:` list folded into the list of the same
 * owner right above it, so a part that kept some drafts keeps one list: the new list's `Done when:`
 * line and the blank lines around it are dropped, and its drafts follow the kept ones.
 */
const joinedLists = ({
  inserted,
  markdown,
}: {
  readonly inserted: ReadonlyArray<number>;
  readonly markdown: string;
}): string => {
  const { statements } = readOf(markdown);
  // A row is index `row`, and line `row + 1` to the parser.
  const ownerAt = (row: number) =>
    Option.map(
      Array.findFirst(statements, ({ line }) => line === row + 1),
      ({ owner }) => owner,
    );
  const lines = String.split("\n")(markdown);
  const dropped = Array.flatMap(
    Array.filter(
      inserted,
      (row) =>
        Array.get(lines, row).pipe(Option.exists((line) => String.trim(line) === "Done when:")) &&
        Option.isSome(ownerAt(row - 2)) &&
        Equal.equals(ownerAt(row - 2), ownerAt(row + 2)),
    ),
    (row: number) => [row - 1, row, row + 1],
  );
  return Array.join(
    Array.filter(lines, (_, row) => !Array.contains(dropped, row)),
    "\n",
  );
};

/**
 * Sends `refused` back to the planner once, with the drafts as its reply. Each part that comes
 * back with words has its refused drafts replaced by them; a part that comes back with none, and a
 * planner that fails, leave the drafts as they were. Returns the PRD, the IDs it added and the IDs
 * it replaced.
 */
const redrafted = Effect.fn("askStatements.redrafted")(function* (
  prd: string,
  refused: ReadonlyArray<Refused>,
) {
  const planner = yield* Planner;
  const replies = yield* planner
    .statements(
      prd,
      Array.map(refused, ({ target }) => target),
      Array.map(refused, ({ target, words }): Drafted => ({ drafts: words, target })),
    )
    .pipe(
      Effect.catchTag("PlannerError", (error) =>
        Console.log(`Drafting again failed: ${error.reason}`).pipe(
          Effect.as(Array.empty<Drafted>()),
        ),
      ),
    );
  const written = withDrafts(prd, replies).added;
  const replacing = Array.filter(refused, ({ target }) =>
    Array.some(written, String.startsWith(`${target}#v`)),
  );
  const replaced = Array.flatMap(replacing, ({ ids }) => ids);
  const cleared = Array.reduce(replaced, prd, (text, id) => settle(text, id, { _tag: "delete" }));
  const final = withDrafts(
    cleared,
    Array.filter(replies, ({ target }) =>
      Array.some(replacing, (found) => found.target === target),
    ),
  );
  return { added: final.added, markdown: joinedLists(final), replaced };
});

/** What `judgeDrafts` leaves for the questions: the PRD, and the judge's notes on its drafts. */
export interface Judged {
  readonly notes: Notes;
  readonly prd: string;
}

/**
 * After drafting (`spec.planning.done-when.judging-drafts`), asks the judge `draftQuestions` about
 * each draft this run added, and, when this run asks, each draft left from an earlier one that
 * `owners` holds. A new draft whose `namesImplementation` reads `yes` goes back to the planner
 * once, in a follow-up turn that quotes it and the rule; the replacement takes its place and is not
 * sent back again (it is judged for its notes only), and a planner that fails leaves the draft as it was. A run that asks gets a note
 * for each draft that has an answer which is not `unsure`, and notes are never written to the PRD:
 * no answer accepts, rewrites, deletes or tags a statement. With no judge, or a judge that fails,
 * it changes nothing.
 */
export const judgeDrafts = Effect.fn("askStatements.judgeDrafts")(function* <E, R>(
  drafted: Drafts,
  options: { readonly dryRun?: boolean | undefined; readonly yes: boolean },
  save: (prd: string) => Effect.Effect<void, E, R>,
  owners: Owners,
  thresholds: Pick<Config["judge"], "flag" | "pass">,
) {
  const unjudged: Judged = { notes: {}, prd: drafted.markdown };
  const judge = yield* Effect.serviceOption(Judge);
  if (Option.isNone(judge)) {
    return unjudged;
  }
  const noting = yield* asks(options);
  const pending = Array.filter(
    pendingOf(drafted.markdown, owners),
    ({ id }) => noting || Array.contains(drafted.added, id),
  );
  if (!Array.isReadonlyArrayNonEmpty(pending)) {
    return unjudged;
  }
  /** The judge's answers about `drafts` of `prd`, none when it fails. */
  const answersAbout = Effect.fn("askStatements.answersAbout")(function* (
    prd: string,
    drafts: ReadonlyArray<Pending>,
  ) {
    const read = readOf(withoutStatements(prd));
    const outcomes = yield* judge.value
      .ask(
        draftQuestions,
        Array.map(drafts, ({ id, owner, words }) => ({
          input: draftInputOf(read, owner, words),
          label: id,
        })),
      )
      .pipe(
        Effect.catchTag("JudgeError", (error) =>
          Console.log(`Judging failed: ${error.message}`).pipe(Effect.as([])),
        ),
      );
    return Array.zip(drafts, outcomes);
  });
  const answered = yield* answersAbout(drafted.markdown, pending);
  const refused = Array.map(
    Record.values(
      Array.groupBy(
        Array.filter(
          answered,
          ([{ id }, { namesImplementation }]) =>
            Array.contains(drafted.added, id) && yesNoOf(namesImplementation, thresholds) === "yes",
        ),
        ([{ owner }]) => owner,
      ),
    ),
    (group) => ({
      ids: Array.map(group, ([{ id }]) => id),
      target: Array.headNonEmpty(group)[0].owner,
      words: Array.map(group, ([{ words }]) => words),
    }),
  );
  const again = Array.isReadonlyArrayNonEmpty(refused)
    ? yield* redrafted(drafted.markdown, refused)
    : { added: [], markdown: drafted.markdown, replaced: [] };
  if (again.markdown !== drafted.markdown) {
    yield* save(again.markdown);
    yield* Effect.forEach(again.added, (id) => Console.log(`Drafted ${id} again`), {
      discard: true,
    });
  }
  // A note about a draft that was replaced is about words gone. A replacement is judged for its
  // notes alone: nothing sends it back.
  const replacements = noting
    ? Array.filter(pendingOf(again.markdown, owners), ({ id }) => Array.contains(again.added, id))
    : [];
  const kept = Array.filter(answered, ([{ id }]) => !Array.contains(again.replaced, id));
  const replaced = Array.isReadonlyArrayNonEmpty(replacements)
    ? yield* answersAbout(again.markdown, replacements)
    : [];
  const judged = Array.appendAll(kept, replaced);
  const notes = noting
    ? Record.fromEntries(
        Array.getSomes(
          Array.map(judged, ([{ id }, outcome]) =>
            Option.map(noteOf(outcome, thresholds), (line) => [id, line] as const),
          ),
        ),
      )
    : {};
  return { notes, prd: again.markdown } satisfies Judged;
});

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
 * drafts they own, and a draft outside them is not asked about or changed. `notes` are the judge's
 * lines (`judgeDrafts`), each printed under its draft and never written. Returns the PRD as it
 * is after the answers.
 */
export const askStatements = Effect.fn("askStatements")(function* <E, R>(
  prd: string,
  options: { readonly dryRun?: boolean | undefined; readonly yes: boolean },
  save: (prd: string) => Effect.Effect<void, E, R>,
  owners: Owners = Option.none(),
  notes: Notes = {},
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
        yield* Option.match(Record.get(notes, id), {
          onNone: () => Effect.void,
          onSome: (note) => Console.log(note),
        });
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
