import { Presence } from "@cairn/contract";
import type { Participant } from "@cairn/contract";
import type { Runtime, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

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
      model: { ...model, onlyWaiting: !model.onlyWaiting },
    }),
    ReceivedPresence: ({ presence }) => ({
      model: { ...model, participants: presence.participants, you: presence.you },
    }),
  });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { onlyWaiting: false, participants: [], rows: demoRows, you: null },
});

const visibleRows = (model: Model) =>
  model.onlyWaiting ? model.rows.filter((row) => row.status === "blocked_on_human") : model.rows;

const labelOf = (participant: Participant) =>
  participant.kind === "agent" ? `${participant.name} (agent)` : participant.name;

const cursorColor = { agent: "#7c3aed", human: "#0f766e" };

const cursorView = (participant: Participant, h: HtmlBuilder<Message>): Html | null =>
  participant.cursor === null
    ? null
    : h.div(
        [
          h.DataAttribute("cursor", participant.kind),
          h.Style({
            background: cursorColor[participant.kind],
            "border-radius": "0 10px 10px 10px",
            color: "white",
            font: "12px system-ui, sans-serif",
            left: `${participant.cursor.x * 100}%`,
            padding: "2px 8px",
            "pointer-events": "none",
            position: "fixed",
            top: `${participant.cursor.y * 100}%`,
          }),
        ],
        [labelOf(participant)],
      );

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = model.participants.filter((participant) => participant.id !== model.you);
  return {
    body: h.main(
      [],
      [
        h.h1([], ["Cairn"]),
        h.p(
          [h.Role("status")],
          [
            others.length === 0
              ? "Nobody else is here."
              : `Here now: ${others.map(labelOf).join(", ")}`,
          ],
        ),
        h.button(
          [h.OnClick(Message.ClickedToggleWaiting()), h.AriaPressed(String(model.onlyWaiting))],
          ["Waiting for approval"],
        ),
        h.ul(
          [],
          visibleRows(model).map((row) =>
            h.li(
              [h.DataAttribute("status", row.status)],
              [`${row.title} (${row.prdSections.join(", ")}): ${row.status}`],
            ),
          ),
        ),
        ...others.flatMap((participant) => cursorView(participant, h) ?? []),
      ],
    ),
    title: "Cairn",
  };
};
