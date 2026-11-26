import type { FileEdit, Session, ToolTurn, Turn } from "@cairn/contract";
import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Array, Match, Number, Option, Order, Record, String } from "effect";

import type { CopyLinks } from "../links.ts";
import { isDemoBuild } from "../load.ts";
import { renderMarkdown } from "../markdown.ts";
import type { Message } from "../message.ts";
import { SessionData, type HighlightedTurn } from "../model.ts";
import { copyButtonView } from "./copyLinkView.ts";

/** The message constructors the session pane needs. */
export interface SessionMessages {
  /** A tool turn's line: opens it, or closes it again. */
  readonly onTurn: (id: string) => Message;
  /** An opened tool turn's button for the rest of its input and output. */
  readonly onMoreOfTurn: (id: string) => Message;
}

/** What the session pane reads of the model. */
export interface SessionState {
  readonly sessions: Record.ReadonlyRecord<string, SessionData>;
  readonly openedTurns: Record.ReadonlyRecord<string, boolean>;
  readonly fullTurns: Record.ReadonlyRecord<string, boolean>;
  /** The turn whose hunks the diff marks; its line in the pane is marked active too. */
  readonly maybeHighlightedTurn: Option.Option<HighlightedTurn>;
}

/** The session with this ID, once it has loaded. */
export const loadedSessionOf = (state: SessionState, id: string): Option.Option<Session> =>
  Option.flatMap(Record.get(state.sessions, id), (data) =>
    SessionData.match(data, {
      Failed: () => Option.none(),
      Loaded: ({ session }) => Option.some(session),
      Loading: () => Option.none(),
    }),
  );

/** An opened tool turn shows this many lines of its input and of its output until asked for more. */
export const TURN_LINE_LIMIT = 200;

/** The ID of a turn's element, which a command scrolls into view. */
export const turnElementIdOf = (id: string): string => `turn-${id}`;

/** `[REDACTED:<kind>]`. Split on it, the kinds are the odd entries. */
const REDACTION = /\[REDACTED:([^\]\s]+)\]/gu;

/** Whether the part of redacted text at this index, split on `REDACTION`, is a kind. */
const isKindAt = (index: number): boolean => Number.remainder(index, 2) === 1;

/** Text with each `[REDACTED:<kind>]` drawn as a chip naming the kind. */
const withChips = <Msg>(h: Html.H<Msg>, text: string): View.Children<Msg, never> =>
  Array.map(String.split(text, REDACTION), (part, index) =>
    isKindAt(index)
      ? h.span.class("chip").attr("data-redacted", part).children(`redacted: ${part}`)
      : part,
  );

const noteView = (h: Html.H<Message>, text: string, isAlert = false) =>
  h.p.attr("role", isAlert ? "alert" : undefined).children(text);

const redactionsView = (h: Html.H<Message>, session: Session) =>
  Array.match(
    Array.sort(
      Record.toEntries(
        Record.filter(session.redactions, (count) => Number.isGreaterThan(count, 0)),
      ),
      Order.mapInput(Order.String, ([kind]: readonly [string, number]) => kind),
    ),
    {
      onEmpty: () => h.p.attr("data-redactions", "").children("Nothing was redacted."),
      onNonEmpty: (entries) =>
        h.ul
          .attr("data-redactions", "")
          .children(
            Array.map(entries, ([kind, count]) =>
              h.li.attr("data-redaction-kind", kind).children(`${kind}: ${count} redacted`),
            ),
          ),
    },
  );

const notesView = (h: Html.H<Message>, session: Session) =>
  h.ul
    .attr("data-notes", "")
    .children(
      Array.map(session.notes, (note) =>
        h.li
          .attr("data-note-kind", note.kind)
          .children(h.strong(`${note.kind} by ${note.author}`), " ", withChips(h, note.body)),
      ),
    );

const headerView = (h: Html.H<Message>, session: Session) =>
  h.div
    .attr("data-session-header", "")
    .children(
      h.h3(`Session ${session.id}`),
      Array.isReadonlyArrayNonEmpty(session.notes) && notesView(h, session),
      redactionsView(h, session),
    );

/** The text cut at the limit, and how many lines it left out. */
const cutOf = (
  text: string,
  isFull: boolean,
): { readonly shown: string; readonly hidden: number } => {
  const lines = String.split(text, "\n");
  const hidden = isFull ? 0 : Number.max(Array.length(lines) - TURN_LINE_LIMIT, 0);
  return {
    hidden,
    shown: hidden === 0 ? text : Array.join(Array.take(lines, TURN_LINE_LIMIT), "\n"),
  };
};

const preView = (h: Html.H<Message>, label: string, text: string, isFull: boolean) => {
  const { hidden, shown } = cutOf(text, isFull);
  return {
    hidden,
    view: h.div.attr("data-turn-part", label).children(h.strong(label), h.pre(withChips(h, shown))),
  };
};

const editsView = (h: Html.H<Message>, edits: ReadonlyArray<FileEdit>) =>
  h.ul.attr("data-turn-edits", "").children(Array.map(edits, (edit) => h.li(edit.path)));

/** An opened tool turn: the files it wrote, its input and output, and the button for what was cut. */
const openedToolView = (
  h: Html.H<Message>,
  turn: ToolTurn,
  isFull: boolean,
  messages: SessionMessages,
): View.Children<Message, never> => {
  const input = preView(h, "Input", turn.input, isFull);
  const output = preView(h, "Output", turn.output, isFull);
  return [
    Array.isReadonlyArrayNonEmpty(turn.edits) && editsView(h, turn.edits),
    input.view,
    output.view,
    Number.isGreaterThan(input.hidden + output.hidden, 0) &&
      h.button
        .attr("type", "button")
        .class("btn")
        .attr("data-more-of-turn", turn.id)
        .on("click", messages.onMoreOfTurn(turn.id))
        .children(`Show the rest (${input.hidden + output.hidden} more lines)`),
  ];
};

const toolView = (
  h: Html.H<Message>,
  turn: ToolTurn,
  state: SessionState,
  copy: CopyLinks,
  messages: SessionMessages,
) => {
  const isOpen = Option.getOrElse(Record.get(state.openedTurns, turn.id), () => false);
  const isFull = Option.getOrElse(Record.get(state.fullTurns, turn.id), () => false);
  const isActive = Option.exists(state.maybeHighlightedTurn, ({ id }) => id === turn.id);
  return h.li
    .id(turnElementIdOf(turn.id))
    .attr("data-turn", turn.id)
    .attr("data-kind", "tool")
    .attr("data-active", isActive ? "" : undefined)
    .children(
      h.button
        .attr("type", "button")
        .class("btn")
        .attr("aria-expanded", `${isOpen}`)
        .on("click", messages.onTurn(turn.id))
        .children(
          h.span.attr("data-tool-name", "").children(turn.name),
          Array.map(Array.fromNullishOr(turn.target), (target) =>
            h.span.attr("data-tool-target", "").children(" ", withChips(h, target)),
          ),
          turn.failed && h.span.attr("data-mark", "failed").children(" failed"),
          Array.isReadonlyArrayNonEmpty(turn.edits) &&
            h.span.attr("data-mark", "edits").children(" wrote edits"),
        ),
      // An opened turn copies the link up to it, beside its line and not inside the button.
      isOpen &&
        Array.map(Array.fromOption(copy.maybeTurn(turn.id)), (path) =>
          copyButtonView(h, copy.maybeCopied, path, "Copy link"),
        ),
      isOpen && openedToolView(h, turn, isFull, messages),
    );
};

const proseView = (
  h: Html.H<Message>,
  turn: Extract<Turn, { readonly kind: "prompt" | "reply" }>,
) =>
  h.li
    .id(turnElementIdOf(turn.id))
    .attr("data-turn", turn.id)
    .attr("data-kind", turn.kind)
    .children(
      h.strong.attr("data-turn-label", "").children(turn.kind === "prompt" ? "Prompt" : "Reply"),
      renderMarkdown(turn.text, h, { textView: (text) => withChips(h, text) }),
    );

const turnView = (
  h: Html.H<Message>,
  turn: Turn,
  state: SessionState,
  copy: CopyLinks,
  messages: SessionMessages,
) =>
  Match.value(turn).pipe(
    Match.discriminatorsExhaustive("kind")({
      prompt: (prompt) => proseView(h, prompt),
      reply: (reply) => proseView(h, reply),
      tool: (tool) => toolView(h, tool, state, copy, messages),
    }),
  );

const sessionBodyView = (
  h: Html.H<Message>,
  session: Session,
  state: SessionState,
  copy: CopyLinks,
  messages: SessionMessages,
) =>
  h.div
    .attr("data-session-id", session.id)
    .children(
      headerView(h, session),
      session.format === "unknown"
        ? noteView(h, "Cairn cannot read that agent's log yet.")
        : h.ol
            .attr("data-turns", "")
            .children(Array.map(session.turns, (turn) => turnView(h, turn, state, copy, messages))),
      Number.isGreaterThan(session.skipped, 0) &&
        h.p
          .attr("data-skipped", "")
          .children(`Cairn skipped ${session.skipped} lines it could not read.`),
    );

const noteOfSession = (h: Html.H<Message>, id: string, note: View.Input<Message>) =>
  h.div.attr("data-session-id", id).children(note);

/**
 * The session pane's body for a commit: its session, or why there is none. `maybeId` is the
 * commit's `Cairn-Session`, which is none when the commit has no session.
 */
export const sessionView = (
  h: Html.H<Message>,
  maybeId: Option.Option<string>,
  state: SessionState,
  copy: CopyLinks,
  messages: SessionMessages,
) =>
  Option.match(maybeId, {
    onNone: () => noteView(h, "No session was recorded for this commit."),
    onSome: (id) =>
      isDemoBuild()
        ? noteOfSession(h, id, noteView(h, `Session ${id} needs "cairn serve".`))
        : Option.match(Record.get(state.sessions, id), {
            onNone: () => noteOfSession(h, id, noteView(h, `Loading session ${id}.`)),
            onSome: (data) =>
              SessionData.match(data, {
                Failed: ({ message }) => noteOfSession(h, id, noteView(h, message, true)),
                Loaded: ({ session }) => sessionBodyView(h, session, state, copy, messages),
                Loading: () => noteOfSession(h, id, noteView(h, `Loading session ${id}.`)),
              }),
          }),
  });
