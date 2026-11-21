import type { Runtime, Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import { demoRows } from "./demo.ts";
import type { Model } from "./model.ts";

export const Message = defineMessageUnion({
  ClickedToggleWaiting: {},
});
export type Message = typeof Message.Type;

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedToggleWaiting: () => ({
      model: { ...model, onlyWaiting: !model.onlyWaiting },
    }),
  });

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { onlyWaiting: false, rows: demoRows },
});

const visibleRows = (model: Model) =>
  model.onlyWaiting ? model.rows.filter((row) => row.status === "blocked_on_human") : model.rows;

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  body: h.main(
    [],
    [
      h.h1([], ["Cairn"]),
      h.button(
        [h.OnClick(Message.ClickedToggleWaiting()), h.AriaPressed(String(model.onlyWaiting))],
        ["Waiting for approval"],
      ),
      h.ul(
        [],
        visibleRows(model).map((row) =>
          h.li(
            [h.DataAttribute("status", row.status)],
            [`${row.task.title} (${row.task.section}): ${row.status}`],
          ),
        ),
      ),
    ],
  ),
  title: "Cairn",
});
