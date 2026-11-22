import { Presence, Sha, Trace } from "@cairn/contract";
import type { Participant, ParticipantKind, SectionId, SectionStatus } from "@cairn/contract";
import { Array, Effect, Match, Number, Option, Record, Schema } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Runtime, Update } from "foldkit";
import type { Attribute, Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import {
  PanZoomCanvas,
  VIEWPORT_ATTRIBUTE,
  boundsOf,
  canvasMessages,
  fitViewport,
  originViewport,
  transformOf,
  viewportAttribute,
  type Viewport,
} from "./canvas.ts";
import { curvesOf, Positions, type EdgeKind } from "./curves.ts";
import { drawerView, type DrawerMessages } from "./drawer.ts";
import { describeTraceError, loadDemoTrace } from "./load.ts";
import { renderMarkdown } from "./markdown.ts";
import { TraceData, type Model } from "./model.ts";
import { columnOf, stackLayoutOf, type StackPosition } from "./stacks.ts";
import {
  Node,
  chainOf,
  isInChain,
  judgmentMarkOf,
  sectionStatusOf,
  type Chain,
  type JudgmentMark,
} from "./trace.ts";

export const Message = defineMessageUnion({
  ...canvasMessages,
  ClickedCommit: { sha: Sha },
  ClickedFit: {},
  ClickedNode: { node: Node },
  ClosedDrawer: {},
  HoveredNode: { node: Node },
  LeftNode: {},
  MeasuredLayout: { positions: Positions },
  ReceivedPresence: { presence: Presence },
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;

const nodeEquivalence = Schema.toEquivalence(Node);

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedCommit: ({ sha }) => ({
      model: modifyFields(model, { maybeCommit: () => Option.some(sha) }),
    }),
    // Fit frames every measured node in the pane; until both are known it does nothing.
    ClickedFit: () =>
      Option.match(Option.all({ bounds: boundsOf(model.positions), pane: model.maybePane }), {
        onNone: () => ({ model }),
        onSome: ({ bounds, pane }) => ({
          model: modifyFields(model, {
            viewport: () => fitViewport(bounds, pane.width, pane.height),
          }),
        }),
      }),
    // Clicking a node opens its drawer. Clicking the selected node clears the selection;
    // clicking any other node selects it.
    ClickedNode: ({ node }) => ({
      model: modifyFields(model, {
        maybeCommit: () => Option.none(),
        maybeDrawer: () => Option.some(node),
        maybeSelected: (maybeSelected) =>
          Option.exists(maybeSelected, (selected) => nodeEquivalence(selected, node))
            ? Option.none()
            : Option.some(node),
      }),
    }),
    ClosedDrawer: () => ({
      model: modifyFields(model, {
        maybeCommit: () => Option.none(),
        maybeDrawer: () => Option.none(),
      }),
    }),
    HoveredNode: ({ node }) => ({
      model: modifyFields(model, { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: modifyFields(model, { maybeHovered: () => Option.none() }) }),
    MeasuredLayout: ({ positions }) => ({
      model: modifyFields(model, { positions: () => positions }),
    }),
    MeasuredPane: ({ size }) => ({
      model: modifyFields(model, { maybePane: () => Option.some(size) }),
    }),
    PannedOrZoomed: ({ viewport }) => ({
      model: modifyFields(model, { viewport: () => viewport }),
    }),
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
  model: {
    maybeCommit: Option.none(),
    maybeDrawer: Option.none(),
    maybeHovered: Option.none(),
    maybePane: Option.none(),
    maybeSelected: Option.none(),
    participants: [],
    positions: {},
    trace: TraceData.Loading(),
    viewport: originViewport,
    you: Option.none(),
  },
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

const highlightedBackground = "#fef08a";
const dimmedOpacity = "0.35";

/**
 * The hover and click handlers every node carries and, while a chain is active, the
 * attributes that highlight a node in it or dim a node outside it.
 */
const nodeAttributes = (
  maybeChain: Option.Option<Chain>,
  node: Node,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> =>
  Array.appendAll(
    [
      // `nopan`: a drag that starts on a node selects its text instead of panning the canvas.
      h.Class("nopan"),
      h.OnMouseEnter(Message.HoveredNode({ node })),
      h.OnMouseLeave(Message.LeftNode()),
      h.OnClick(Message.ClickedNode({ node })),
    ],
    Option.match(maybeChain, {
      onNone: () => [],
      onSome: (chain) =>
        isInChain(chain, node)
          ? [h.DataAttribute("highlighted", "true"), h.Style({ background: highlightedBackground })]
          : [h.DataAttribute("dimmed", "true"), h.Style({ opacity: dimmedOpacity })],
    }),
  );

type ColumnName = "prd" | "spec" | "stacks";

const column = (name: ColumnName, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section([h.DataAttribute("column", name), h.Style({ overflow: "visible" })], children);

/** Where a task without a position would sit. stackLayoutOf places every task it is given. */
const origin: StackPosition = { column: 1, row: 1 };

const stacksView = (
  trace: Trace,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  const layout = stackLayoutOf(trace.tasks);
  const top = Array.reduce(Record.values(layout), 1, (highest, position) =>
    Number.max(highest, position.row),
  );
  return h.div(
    [
      h.DataAttribute("stacks", ""),
      h.Style({
        display: "grid",
        gap: "8px",
        "grid-auto-columns": "200px",
        width: "max-content",
      }),
    ],
    Array.map(trace.tasks, (task) => {
      const position = Option.getOrElse(Record.get(layout, task.id), () => origin);
      return h.div(
        Array.appendAll(
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
          nodeAttributes(maybeChain, { id: task.id, kind: "task" }, h),
        ),
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

const edgeColor = {
  dependency: "#b45309",
  implements: "#64748b",
  parent: "#334155",
  specifies: "#0f766e",
} satisfies Record.ReadonlyRecord<EdgeKind, string>;

/**
 * One SVG path per curve between measured nodes. While a chain is active an edge with both ends
 * in it is highlighted and every other edge is dimmed.
 */
const edgesView = (
  trace: Trace,
  positions: Positions,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.svg(
    [
      h.DataAttribute("edges", ""),
      h.Style({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "absolute",
        width: "100%",
      }),
    ],
    Array.map(curvesOf(trace, positions, columnOf(stackLayoutOf(trace.tasks))), (curve) => {
      // None while no chain is active; otherwise whether both ends are in it.
      const maybeInChain = Option.map(
        maybeChain,
        (chain) => isInChain(chain, curve.source) && isInChain(chain, curve.target),
      );
      return h.path(
        Array.flatten([
          [h.DataAttribute("edge", curve.id), h.DataAttribute("kind", curve.kind)],
          Array.fromOption(
            Option.map(maybeInChain, (inChain) =>
              h.DataAttribute(inChain ? "highlighted" : "dimmed", "true"),
            ),
          ),
          [
            h.D(curve.path),
            h.Fill("none"),
            h.Stroke(edgeColor[curve.kind]),
            h.StrokeWidth(Option.contains(maybeInChain, true) ? "2.5" : "1.5"),
            h.Opacity(Option.contains(maybeInChain, false) ? "0.15" : "1"),
          ],
          curve.dashed ? [h.StrokeDasharray("6 4")] : [],
        ]),
      );
    }),
  );

/** The columns and their edges, and the other participants' cursors, with the chain of the hovered node, or else the selected one, highlighted. */
const columnsView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeActive: Option.Option<Node>,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html => {
  // One chain per render: every node and edge reads it.
  const maybeChain = Option.map(maybeActive, (active) => chainOf(trace, active));
  const sectionAttributes = (sectionId: SectionId) =>
    nodeAttributes(maybeChain, { id: sectionId, kind: "section" }, h);
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
  // The canvas is the pane; the layer inside it holds everything that pans and zooms.
  return h.div(
    [
      h.DataAttribute("canvas", ""),
      h.Attribute(VIEWPORT_ATTRIBUTE, viewportAttribute(viewport)),
      h.OnMount(PanZoomCanvas()),
      h.Style({
        height: "calc(100vh - 160px)",
        "min-height": "320px",
        overflow: "hidden",
        position: "relative",
      }),
    ],
    [
      h.div(
        [
          h.DataAttribute("canvas-layer", ""),
          h.Style({
            position: "relative",
            transform: transformOf(viewport),
            "transform-origin": "0 0",
            // The layer is as wide as its content; nothing in it scrolls or clips.
            width: "max-content",
          }),
        ],
        Array.appendAll(
          [
            h.div(
              [
                h.Style({
                  display: "grid",
                  gap: "24px",
                  "grid-template-columns": "480px 480px max-content",
                }),
              ],
              [
                column(
                  "prd",
                  [
                    renderMarkdown(trace.prd.markdown, h, {
                      attributesOf: sectionAttributes,
                      decorate: badged,
                    }),
                  ],
                  h,
                ),
                column(
                  "spec",
                  [
                    renderMarkdown(trace.spec.markdown, h, {
                      attributesOf: sectionAttributes,
                      decorate: specDecorated,
                    }),
                  ],
                  h,
                ),
                column("stacks", [stacksView(trace, maybeChain, h)], h),
              ],
            ),
            edgesView(trace, positions, maybeChain, h),
          ],
          Array.getSomes(
            Array.map(others, (participant) => cursorView(participant, viewport.zoom, h)),
          ),
        ),
      ),
    ],
  );
};

const drawerMessages: DrawerMessages<Message> = {
  onClickCommit: (sha) => Message.ClickedCommit({ sha }),
  onClickTask: (id) => Message.ClickedNode({ node: { id, kind: "task" } }),
  onClose: Message.ClosedDrawer(),
};

/** In the demo the commit is already in the trace, so its detail is its subject and files. */
const commitDetailView = (trace: Trace, sha: Sha, h: HtmlBuilder<Message>): Option.Option<Html> =>
  Option.map(
    Array.findFirst(
      Array.flatMap(trace.tasks, (task) => task.commits),
      (commit) => commit.sha === sha,
    ),
    (commit) =>
      h.section(
        [h.DataAttribute("commit-detail", commit.sha)],
        [
          h.h3([], [commit.subject]),
          h.ul(
            [],
            Array.map(commit.files, (file) => h.li([], [file])),
          ),
        ],
      ),
  );

/** The open drawer and, below it, the commit clicked in it; nothing while the drawer is closed. */
const drawerViews = (model: Model, trace: Trace, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(model.maybeDrawer, {
    onNone: () => [],
    onSome: (node) =>
      Array.prepend(
        Array.fromOption(
          Option.flatMap(model.maybeCommit, (sha) => commitDetailView(trace, sha, h)),
        ),
        drawerView(trace, node, h, drawerMessages),
      ),
  });

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

const fitButton = (h: HtmlBuilder<Message>): Html =>
  h.button([h.Type("button"), h.OnClick(Message.ClickedFit())], ["Fit to view"]);

/** Everyone in the room but you. */
const othersOf = (model: Model): ReadonlyArray<Participant> =>
  Array.filter(model.participants, (participant) => !Option.contains(model.you, participant.id));

const traceView = (
  model: Model,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const maybeActive = Option.orElse(model.maybeHovered, () => model.maybeSelected);
  // The Fit button, the canvas and the drawer, shown whenever there is a trace to pan over.
  const canvas = (trace: Trace): ReadonlyArray<Html> =>
    Array.appendAll(
      [fitButton(h), columnsView(trace, model.positions, model.viewport, maybeActive, others, h)],
      drawerViews(model, trace, h),
    );
  return AsyncData.match(model.trace, {
    onFailure: (error) => [alertView(error, h)],
    onIdle: () => [loadingView(h)],
    onLoading: () => [loadingView(h)],
    onRefreshing: canvas,
    onStale: ({ data, error }) => Array.prepend(canvas(data), alertView(error, h)),
    onSuccess: canvas,
  });
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = othersOf(model);
  return {
    body: h.main(
      [],
      Array.flatten([
        [h.h1([], ["Cairn"]), h.p([h.Role("status")], [presentText(others)])],
        traceView(model, others, h),
      ]),
    ),
    title: "Cairn",
  };
};
