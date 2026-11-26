import { PrdSectionId, PresenceJson, ReadingJson } from "@cairn/contract";
import { Subscription } from "@effect/ui";
import { Context, Effect, Filter, MutableRef, Option, Schema, Stream } from "effect";

import { Message } from "../message.ts";
import { loadedTraceOf, type Model } from "../model.ts";
import { currentOf, searchedSectionOf } from "../reader.ts";
import { InPage } from "./page.ts";

/** The presence in a socket frame; none for a frame that is not text or is not a presence. */
export const decodePresenceFrame = Schema.decodeUnknownOption(PresenceJson);
// A reading is a section ID and always encodes, so the encoder cannot fail.
const encodeReading = Schema.encodeSync(ReadingJson);

/** How often the reader's current section is looked at to see whether it changed. */
const READING_POLL = "100 millis";

/**
 * The PRD section that is current in this window: the reader's `currentOf`, so a pin or an active
 * search result counts. None until the trace is loaded and a section is known.
 */
export const readingOf = (model: Model): Option.Option<PrdSectionId> =>
  Option.flatMap(loadedTraceOf(model.trace), (trace) =>
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
        Stream.merge(connectionChanges(socket), sendReadings(socket, readReading)),
      ),
    ),
  );

/** What the presence subscription declares on each render: the section being read now. */
interface Reading {
  readonly maybeReading: Option.Option<PrdSectionId>;
}

/**
 * One socket for the life of the page. The section being read is state the stream looks at and is
 * never restarted for, since a new socket would be a new participant: a direct subscription keeps
 * the latest declaration, and each poll reads it with `enter`.
 */
export const presenceSubscription = (model: Model) =>
  Subscription.direct<Reading, Message>(
    "presence",
    undefined,
    { maybeReading: readingOf(model) },
    (context, { emit, enter }) => {
      if (!Context.get(context, InPage)) {
        return () => undefined;
      }
      const readReading = () => {
        const latest = MutableRef.make(Option.none<PrdSectionId>());
        enter(({ maybeReading }) => MutableRef.set(latest, maybeReading));
        return MutableRef.get(latest);
      };
      const fiber = Effect.runForkWith(context)(
        Stream.runForEach(presenceMessages(readReading), (message) =>
          Effect.sync(() => emit(message)),
        ),
      );
      return () => fiber.interruptUnsafe();
    },
  );
