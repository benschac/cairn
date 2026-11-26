import { SectionId } from "@cairn/contract";
import { Effect, MutableRef, Option, Queue, Schema, Stream, String } from "effect";
import { Subscription } from "@effect/ui";

import { Message } from "../message.ts";
import { PassageSelection } from "../model.ts";
import { inPage } from "./page.ts";

/** The attribute that marks an element whose text can be linked to; its value is the section ID. */
export const PASSAGE_ATTRIBUTE = "data-passage";

const PASSAGE_SELECTOR = `[${PASSAGE_ATTRIBUTE}]`;

/** Text as a quote holds it: every whitespace run is one space, and neither end has any. */
export const quoteOf = (text: string): string => String.trim(String.replace(/\s+/gu, " ")(text));

/**
 * The passage that holds both ends of a selection, from the passage that holds each end. None
 * when either end lies outside every passage, or when they lie in two.
 */
export const sharedPassageOf = <Passage>(
  maybeStart: Option.Option<Passage>,
  maybeEnd: Option.Option<Passage>,
): Option.Option<Passage> =>
  Option.filter(maybeStart, (start) => Option.exists(maybeEnd, (end) => start === end));

const decodeSectionId = Schema.decodeUnknownOption(SectionId);

/**
 * What the selection selects: the section of the passage that holds it and the quote of its text.
 * None when it lies in no passage, is not a section's, or has no text but whitespace.
 */
export const selectionOf = (
  maybeSection: Option.Option<string>,
  text: string,
): Option.Option<PassageSelection> =>
  Option.flatMap(Option.flatMap(maybeSection, decodeSectionId), (section) => {
    const quote = quoteOf(text);
    return String.isNonEmpty(quote) ? Option.some({ quote, section }) : Option.none();
  });

/** The message for a selection that changed: it selects a passage, or it left every passage. */
export const messageOf = (maybeSelection: Option.Option<PassageSelection>): Message =>
  Option.match(maybeSelection, {
    onNone: () => Message.ClearedPassageSelection(),
    onSome: ({ quote, section }) => Message.SelectedPassage({ quote, section }),
  });

const sameSelection = Option.makeEquivalence(Schema.toEquivalence(PassageSelection));

/** The passage that holds a node: the node's own element, or its parent's for a text node. */
const passageOfNode = (node: Node | null): Option.Option<Element> =>
  Option.flatMapNullishOr(
    Option.flatMapNullishOr(Option.fromNullOr(node), (inner) =>
      inner instanceof Element ? inner : inner.parentElement,
    ),
    (element) => element.closest(PASSAGE_SELECTOR),
  );

/** What the page's selection selects now. */
const readSelection = (): Option.Option<PassageSelection> =>
  Option.flatMap(Option.fromNullOr(document.getSelection()), (selection) =>
    selection.isCollapsed
      ? Option.none()
      : selectionOf(
          Option.flatMapNullishOr(
            sharedPassageOf(
              passageOfNode(selection.anchorNode),
              passageOfNode(selection.focusNode),
            ),
            (passage) => passage.getAttribute(PASSAGE_ATTRIBUTE),
          ),
          selection.toString(),
        ),
  );

/**
 * Listens to `selectionchange`, at most once per animation frame, and sends what changed: the
 * section and the quote when both ends of the selection lie in one passage, and the end of it
 * when the selection leaves the passage or has no text.
 */
const trackSelection = (queue: Queue.Enqueue<Message>) =>
  Effect.gen(function* () {
    const frame = MutableRef.make<Option.Option<number>>(Option.none());
    const sent = MutableRef.make<Option.Option<PassageSelection>>(Option.none());
    const report = () => {
      const next = readSelection();
      if (!sameSelection(next, MutableRef.get(sent))) {
        MutableRef.set(sent, next);
        Queue.offerUnsafe(queue, messageOf(next));
      }
    };
    const schedule = () =>
      Option.match(MutableRef.get(frame), {
        onNone: () =>
          MutableRef.set(
            frame,
            Option.some(
              requestAnimationFrame(() => {
                MutableRef.set(frame, Option.none());
                report();
              }),
            ),
          ),
        onSome: () => undefined,
      });
    yield* Effect.acquireRelease(
      Effect.sync(() => document.addEventListener("selectionchange", schedule)),
      () => Effect.sync(() => document.removeEventListener("selectionchange", schedule)),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => Option.map(MutableRef.get(frame), cancelAnimationFrame)),
    );
  });

export const selectionSubscription = Subscription.make(
  "selection",
  inPage(Stream.callback<Message>((queue) => trackSelection(queue))),
);
