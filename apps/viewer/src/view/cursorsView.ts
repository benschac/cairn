import type { Participant, ParticipantKind } from "@cairn/contract";
import { Array, Match, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message.ts";

export const labelOf = (participant: Participant) =>
  Match.value(participant.kind).pipe(
    Match.when("agent", () => `${participant.name} (agent)`),
    Match.when("human", () => participant.name),
    Match.exhaustive,
  );

const cursorColor = { agent: "#7c3aed", human: "#0f766e" } satisfies Record.ReadonlyRecord<
  ParticipantKind,
  string
>;

/** A cursor sits on the canvas layer, so it pans and zooms with the content; its label undoes the zoom. */
const cursorView = (
  participant: Participant,
  zoom: number,
  h: HtmlBuilder<Message>,
): Option.Option<Html> =>
  Option.map(participant.cursor, (cursor) =>
    h.div(
      [
        h.DataAttribute("cursor", participant.kind),
        h.Style({
          background: cursorColor[participant.kind],
          "border-radius": "0 10px 10px 10px",
          color: "white",
          font: "12px system-ui, sans-serif",
          left: `${cursor.x}px`,
          padding: "2px 8px",
          "pointer-events": "none",
          position: "absolute",
          top: `${cursor.y}px`,
          transform: `scale(${1 / zoom})`,
          "transform-origin": "0 0",
        }),
      ],
      [labelOf(participant)],
    ),
  );

/** The cursor of each other participant that has one. */
export const cursorsView = (
  others: ReadonlyArray<Participant>,
  zoom: number,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.getSomes(Array.map(others, (participant) => cursorView(participant, zoom, h)));
