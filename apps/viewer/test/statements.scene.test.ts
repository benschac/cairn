import { Event, StatementId, TaskId, TraceStatement, type Trace } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Schema } from "effect";
import { all, expect, expectAll, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, TraceData } from "../src/model.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, unmeasuredWires } from "./fixtures.ts";
import { Mount } from "foldkit/scene";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { PrdSectionId } from "@cairn/contract";
import { Option } from "effect";

const statement = (n: number, human: boolean, draft: boolean, text: string): TraceStatement =>
  Schema.decodeUnknownSync(TraceStatement)({
    draft,
    human,
    id: `prd.redaction#v${n}`,
    line: n,
    owner: "prd.redaction",
    provedBy: [],
    text,
  });

const statements = [
  statement(1, false, false, "Secrets never reach the log."),
  statement(2, false, true, "Tokens in URLs are removed too."),
  statement(3, true, false, "The redaction notice reads well."),
];

const approval = Schema.decodeUnknownSync(Event)({
  actor: "human:ben",
  status: "done",
  taskId: "t1",
  ts: "2026-01-01T00:00:00Z",
});

/** The demo trace with t1 carrying the three statements, in the given status and with the events. */
const traceWith = (status: "blocked_on_human" | "done", events: ReadonlyArray<Event>): Trace => ({
  ...demoTrace,
  prd: { ...demoTrace.prd, statements },
  tasks: Array.map(demoTrace.tasks, (task) =>
    task.id === "t1"
      ? {
          ...task,
          events,
          status,
          statements: Array.map(statements, ({ id }) => Schema.decodeSync(StatementId)(id)),
        }
      : task,
  ),
});

const opened = (trace: Trace) =>
  modifyFields(loaded, {
    detail: () => [{ id: Schema.decodeSync(TaskId)("t1"), kind: "task" as const }],
    screen: () => Screen.Reader(),
    trace: () => TraceData.Success({ data: trace }),
  });

const scrolledTop = Mount.resolveAll(
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

const items = all.selector("[data-done-when-statement]");

it("a gated task waiting on a human shows a checklist, the human statement first and the draft tagged", () => {
  scene(
    { update, view },
    given(opened(traceWith("blocked_on_human", []))),
    scrolledTop,
    expectAll(items).toHaveCount(3),
    expect(selector("[data-detail-part='done-when']")).toContainText(
      "[ ] The redaction notice reads well.[ ] Secrets never reach the log.",
    ),
    expect(selector("[data-done-when-statement='prd.redaction#v2']")).toContainText("Draft"),
    expect(selector("[data-done-when-statement='prd.redaction#v1']")).not.toContainText("Draft"),
    expectAll(all.selector("[data-settled]")).toHaveCount(0),
  );
});

it("after a human approved, the human statement shows as settled", () => {
  scene(
    { update, view },
    given(opened(traceWith("done", [approval]))),
    scrolledTop,
    expectAll(items).toHaveCount(3),
    expect(selector("[data-settled]")).toContainText("[x] The redaction notice reads well."),
    expectAll(all.selector("[data-settled]")).toHaveCount(1),
  );
});

it("a human done event on a task still blocked on a human settles nothing", () => {
  scene(
    { update, view },
    given(opened(traceWith("blocked_on_human", [approval]))),
    scrolledTop,
    expect(selector("[data-detail-part='done-when']")).toExist(),
    expectAll(all.selector("[data-settled]")).toHaveCount(0),
  );
});

it("a task that carries no statement shows no Done when block", () => {
  scene(
    { update, view },
    given(opened(demoTrace)),
    scrolledTop,
    expect(selector("[data-detail-part='done-when']")).toBeAbsent(),
  );
});
