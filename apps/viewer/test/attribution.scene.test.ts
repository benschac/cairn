import { Session } from "@cairn/contract";
import { Story } from "@effect/ui/testing";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Record, Result, Schema } from "effect";

import { patchPathOf } from "../src/codeView.ts";
import { ScrollTurn } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { Viewer } from "../src/app.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { PushUrl } from "../src/route.ts";
import { Shown, type Model } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import {
  attr,
  both,
  containing,
  data,
  inside,
  loaded,
  pushedUrl,
  tag,
  viewerProps,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

/** A task with a commit that has a session, so the code view on it marks the diff's hunks. */
const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) =>
    Array.some(each.commits, (commit) => commit.session !== null),
  ),
);
const commit = Option.getOrThrow(Array.findFirst(task.commits, (each) => each.session !== null));
const sessionId = `${commit.session}`;
const patchPath = Option.getOrThrow(patchPathOf(task, Shown.OneCommit({ sha: commit.sha })));

const tool = (id: string, path: string, added: ReadonlyArray<string>) => ({
  at: "2026-11-25T10:00:02.000Z",
  edits: [{ added, path, removed: [] }],
  failed: false,
  id,
  input: "the edit's input",
  kind: "tool",
  name: "Edit",
  output: "The file has been updated.",
  target: path,
});

const session = Schema.decodeUnknownSync(Session)({
  format: "claude-code",
  id: sessionId,
  notes: [],
  redactions: {},
  skipped: 0,
  taskId: "t1",
  turns: [
    { at: "2026-11-25T10:00:00.000Z", id: "p1", kind: "prompt", text: "Add the events." },
    tool("c1", "packages/contract/src/events.ts", ["export const Actor = Schema.Union(["]),
    tool("c2", "packages/contract/src/index.ts", ['export * from "./events.ts";']),
  ],
  version: 1,
});

const after = (start: Model, ...messages: ReadonlyArray<Message>): Model =>
  Array.reduce(messages, start, (current, next) => appUpdate(current, next).model);

/** The code view on the commit with its patch and its session loaded. */
const showing = after(
  loaded,
  Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
  Message.ReceivedPatch({ path: patchPath, result: Result.succeed(commitPatch) }),
  Message.ReceivedSession({ id: sessionId, result: Result.succeed(session) }),
);

const list = data("patch-path");
const turn = (id: string) => both(tag("li"), data("turn", id));
const turnButton = (id: string) => inside(turn(id), both(tag("button"), attr("aria-expanded")));
const drawn = (s: ViewerSteps) => s.mounted(RenderDiff, Message.CompletedRenderDiff());

it.effect(
  "ClickedHunkMark opens the turn, marks it from the diff side and scrolls the session to it",
  () =>
    Effect.gen(function* () {
      const s = yield* Story.make(Viewer, viewerProps);
      s.given(showing)
        .send(Message.ClickedHunkMark({ id: "c1" }))
        // Opening the turn also writes the address, so the link gains the turn.
        .expectExact(ScrollTurn, PushUrl)
        .resolve(ScrollTurn, Message.CompletedScrollTurn())
        .resolve(PushUrl, Message.CompletedNavigation())
        .check(({ model }) => {
          assert(model.maybeHighlightedTurn).toEqual(Option.some({ from: "diff", id: "c1" }));
          assert(Record.get(model.openedTurns, "c1")).toEqual(Option.some(true));
        });
    }),
);

it.effect(
  "after ClickedHunkMark the session pane shows the turn open and active, and the diff its hunks",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(after(showing, Message.ClickedHunkMark({ id: "c1" })));
      s.pipe(drawn)
        .expect(turn("c1"))
        .toHaveAttribute("data-active", "")
        .expect(turnButton("c1"))
        .toHaveAttribute("aria-expanded", "true")
        .expect(inside(turn("c1"), data("turn-part", "Input")))
        .toHaveText(containing("the edit's input"))
        .expect(turn("c2"))
        .toHaveAttribute("data-active", false)
        .expect(list)
        .toHaveAttribute("data-turn", "c1")
        .expect(list)
        .toHaveAttribute("data-turn-from", "diff");
    }),
);

it.effect("the diff mount is given the session, so it can mark each hunk with its turns", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(showing);
    s.expectMount(RenderDiff({ session: Option.some(session), text: commitPatch }))
      .pipe(drawn)
      .expect(list)
      .toHaveAttribute("data-turn", false);
  }),
);

it.effect(
  "opening a turn in the session pane marks its hunks from the session side; closing it clears them",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(showing);
      s.pipe(drawn)
        .click(turnButton("c2"))
        .pipe(pushedUrl)
        .expect(list)
        .toHaveAttribute("data-turn", "c2")
        .expect(list)
        .toHaveAttribute("data-turn-from", "session")
        .expect(turn("c2"))
        .toHaveAttribute("data-active", "")
        .click(turnButton("c2"))
        .pipe(pushedUrl)
        .expect(list)
        .toHaveAttribute("data-turn", false)
        .expect(list)
        .toHaveAttribute("data-turn-from", false)
        .expect(turn("c2"))
        .toHaveAttribute("data-active", false);
    }),
);

it.effect("closing a turn that is not the marked one leaves the marks alone", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(showing, Message.ClickedTurn({ id: "c1" }), Message.ClickedTurn({ id: "c2" })),
    );
    s.pipe(drawn)
      .expect(list)
      .toHaveAttribute("data-turn", "c2")
      .click(turnButton("c1"))
      .expect(turnButton("c1"))
      .toHaveAttribute("aria-expanded", "false")
      .expect(list)
      .toHaveAttribute("data-turn", "c2")
      .expect(turn("c2"))
      .toHaveAttribute("data-active", "");
  }),
);
