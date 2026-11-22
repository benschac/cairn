import { Presence, Trace } from "@cairn/contract";
import type { Participant, ParticipantKind, SectionId, SectionStatus } from "@cairn/contract";
import { Array, Effect, Match, Number, Option, Record, Schema } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Runtime, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { describeTraceError, loadDemoTrace } from "./load.ts";
import { renderMarkdown } from "./markdown.ts";
import { TraceData, type Model } from "./model.ts";
import { stackLayoutOf, type StackPosition } from "./stacks.ts";
import { judgmentMarkOf, sectionStatusOf, type JudgmentMark } from "./trace.ts";

export const Message = defineMessageUnion({
  ReceivedPresence: { presence: Presence },
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ReceivedPresence: ({ presence }) => ({
      model: modifyFields(model, {
        participants: () => presence.participants,
        you: () => Option.some(presence.you),
      }),
    }),
    SettledLoadTrace: ({ result }) => ({
      model: modifyFields(model, { trace: AsyncData.settle(result) }),
    }),
  });

export const LoadTrace = Command.define("LoadTrace", {
  messages: [Message.SettledLoadTrace],
  execute: loadDemoTrace.pipe(
    Effect.mapError(describeTraceError),
    Effect.result,
    Effect.map((result) => Message.SettledLoadTrace({ result })),
  ),
});

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: { participants: [], trace: TraceData.Loading(), you: Option.none() },
});

const labelOf = (participant: Participant) =>
  Match.value(participant.kind).pipe(
    Match.when("agent", () => `${participant.name} (agent)`),
    Match.when("human", () => participant.name),
    Match.exhaustive,
  );

const cursorColor = { agent: "#7c3aed", human: "#0f766e" } satisfies Record.ReadonlyRecord<
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

const badgeView = (status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("badge", ""),
      h.DataAttribute("status", status),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: "0.8" }),
    ],
    [status],
  );

const judgmentView = (mark: JudgmentMark, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("judgment", mark.verdict),
      h.DataAttribute("stale", String(mark.stale)),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: mark.stale ? "0.4" : "1" }),
    ],
    [mark.verdict],
  );

type ColumnName = "prd" | "spec" | "stacks";

const column = (name: ColumnName, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("column", name), h.Style({ "min-width": "0", overflow: "auto" })],
    children,
  );

/** Where a task without a position would sit. stackLayoutOf places every task it is given. */
const origin: StackPosition = { column: 1, row: 1 };

const stacksView = (trace: Trace, h: HtmlBuilder<Message>): Html => {
  const layout = stackLayoutOf(trace.tasks);
  const top = Array.reduce(Record.values(layout), 1, (highest, position) =>
    Number.max(highest, position.row),
  );
  return h.div(
    [
      h.DataAttribute("stacks", ""),
      h.Style({ display: "grid", gap: "8px", "grid-auto-columns": "minmax(160px, 1fr)" }),
    ],
    Array.map(trace.tasks, (task) => {
      const position = Option.getOrElse(Record.get(layout, task.id), () => origin);
      return h.div(
        [
          h.DataAttribute("task", task.id),
          h.Style({
            border: "1px solid #94a3b8",
            "border-radius": "6px",
            "grid-column": String(position.column),
            // Row 1 is the bottom, so everything a task needs sits below it.
            "grid-row": String(top - position.row + 1),
            padding: "6px 8px",
          }),
        ],
        Array.flatten([
          [
            h.strong([], [task.id]),
            ` ${task.title}`,
            h.div([h.DataAttribute("field", "branch")], [task.branch]),
            h.div([h.DataAttribute("field", "model")], [task.model]),
            h.div([h.DataAttribute("status", task.status)], [task.status]),
          ],
          task.gate.required ? [h.span([h.DataAttribute("gate", "")], ["human gate"])] : [],
          Array.fromOption(
            Option.map(judgmentMarkOf(trace, { id: task.id, kind: "task" }), (mark) =>
              judgmentView(mark, h),
            ),
          ),
        ]),
      );
    }),
  );
};

const columnsView = (trace: Trace, h: HtmlBuilder<Message>): Html => {
  const badged = (sectionId: SectionId): ReadonlyArray<Html> =>
    Array.fromOption(
      Option.map(sectionStatusOf(trace, sectionId), (status) => badgeView(status, h)),
    );
  const specDecorated = (sectionId: SectionId): ReadonlyArray<Html> =>
    Array.appendAll(
      badged(sectionId),
      Array.fromOption(
        Option.map(judgmentMarkOf(trace, { id: sectionId, kind: "section" }), (mark) =>
          judgmentView(mark, h),
        ),
      ),
    );
  return h.div(
    [
      h.Style({
        display: "grid",
        gap: "24px",
        "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr)",
      }),
    ],
    [
      column("prd", [renderMarkdown(trace.prd.markdown, h, badged)], h),
      column("spec", [renderMarkdown(trace.spec.markdown, h, specDecorated)], h),
      column("stacks", [stacksView(trace, h)], h),
    ],
  );
};

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

const traceView = (trace: TraceData, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  AsyncData.match(trace, {
    onFailure: (error) => [alertView(error, h)],
    onIdle: () => [loadingView(h)],
    onLoading: () => [loadingView(h)],
    onRefreshing: (data) => [columnsView(data, h)],
    onStale: ({ data, error }) => [alertView(error, h), columnsView(data, h)],
    onSuccess: (data) => [columnsView(data, h)],
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = Array.filter(
    model.participants,
    (participant) => !Option.contains(model.you, participant.id),
  );
  return {
    body: h.main(
      [],
      Array.flatten([
        [h.h1([], ["Cairn"]), h.p([h.Role("status")], [presentText(others)])],
        traceView(model.trace, h),
        Array.getSomes(Array.map(others, (participant) => cursorView(participant, h))),
      ]),
    ),
    title: "Cairn",
  };
};
