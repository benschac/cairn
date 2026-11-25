import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Result, Schema, Struct } from "effect";
import { Command, Mount, click, expect, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { FetchPatch } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { PatchData, Screen, TraceData, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import rangePatch from "./fixtures/range.patch?raw";
import { focusedDetailHeading, loaded, unmeasuredWires } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const taskId = (id: string) => Schema.decodeSync(TaskId)(id);
const clickedTask = (id: string) => Message.ClickedTask({ id: taskId(id) });

const scrolledTop = Mount.resolveAll(
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

/** A done task with one commit that has a parent, so its whole diff has a route. */
const task6 = Option.getOrThrow(Array.findFirst(demoTrace.tasks, (each) => each.id === "t6"));
const commit = Option.getOrThrow(Array.head(task6.commits));
const parent = Option.getOrThrow(Array.head(commit.parents));
const wholePath = `/api/diffs/${parent}/${commit.sha}`;

/** A task with no commits, once pending and once done. */
const bare = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) => Array.isReadonlyArrayEmpty(each.commits)),
);
const withBare = (status: "pending" | "done") =>
  modifyFields(reading, {
    trace: () =>
      TraceData.Success({
        data: Struct.evolve(demoTrace, {
          tasks: (tasks) =>
            Array.map(tasks, (each) => (each.id === bare.id ? { ...each, status } : each)),
        }),
      }),
  });

const row = selector('[data-task-row="spec.contract.manifest:t6"]');
const statusLine = selector('[data-status-line="prd.manifest-schema"]');

const fetchedWhole = Command.resolve(
  FetchPatch({ path: wholePath }),
  Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
);

const requested = (model: Model, message: Message) => {
  const next = update(model, message);
  return {
    model: next.model,
    paths: Array.map(
      Array.getSomes(
        Array.map(next.commands ?? [], (command) =>
          command.name === "FetchPatch"
            ? Option.some(
                Schema.decodeUnknownSync(Schema.Struct({ path: Schema.String }))(command.args),
              )
            : Option.none(),
        ),
      ),
      ({ path }) => path,
    ),
  };
};

it("opening a task with commits requests its whole diff and mounts it in a region of 60vh", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTop,
    click(statusLine),
    click(row),
    focusedDetailHeading,
    fetchedWhole,
    Mount.resolve(RenderDiff, Message.CompletedRenderDiff()),
    expect(selector("[data-detail-code-summary]")).toContainText("1 commit"),
    expect(selector("[data-detail-code-summary]")).toContainText("changed"),
    expect(selector("[data-detail-code]")).toHaveStyle("height", "60vh"),
    expect(selector("[data-detail-code] [data-patch-path]")).toHaveAttr(
      "data-patch-path",
      wholePath,
    ),
  );
});

it("a route is requested once across two openings, and not at all when the model has it", () => {
  const first = requested(reading, clickedTask("t6"));
  assert(first.paths).toEqual([wholePath]);
  const loadedBack = update(
    first.model,
    Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
  ).model;
  assert(requested(loadedBack, clickedTask("t6")).paths).toEqual([]);
  // The code view and the panel share what is loaded: a patch the code view loaded is not fetched.
  const viaCode = update(
    modifyFields(reading, {
      patches: () => ({ [wholePath]: PatchData.Loaded({ text: rangePatch }) }),
    }),
    clickedTask("t6"),
  );
  assert(Array.some(viaCode.commands ?? [], (command) => command.name === "FetchPatch")).toBe(
    false,
  );
  // While it is still loading, a second opening asks for nothing either.
  assert(requested(first.model, clickedTask("t6")).paths).toEqual([]);
});

it("a failed fetch shows its error in the region and is tried again when the task is shown", () => {
  const failed = update(
    requested(reading, clickedTask("t6")).model,
    Message.ReceivedPatch({ path: wholePath, result: Result.fail("The server is not running.") }),
  ).model;
  scene(
    { update, view },
    given(failed),
    scrolledTop,
    click(statusLine),
    click(row),
    Command.resolve(
      FetchPatch({ path: wholePath }),
      Message.ReceivedPatch({ path: wholePath, result: Result.fail("Still down.") }),
    ),
    expect(selector("[data-detail-code] [role='alert']")).toContainText("Still down."),
  );
  assert(requested(failed, clickedTask("t6")).paths).toEqual([wholePath]);
});

it("a pending task with no commits says it has no code yet, and fetches nothing", () => {
  assert(requested(withBare("pending"), clickedTask(bare.id)).paths).toEqual([]);
  scene(
    { update, view },
    given(modifyFields(withBare("pending"), { detail: () => [{ id: bare.id, kind: "task" }] })),
    scrolledTop,
    expect(selector("[data-detail-code-note]")).toContainText(
      "No code yet. The task has not started.",
    ),
    expect(selector("[data-detail-code]")).toBeAbsent(),
  );
});

it("a done task with no commits says no commit carries its trailer", () => {
  scene(
    { update, view },
    given(modifyFields(withBare("done"), { detail: () => [{ id: bare.id, kind: "task" }] })),
    scrolledTop,
    expect(selector("[data-detail-code-note]")).toContainText("Cairn-Task trailer"),
  );
});
