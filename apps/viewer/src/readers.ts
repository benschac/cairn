import { type Participant, ParticipantId, PrdSectionId } from "@cairn/contract";
import { Array, Match, Option, Schema } from "effect";

/** How the room names a participant: their name, and "(agent)" after an agent's. */
export const labelOf = (participant: Participant) =>
  Match.value(participant.kind).pipe(
    Match.when("agent", () => `${participant.name} (agent)`),
    Match.when("human", () => participant.name),
    Match.exhaustive,
  );

/** Another participant reading a PRD section, with what the section's chip shows of them. */
export const SectionReader = Schema.Struct({
  id: ParticipantId,
  label: Schema.String,
  section: PrdSectionId,
});
export type SectionReader = typeof SectionReader.Type;

/**
 * The other participants who have a current section, in the room's order. The PRD pane draws only this.
 */
export const readersOf = (
  participants: ReadonlyArray<Participant>,
  maybeYou: Option.Option<ParticipantId>,
): ReadonlyArray<SectionReader> =>
  Array.flatMap(participants, (participant) =>
    Option.match(participant.reading, {
      onNone: () => [],
      onSome: (section) =>
        Option.contains(maybeYou, participant.id)
          ? []
          : [{ id: participant.id, label: labelOf(participant), section }],
    }),
  );

const sameReaders = Schema.toEquivalence(Schema.Array(SectionReader));

/**
 * `next` when the readers differ from `current` by value, and `current` itself when they do not,
 * so a lazy view that was given `current` sees the same reference.
 */
export const keptReaders = (
  current: ReadonlyArray<SectionReader>,
  next: ReadonlyArray<SectionReader>,
): ReadonlyArray<SectionReader> => (sameReaders(current, next) ? current : next);
