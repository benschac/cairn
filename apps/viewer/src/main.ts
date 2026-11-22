import { Presence } from "@cairn/contract";
import type { ManifestTask, Participant, ParticipantKind } from "@cairn/contract";
import { Array, Boolean, Match, Option } from "effect";
import type { Runtime, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { demoRows } from "./demo.ts";
import type { Model } from "./model.ts";

export const Message = defineMessageUnion({
  ClickedToggleWaiting: {},
  ReceivedPresence: { presence: Presence },
});
export type Message = typeof Message.Type;

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedToggleWaiting: () => ({
      model: modifyFields(model, { onlyWaiting: Boolean.not }),
    }),
    ReceivedPresence: ({ presence }) => ({
      model: modifyFields(model, {
        participants: () => presence.participants,
        you: () => Option.some(presence.you),
      }),
    }),
  });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { onlyWaiting: false, participants: [], rows: demoRows, you: Option.none() },
});

const isWaiting = (row: ManifestTask) => row.status === "blocked_on_human";

const visibleRows = (model: Model) =>
  model.onlyWaiting ? Array.filter(model.rows, isWaiting) : model.rows;

const labelOf = (participant: Participant) =>
  Match.value(participant.kind).pipe(
    Match.when("agent", () => `${participant.name} (agent)`),
    Match.when("human", () => participant.name),
    Match.exhaustive,
  );

const cursorColor = { agent: "#7c3aed", human: "#0f766e" } satisfies Record<
  ParticipantKind,
  string
>;

const cursorView = (participant: Participant, h: HtmlBuilder<Message>): Option.Option<Html> =>
  Option.map(participant.cursor, (cursor) =>
    h.div(
      [
        h.DataAttribute("cursor", participant.kind),
        h.Style({
          background: cursorColor[participant.kind],
          "border-radius": "0 10px 10px 10px",
          color: "white",
          font: "12px system-ui, sans-serif",
          left: `${cursor.x * 100}%`,
          padding: "2px 8px",
          "pointer-events": "none",
          position: "fixed",
          top: `${cursor.y * 100}%`,
        }),
      ],
      [labelOf(participant)],
    ),
  );

const presentText = (others: ReadonlyArray<Participant>) =>
  Array.match(others, {
    onEmpty: () => "Nobody else is here.",
    onNonEmpty: (present) => `Here now: ${Array.join(Array.map(present, labelOf), ", ")}`,
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = Array.filter(
    model.participants,
    (participant) => !Option.contains(model.you, participant.id),
  );
  return {
    body: h.main(
      [],
      Array.appendAll(
        [
          h.h1([], ["Cairn"]),
          h.p([h.Role("status")], [presentText(others)]),
          h.button(
            [h.OnClick(Message.ClickedToggleWaiting()), h.AriaPressed(String(model.onlyWaiting))],
            ["Waiting for approval"],
          ),
          h.ul(
            [],
            Array.map(visibleRows(model), (row) =>
              h.li(
                [h.DataAttribute("status", row.status)],
                [`${row.title} (${Array.join(row.prdSections, ", ")}): ${row.status}`],
              ),
            ),
          ),
        ],
        Array.getSomes(Array.map(others, (participant) => cursorView(participant, h))),
      ),
    ),
    title: "Cairn",
  };
};
