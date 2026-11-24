import { CursorJson, PrdSectionId, PresenceJson, ReadingJson } from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { Effect, Filter, Option, Schema, Stream } from "effect";
import { AsyncData, Subscription } from "foldkit";

import { cursorOf, paneViewportOf } from "../canvas.ts";
import { rectOf } from "../geometry.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { currentOf, searchedSectionOf } from "../reader.ts";

/** The presence in a socket frame; none for a frame that is not text or is not a presence. */
export const decodePresenceFrame = Schema.decodeUnknownOption(PresenceJson);
// A cursor is two finite numbers and always encodes, so the encoder cannot fail, as with the
// viewport attribute in canvas.ts.
const encodeCursor = Schema.encodeSync(CursorJson);

const encodeReading = Schema.encodeSync(ReadingJson);

/** How often the reader's current section is looked at to see whether it changed. */
const READING_POLL = "100 millis";

/**
 * The PRD section that is current in this window: the reader's `currentOf`, so a pin or an active
 * search result counts. None until the trace is loaded and a section is known.
 */
export const readingOf = (model: Model): Option.Option<PrdSectionId> =>
  Option.flatMap(AsyncData.getData(model.trace), (trace) =>
    currentOf(model.reader, searchedSectionOf(trace, model.search.maybeActive)),
  );

const presenceUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/presence${location.search}`;

const openSocket = Effect.acquireRelease(
  Effect.sync(() => new WebSocket(presenceUrl())),
  (socket) => Effect.sync(() => socket.close()),
);

const presenceUpdates = (socket: WebSocket) =>
  Stream.fromEventListener<MessageEvent>(socket, "message").pipe(
    Stream.filterMap(Filter.fromPredicateOption((event) => decodePresenceFrame(event.data))),
    Stream.map((presence) => Message.ReceivedPresence({ presence })),
  );

/** What the socket's own events say: it opened, or it closed or failed (an error is followed by a close). */
const connectionChanges = (socket: WebSocket) => {
  const event = (name: "close" | "error" | "open") => Stream.fromEventListener<Event>(socket, name);
  return Stream.merge(
    Stream.map(event("open"), () => Message.OpenedPresence()),
    Stream.map(Stream.merge(event("close"), event("error")), () => Message.ClosedPresence()),
  );
};

/**
 * The canvas point under the pointer, read with the viewport the model last gave the pane, so the
 * stream does not restart while someone pans. None while there is no pane or the pointer is off it.
 */
const cursorAt = (event: PointerEvent): Option.Option<Cursor> =>
  Option.flatMap(Option.fromNullOr(document.querySelector("[data-canvas]")), (pane) =>
    cursorOf(
      { x: event.clientX, y: event.clientY },
      rectOf(pane.getBoundingClientRect()),
      paneViewportOf(pane),
    ),
  );

const sendCursor = (socket: WebSocket) => (cursor: Cursor) =>
  Effect.sync(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeCursor(cursor));
    }
  });

const sendCursorMoves = (socket: WebSocket) =>
  Stream.fromEventListener<PointerEvent>(document, "pointermove").pipe(
    Stream.filterMap(Filter.fromPredicateOption(cursorAt)),
    Stream.mapEffect(sendCursor(socket)),
    Stream.drain,
  );

/**
 * What this window is reading, as the frames to send the room: the current section once the
 * socket is open, and again each time it changes. The socket outlives a change of section, so the
 * section is read as it stands every poll, and a section already sent is not sent again.
 */
export const readingFrames = (
  isOpen: () => boolean,
  readReading: () => Option.Option<PrdSectionId>,
): Stream.Stream<string> =>
  Stream.tick(READING_POLL).pipe(
    Stream.filter(isOpen),
    Stream.filterMap(Filter.fromPredicateOption(readReading)),
    Stream.changes,
    Stream.map((reading) => encodeReading({ reading })),
  );

const sendReadings = (socket: WebSocket, readReading: () => Option.Option<PrdSectionId>) =>
  readingFrames(() => socket.readyState === WebSocket.OPEN, readReading).pipe(
    Stream.mapEffect((frame) => Effect.sync(() => socket.send(frame))),
    Stream.drain,
  );

const presenceMessages = (readReading: () => Option.Option<PrdSectionId>) =>
  Stream.unwrap(
    Effect.map(openSocket, (socket) =>
      Stream.merge(
        presenceUpdates(socket),
        Stream.merge(
          connectionChanges(socket),
          Stream.merge(sendCursorMoves(socket), sendReadings(socket, readReading)),
        ),
      ),
    ),
  );

/**
 * One socket for the life of the page. The section being read is a dependency the stream looks at
 * and is never restarted for, since a new socket would be a new participant.
 */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  presence: entry(
    { maybeReading: Schema.Option(PrdSectionId) },
    {
      dependenciesToStream: (_dependencies, readDependencies) =>
        presenceMessages(() => readDependencies().maybeReading),
      keepAliveEquivalence: () => true,
      modelToDependencies: (model) => ({ maybeReading: readingOf(model) }),
    },
  ),
}));
