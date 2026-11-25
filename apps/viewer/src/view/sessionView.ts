import type { FileEdit, Session, ToolTurn, Turn } from "@cairn/contract";
import { Array, Match, Number, Option, Order, Record, String } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isDemoBuild } from "../load.ts";
import { renderMarkdown, type Rendered } from "../markdown.ts";
import type { Message } from "../message.ts";
import { SessionData, type HighlightedTurn } from "../model.ts";

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

/** Text with each `[REDACTED:<kind>]` drawn as a chip naming the kind. */
const withChips = (text: string, h: HtmlBuilder<Message>): Rendered =>
  Array.map(String.split(text, REDACTION), (part, index): Html | string =>
    Number.remainder(index, 2) === 1
      ? h.span([h.Class("chip"), h.DataAttribute("redacted", part)], [`redacted: ${part}`])
      : part,
  );

/** The view when the condition holds, as a list that is empty when it does not. */
const showIf = <A>(condition: boolean, view: () => A): ReadonlyArray<A> =>
  condition ? [view()] : [];

const noteView = (text: string, h: HtmlBuilder<Message>, isAlert = false): Html =>
  h.p(isAlert ? [h.Role("alert")] : [], [text]);

const redactionsView = (session: Session, h: HtmlBuilder<Message>): Html =>
  Array.match(
    Array.sort(
      Record.toEntries(
        Record.filter(session.redactions, (count) => Number.isGreaterThan(count, 0)),
      ),
      Order.mapInput(Order.String, ([kind]: readonly [string, number]) => kind),
    ),
    {
      onEmpty: () => h.p([h.DataAttribute("redactions", "")], ["Nothing was redacted."]),
      onNonEmpty: (entries) =>
        h.ul(
          [h.DataAttribute("redactions", "")],
          Array.map(entries, ([kind, count]) =>
            h.li([h.DataAttribute("redaction-kind", kind)], [`${kind}: ${count} redacted`]),
          ),
        ),
    },
  );

const notesView = (session: Session, h: HtmlBuilder<Message>): Html =>
  h.ul(
    [h.DataAttribute("notes", "")],
    Array.map(session.notes, (note) =>
      h.li(
        [h.DataAttribute("note-kind", note.kind)],
        Array.appendAll(
          [h.strong([], [`${note.kind} by ${note.author}`]), " "],
          withChips(note.body, h),
        ),
      ),
    ),
  );

const headerView = (session: Session, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.DataAttribute("session-header", "")],
    Array.flatten([
      [h.h3([], [`Session ${session.id}`])],
      showIf(Array.isReadonlyArrayNonEmpty(session.notes), () => notesView(session, h)),
      [redactionsView(session, h)],
    ]),
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

const preView = (
  label: string,
  text: string,
  isFull: boolean,
  h: HtmlBuilder<Message>,
): { readonly hidden: number; readonly view: Html } => {
  const { hidden, shown } = cutOf(text, isFull);
  return {
    hidden,
    view: h.div(
      [h.DataAttribute("turn-part", label)],
      [h.strong([], [label]), h.pre([], withChips(shown, h))],
    ),
  };
};

const editsView = (edits: ReadonlyArray<FileEdit>, h: HtmlBuilder<Message>): Html =>
  h.ul(
    [h.DataAttribute("turn-edits", "")],
    Array.map(edits, (edit) => h.li([], [edit.path])),
  );

/** An opened tool turn: the files it wrote, its input and output, and the button for what was cut. */
const openedToolView = (
  turn: ToolTurn,
  isFull: boolean,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): ReadonlyArray<Html> => {
  const input = preView("Input", turn.input, isFull, h);
  const output = preView("Output", turn.output, isFull, h);
  return Array.flatten([
    showIf(Array.isReadonlyArrayNonEmpty(turn.edits), () => editsView(turn.edits, h)),
    [input.view, output.view],
    showIf(Number.isGreaterThan(input.hidden + output.hidden, 0), () =>
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("more-of-turn", turn.id),
          h.OnClick(messages.onMoreOfTurn(turn.id)),
        ],
        [`Show the rest (${input.hidden + output.hidden} more lines)`],
      ),
    ),
  ]);
};

const toolView = (
  turn: ToolTurn,
  state: SessionState,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): Html => {
  const isOpen = Option.getOrElse(Record.get(state.openedTurns, turn.id), () => false);
  const isFull = Option.getOrElse(Record.get(state.fullTurns, turn.id), () => false);
  const isActive = Option.exists(state.maybeHighlightedTurn, ({ id }) => id === turn.id);
  return h.li(
    Array.appendAll(
      [
        h.Id(turnElementIdOf(turn.id)),
        h.DataAttribute("turn", turn.id),
        h.DataAttribute("kind", "tool"),
      ],
      showIf(isActive, () => h.DataAttribute("active", "")),
    ),
    Array.prepend(
      isOpen ? openedToolView(turn, isFull, h, messages) : [],
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.AriaExpanded(isOpen),
          h.OnClick(messages.onTurn(turn.id)),
        ],
        Array.flatten([
          [h.span([h.DataAttribute("tool-name", "")], [turn.name])],
          Array.map(Array.fromNullishOr(turn.target), (target) =>
            h.span([h.DataAttribute("tool-target", "")], Array.prepend(withChips(target, h), " ")),
          ),
          showIf(turn.failed, () => h.span([h.DataAttribute("mark", "failed")], [" failed"])),
          showIf(Array.isReadonlyArrayNonEmpty(turn.edits), () =>
            h.span([h.DataAttribute("mark", "edits")], [" wrote edits"]),
          ),
        ]),
      ),
    ),
  );
};

const proseView = (
  turn: Extract<Turn, { readonly kind: "prompt" | "reply" }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.li(
    [
      h.Id(turnElementIdOf(turn.id)),
      h.DataAttribute("turn", turn.id),
      h.DataAttribute("kind", turn.kind),
    ],
    [
      h.strong([h.DataAttribute("turn-label", "")], [turn.kind === "prompt" ? "Prompt" : "Reply"]),
      renderMarkdown(turn.text, h, { textView: (text) => withChips(text, h) }),
    ],
  );

const turnView = (
  turn: Turn,
  state: SessionState,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): Html =>
  Match.value(turn).pipe(
    Match.withReturnType<Html>(),
    Match.discriminatorsExhaustive("kind")({
      prompt: (prompt) => proseView(prompt, h),
      reply: (reply) => proseView(reply, h),
      tool: (tool) => toolView(tool, state, h, messages),
    }),
  );

const sessionBodyView = (
  session: Session,
  state: SessionState,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): Html =>
  h.div(
    [h.DataAttribute("session-id", session.id)],
    Array.flatten([
      [headerView(session, h)],
      [
        session.format === "unknown"
          ? noteView("Cairn cannot read that agent's log yet.", h)
          : h.ol(
              [h.DataAttribute("turns", "")],
              Array.map(session.turns, (turn) => turnView(turn, state, h, messages)),
            ),
      ],
      showIf(Number.isGreaterThan(session.skipped, 0), () =>
        h.p(
          [h.DataAttribute("skipped", "")],
          [`Cairn skipped ${session.skipped} lines it could not read.`],
        ),
      ),
    ]),
  );

const noteOfSession = (id: string, note: Html, h: HtmlBuilder<Message>): Html =>
  h.div([h.DataAttribute("session-id", id)], [note]);

/**
 * The session pane's body for a commit: its session, or why there is none. `maybeId` is the
 * commit's `Cairn-Session`, which is none when the commit has no session.
 */
export const sessionView = (
  maybeId: Option.Option<string>,
  state: SessionState,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): Html =>
  Option.match(maybeId, {
    onNone: () => noteView("No session was recorded for this commit.", h),
    onSome: (id) =>
      isDemoBuild()
        ? noteOfSession(id, noteView(`Session ${id} needs "cairn serve".`, h), h)
        : Option.match(Record.get(state.sessions, id), {
            onNone: () => noteOfSession(id, noteView(`Loading session ${id}.`, h), h),
            onSome: (data) =>
              SessionData.match(data, {
                Failed: ({ message }) => noteOfSession(id, noteView(message, h, true), h),
                Loaded: ({ session }) => sessionBodyView(session, state, h, messages),
                Loading: () => noteOfSession(id, noteView(`Loading session ${id}.`, h), h),
              }),
          }),
  });
