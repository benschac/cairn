import { UiStruct } from "@effect/ui";
import { Event, StatementId, TaskId, TraceStatement, type Trace } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Effect, Schema } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Screen, TraceData } from "../src/model.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import {
  containing,
  data,
  loaded,
  readerMounted,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

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
  UiStruct.evolve(loaded, {
    detail: () => [{ id: Schema.decodeSync(TaskId)("t1"), kind: "task" as const }],
    screen: () => Screen.Reader(),
    trace: () => TraceData.Success({ data: trace }),
  });

/** The reader's mounts, and the detail pane's divider that an open task adds. */
const scrolledTop = (s: ViewerSteps) =>
  s.pipe(readerMounted).expectMount(PressDivider({ pane: "detail" }));

const items = data("done-when-statement");
const settled = data("settled");
const doneWhen = data("detail-part", "done-when");

it.effect(
  "a gated task waiting on a human shows a checklist, the human statement first and the draft tagged",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(opened(traceWith("blocked_on_human", [])));
      s.pipe(scrolledTop)
        .expect(items)
        .toHaveCount(3)
        .expect(doneWhen)
        .toHaveText(
          containing("[ ] The redaction notice reads well.[ ] Secrets never reach the log."),
        )
        .expect(data("done-when-statement", "prd.redaction#v2"))
        .toHaveText(containing("Draft"))
        .expect(data("done-when-statement", "prd.redaction#v1"))
        .toHaveText("[ ] Secrets never reach the log.")
        .expect(settled)
        .toHaveCount(0);
    }),
);

it.effect("after a human approved, the human statement shows as settled", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(traceWith("done", [approval])));
    s.pipe(scrolledTop)
      .expect(items)
      .toHaveCount(3)
      .expect(settled)
      .toHaveText(containing("[x] The redaction notice reads well."))
      .expect(settled)
      .toHaveCount(1);
  }),
);

it.effect("a human done event on a task still blocked on a human settles nothing", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(traceWith("blocked_on_human", [approval])));
    s.pipe(scrolledTop).expect(doneWhen).toExist().expect(settled).toHaveCount(0);
  }),
);

it.effect("a task that carries no statement shows no Done when block", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(demoTrace));
    s.pipe(scrolledTop).expect(doneWhen).toBeAbsent();
  }),
);
