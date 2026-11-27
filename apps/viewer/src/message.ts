import { Presence, PrdSectionId, SectionId, Session, Sha, TaskId, Trace } from "@cairn/contract";
import { UiSchema } from "@effect/ui";
import { Schema } from "effect";

import { Density, DiffStyle } from "./model.ts";
import { DividerKey, Pane } from "./panes.ts";
import { Node } from "./trace.ts";
import { Url, UrlRequest } from "./url.ts";
import { Measured } from "./wires.ts";

export const Message = UiSchema.TaggedEnum({
  /** Back, Forward or a hash change moved the address: the link it holds opens. */
  ChangedUrl: { url: Url },
  /** A click on an anchor in the page, which the address subscription hands to the viewer. */
  ClickedLink: { request: UrlRequest },
  /** An address was written to the history, or the page was sent to one. */
  CompletedNavigation: {},
  /** The code view's "Back to the plan" button. */
  ClickedBackToPlan: {},
  /** One of the diff style toggle's two buttons. */
  ClickedDiffStyle: { style: DiffStyle },
  /** A tool turn's line in the session pane: opens it, or closes it again. */
  ClickedTurn: { id: Schema.String },
  /** An opened tool turn's "Show the rest" button: its input and output are shown whole. */
  ClickedMoreOfTurn: { id: Schema.String },
  /** A turn's button on a hunk's mark in the diff, which the diff mount draws and sends. */
  ClickedHunkMark: { id: Schema.String },
  /** A spec card's header: opens or closes that card alone. */
  ClickedCardHeader: { id: SectionId },
  /** One of the spec cards' density control's three buttons: it sets every card. */
  ClickedDensity: { density: Density },
  /** The PRD pane's "Collapse all" or "Expand all": hides or shows the prose of every section. */
  ClickedCondensePrd: {},
  /** A PRD section's heading: shows or hides that section's prose alone. */
  ClickedPrdHeading: { id: SectionId },
  /** The link notice's "Dismiss" button. */
  ClickedDismissLinkNotice: {},
  /** The detail panel's Close button: empties the trail. */
  ClickedCloseDetail: {},
  /** A task or spec section opened from inside the detail panel: added to the end of the trail. */
  ClickedDetailNode: { node: Node },
  /** A step of the trail: cuts it back to that step. */
  ClickedTrailStep: { index: Schema.Int },
  /** A PRD section a task traces to, in the detail panel: scrolls the PRD pane to its heading. */
  ClickedTraceSection: { id: PrdSectionId },
  /** The top bar's models and reasoning switch: shows or hides them everywhere. */
  ClickedModelsSwitch: {},
  /** "Open code" on a task in the detail panel, or a commit listed there: the code view on that task. */
  ClickedOpenCode: { id: TaskId, maybeSha: Schema.Option(Sha) },
  /** A "Copy link" button: copies the link's path, with the page's origin in front. */
  ClickedCopyLink: { path: Schema.String },
  /** "Copy link to passage": opens the selected passage of the section as a step and copies its link. */
  ClickedCopyPassageLink: { section: SectionId },
  /** A PRD heading's section ID, small beside its title: copies the ID. */
  ClickedSectionId: { id: PrdSectionId },
  /** The status line under a PRD heading: pins that section, or unpins it when it is the pinned one. */
  ClickedStatusLine: { id: PrdSectionId },
  /** A list item's annotation: pins the item, or unpins it when it is the pinned one. */
  ClickedItemAnnotation: { id: PrdSectionId },
  /** A PRD section or item named by a spec card's `Implements` chip: scrolls the PRD pane to it and marks it. */
  ClickedImplementsChip: { id: PrdSectionId },
  /** A result in the search list: it becomes the active result and is brought into view. */
  ClickedSearchResult: { node: Node },
  /** A stack's segment: unfolds its finished trunk, or folds it again. Only the window keeps it. */
  ClickedSegment: { root: TaskId },
  /** A task row in a spec card: opens the task's detail. */
  ClickedTask: { id: TaskId },
  /** A commit in the code view's tree. */
  ClickedTreeCommit: { sha: Sha },
  /** A file in the code view's tree. */
  ClickedTreeFile: { path: Schema.String },
  /** A task in the code view's tree. */
  ClickedTreeTask: { id: TaskId },
  /** The search input's text changed. */
  ChangedSearchQuery: { query: Schema.String },
  /** The selection left the passage it was in, or has no text. */
  ClearedPassageSelection: {},
  /** The diff's line selection was cleared. */
  ClearedDiffLines: {},
  /** The presence socket closed or failed. */
  ClosedPresence: {},
  /** The clipboard took the section's ID, or refused it. */
  CompletedCopySectionId: { id: PrdSectionId, isCopied: Schema.Boolean },
  /** The clipboard took the link's path, or refused it. */
  CompletedCopyLink: { path: Schema.String, isCopied: Schema.Boolean },
  CompletedFocusDetailHeading: {},
  CompletedScrollPrdSection: {},
  CompletedFocusSearchInput: {},
  CompletedScrollSearchResult: {},
  /** The reader's panes were scrolled to what a selected search result points at. */
  CompletedScrollSearchTargets: {},
  /** The panes were scrolled to the steps a link opened. */
  CompletedScrollLinkTargets: {},
  /**
   * The stacks pane was scrolled to the base branch bar at its bottom, and the chart measured: the
   * width that lays every level out in one row. None when it could not be read.
   */
  CompletedScrollStacks: { maybeChartWidth: Schema.Option(Schema.Finite) },
  /** The diff mount parsed the patch and drew it, or put the reason it could not in the pane. */
  CompletedRenderDiff: {},
  /** The diagram mount drew the diagram, or put the reason it could not in the pane. */
  CompletedDrawDiagram: {},
  CompletedScrollTurn: {},
  HoveredNode: { node: Node },
  LeftNode: {},
  /** The reader's mount measured every `data-wire` element and the three panes, in window coordinates. */
  MeasuredWires: { measured: Measured },
  /** Escape went down on the page and nothing handled it first. */
  PressedEscape: {},
  /** In the search input: down to the next result. */
  PressedSearchArrowDown: {},
  /** In the search input: up to the previous result. */
  PressedSearchArrowUp: {},
  /** In the search input: selects the active result. */
  PressedSearchEnter: {},
  /** In the search input: clears the search. */
  PressedSearchEscape: {},
  /** An arrow key went down on a focused divider. */
  PressedArrowOnDivider: { key: DividerKey, pane: Pane },
  /** The primary button or a touch went down on a divider. */
  PressedDivider: {
    maybeWidth: Schema.Option(Schema.Finite), // the pane as rendered; none when it could not be read
    pane: Pane,
    pointerId: Schema.Int,
    x: Schema.Finite,
  },
  /** A pointer moved anywhere on the page while a divider was being dragged, with the buttons it held. */
  MovedResizePointer: { buttons: Schema.Int, pointerId: Schema.Int, x: Schema.Finite },
  /** A pointer went up or was cancelled anywhere on the page while a divider was being dragged. */
  ReleasedResizePointer: { pointerId: Schema.Int },
  /** The presence socket opened. */
  OpenedPresence: {},
  /** A patch route's text, or why it could not be fetched. */
  ReceivedPatch: { path: Schema.String, result: Schema.Result(Schema.String, Schema.String) },
  /** A session route's `Session`, or why it could not be fetched. */
  ReceivedSession: {
    id: Schema.String,
    result: Schema.Result(Schema.toType(Session), Schema.String),
  },
  ReceivedPresence: { presence: Presence },
  /** Text was selected inside one section's passage: the section and the quote, as a link holds it. */
  SelectedPassage: { section: SectionId, quote: Schema.String },
  /** The diff mount's line selection: the lines of one of the diff's files, on one side. */
  SelectedDiffLines: {
    end: Schema.Int,
    path: Schema.String,
    side: Schema.Literals(["new", "old"]),
    start: Schema.Int,
  },
  /** The section at the top of the PRD pane changed. */
  ScrolledPrd: { id: PrdSectionId },
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;
