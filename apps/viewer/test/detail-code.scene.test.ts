import { UiStruct } from "@effect/ui";
import { TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema, Struct } from "effect";

import { FetchPatch } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { PatchData, Screen, TraceData, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import rangePatch from "./fixtures/range.patch?raw";
import {
  both,
  byRole,
  containing,
  data,
  detailDividerRunning,
  drawnDiff,
  focusedHeading,
  inside,
  loaded,
  pushedUrl,
  readerMounted,
  resolved,
  styled,
  viewerScene,
} from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });
const taskId = (id: string) => Schema.decodeSync(TaskId)(id);
const clickedTask = (id: string) => Message.ClickedTask({ id: taskId(id) });

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
  UiStruct.evolve(reading, {
    trace: () =>
      TraceData.Success({
        data: Struct.evolve(demoTrace, {
          tasks: (tasks) =>
            Array.map(tasks, (each) => (each.id === bare.id ? { ...each, status } : each)),
        }),
      }),
  });

const row = data("task-row", "spec.contract.manifest:t6");
const statusLine = data("status-line", "prd.manifest-schema");

const fetchedWhole = resolved(
  FetchPatch,
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

it.effect(
  "opening a task with commits requests its whole diff and mounts it in a region of 60vh",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .click(statusLine)
        .pipe(pushedUrl)
        .click(row)
        .pipe(pushedUrl, focusedHeading, detailDividerRunning, fetchedWhole, drawnDiff)
        .expect(data("detail-code-summary"))
        .toHaveText(containing("1 commit"))
        .expect(data("detail-code-summary"))
        .toHaveText(containing("changed"))
        .expect(both(data("detail-code"), styled("height", "60vh")))
        .toExist()
        .expect(inside(data("detail-code"), data("patch-path")))
        .toHaveAttribute("data-patch-path", wholePath);
    }),
);

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
    UiStruct.evolve(reading, {
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

it.effect(
  "a failed fetch shows its error in the region and is tried again when the task is shown",
  () =>
    Effect.gen(function* () {
      const failed = update(
        requested(reading, clickedTask("t6")).model,
        Message.ReceivedPatch({
          path: wholePath,
          result: Result.fail("The server is not running."),
        }),
      ).model;
      const s = yield* viewerScene(failed);
      // The model already has the task open, so the panel's divider runs from the start.
      s.pipe(readerMounted, detailDividerRunning)
        .click(statusLine)
        .pipe(pushedUrl)
        .click(row)
        .pipe(
          resolved(
            FetchPatch,
            Message.ReceivedPatch({ path: wholePath, result: Result.fail("Still down.") }),
          ),
        )
        .expect(inside(data("detail-code"), byRole("alert")))
        .toHaveText(containing("Still down."));
      assert(requested(failed, clickedTask("t6")).paths).toEqual([wholePath]);
    }),
);

it.effect("a pending task with no commits says it has no code yet, and fetches nothing", () =>
  Effect.gen(function* () {
    assert(requested(withBare("pending"), clickedTask(bare.id)).paths).toEqual([]);
    const s = yield* viewerScene(
      UiStruct.evolve(withBare("pending"), { detail: () => [{ id: bare.id, kind: "task" }] }),
    );
    s.pipe(readerMounted, detailDividerRunning)
      .expect(data("detail-code-note"))
      .toHaveText(containing("No code yet. The task has not started."))
      .expect(data("detail-code"))
      .toBeAbsent();
  }),
);

it.effect("a done task with no commits says no commit carries its trailer", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      UiStruct.evolve(withBare("done"), { detail: () => [{ id: bare.id, kind: "task" }] }),
    );
    s.pipe(readerMounted, detailDividerRunning)
      .expect(data("detail-code-note"))
      .toHaveText(containing("Cairn-Task trailer"));
  }),
);
