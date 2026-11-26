import { PrdSectionId, Sha, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Predicate, Result, String, Struct } from "effect";
import { modifyFields } from "foldkit/struct";
import { vi } from "vitest";

import { FetchPatch, FetchSession } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import rangePatch from "./fixtures/range.patch?raw";
import {
  attr,
  both,
  byRole,
  containing,
  data,
  drawnDiff,
  loaded,
  pushedUrl,
  readerMounted,
  resolved,
  sent,
  sessionWith,
  styled,
  viewerScene,
} from "./fixtures.ts";

const sha = (character: string) => Sha.make(String.repeat(40)(character));

/** A task with two commits, the first with a session and the second without, and a task with none. */
const stackedBase = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) =>
    Option.exists(Array.head(t.commits), (commit) => Predicate.isNotNull(commit.session)),
  ),
);
const template = Option.getOrThrow(Array.head(stackedBase.commits));
const first = Struct.evolve(template, {
  files: () => ["src/a.ts", "src/view/b.ts"],
  parents: () => [sha("0")],
  sha: () => sha("a"),
  subject: () => "First",
});
const second = Struct.evolve(template, {
  files: () => ["src/view/b.ts", "docs/c.md"],
  parents: () => [sha("a")],
  session: () => null,
  sha: () => sha("b"),
  subject: () => "Second",
});
const stacked = Struct.evolve(stackedBase, { commits: () => [first, second] });
const bare = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (t) => Array.isReadonlyArrayEmpty(t.commits)),
);
const trace = Struct.evolve(demoTrace, {
  tasks: (tasks) => Array.map(tasks, (t) => (t.id === stacked.id ? stacked : t)),
});
const model = modifyFields(loaded, { trace: () => TraceData.Success({ data: trace }) });

/** A PRD section a person can pin on the reader. */
const prdSection = PrdSectionId.make("prd.goal");

const backButton = byRole("button", { name: "Back to the plan" });
const treeTask = (id: string) => data("tree-task", id);
const treeCommit = (value: string) => data("tree-commit", value);
const treeFile = (path: string) => data("tree-file", path);
const patch = data("patch-path");
const currentRow = attr("aria-current");
const wholePath = `/api/diffs/${sha("0")}/${sha("b")}`;
const commitPath = (value: string) => `/api/commits/${sha(value)}`;

/** The fetch of a path is answered with its text, or with a failure. */
const fetched = (path: string, result: Result.Result<string, string>) =>
  resolved(FetchPatch, Message.ReceivedPatch({ path, result }));

/** The fetch of a session is answered with it. */
const fetchedSession = (id: string) =>
  resolved(FetchSession, Message.ReceivedSession({ id, result: Result.succeed(sessionWith(id)) }));

/** The model after these messages, from the loaded trace. */
const after = (...messages: ReadonlyArray<Message>) =>
  Array.reduce(messages, model, (current, message) => appUpdate(current, message).model);

it.effect("Open code on a task opens its whole diff, and its tree row is the current one", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(model);
    s.pipe(
      readerMounted,
      sent(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })),
      pushedUrl,
      fetched(wholePath, Result.succeed(rangePatch)),
      drawnDiff,
    )
      .expect(treeTask(stacked.id))
      .toHaveAttribute("aria-current", "true")
      .expect(patch)
      .toHaveAttribute("data-patch-path", wholePath)
      .expect(data("shown"))
      .toHaveText(containing("2 commits"))
      .expect(data("shown"))
      .toHaveText(containing(`${String.takeLeft(sha("0"), 7)}..${String.takeLeft(sha("b"), 7)}`))
      .expect(data("code-bar"))
      .toHaveText(containing(stacked.branch));
  }),
);

it.effect("a commit opens that commit, and the session pane shows its session", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(model);
    s.pipe(
      readerMounted,
      sent(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("a")) })),
      pushedUrl,
      fetched(commitPath("a"), Result.succeed(commitPatch)),
      // The diff is keyed by its session once it is read, so the session's arrival draws it again.
      drawnDiff,
      fetchedSession(`${template.session}`),
      drawnDiff,
    )
      .expect(treeCommit(sha("a")))
      .toHaveAttribute("aria-current", "true")
      .expect(currentRow)
      .toHaveCount(1)
      .expect(patch)
      .toHaveAttribute("data-patch-path", `/api/commits/${sha("a")}`)
      .expect(data("shown"))
      .toHaveText(containing("First"))
      .expect(data("session-id"))
      .toHaveAttribute("data-session-id", `${template.session}`);
  }),
);

it.effect("the tree selects a task, a commit and a file, one current row at a time", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })),
    );
    s.expect(treeFile("src/a.ts"))
      .toExist()
      .expect(treeFile("docs/c.md"))
      .toExist()
      .click(treeFile("src/view/b.ts"))
      .pipe(pushedUrl)
      .expect(treeFile("src/view/b.ts"))
      .toHaveAttribute("aria-current", "true")
      .expect(patch)
      .toHaveAttribute("data-file", "src/view/b.ts")
      .expect(patch)
      .toHaveAttribute("data-patch-path", wholePath)
      .click(treeCommit(sha("b")))
      .pipe(pushedUrl, fetched(commitPath("b"), Result.succeed(commitPatch)), drawnDiff)
      .expect(treeCommit(sha("b")))
      .toHaveAttribute("aria-current", "true")
      .expect(patch)
      .toHaveAttribute("data-patch-path", `/api/commits/${sha("b")}`)
      .expect(treeFile("src/a.ts"))
      .toBeAbsent()
      .expect(data("session-id"))
      .toBeAbsent()
      .click(treeFile("docs/c.md"))
      .pipe(pushedUrl)
      .expect(currentRow)
      .toHaveCount(2)
      .click(treeTask(stacked.id))
      .pipe(pushedUrl)
      .expect(treeTask(stacked.id))
      .toHaveAttribute("aria-current", "true")
      .expect(currentRow)
      .toHaveCount(1)
      .expect(patch)
      .toHaveAttribute("data-patch-path", wholePath);
  }),
);

it.effect("the tree is three panes of the right widths, each pane scrolling on its own", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })),
    );
    s.expect(both(data("code-pane", "tree"), styled("width", "280px")))
      .toExist()
      .expect(both(data("code-pane", "tree"), styled("overflow-y", "auto")))
      .toExist()
      .expect(both(data("code-pane", "session"), styled("width", "420px")))
      .toExist()
      .expect(both(data("code-pane", "session"), styled("overflow-y", "auto")))
      .toExist()
      .expect(data("code-pane", "diff"))
      .toExist();
  }),
);

it.effect("a task with no commits opens with a middle pane that says so", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(Message.ClickedOpenCode({ id: bare.id, maybeSha: Option.none() })),
    );
    s.expect(patch)
      .toBeAbsent()
      .expect(data("code-pane", "diff"))
      .toHaveText(containing("This task has no commits."))
      .expect(data("code-pane", "session"))
      .toHaveText(containing("No session"));
  }),
);

it.effect("back to the plan returns the reader with its pin as it was", () =>
  Effect.gen(function* () {
    const pinned = after(Message.ClickedStatusLine({ id: prdSection }));
    const there = appUpdate(
      pinned,
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    ).model;
    const s = yield* viewerScene(there);
    s.expect(data("code-view"))
      .toExist()
      .click(backButton)
      .pipe(pushedUrl, readerMounted)
      .expect(data("reader"))
      .toExist()
      .expect(data("code-view"))
      .toBeAbsent();
  }),
);

it("opening the code view and going back changes only the screen", () => {
  const pinned = after(Message.ClickedStatusLine({ id: prdSection }));
  const there = appUpdate(
    pinned,
    Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("a")) }),
  ).model;
  assert(there.screen).toEqual(
    Screen.Code({
      maybeFile: Option.none(),
      maybeLines: Option.none(),
      shown: Shown.OneCommit({ sha: sha("a") }),
      taskId: stacked.id,
    }),
  );
  assert(appUpdate(there, Message.ClickedBackToPlan()).model).toEqual(
    modifyFields(pinned, { patches: () => there.patches, sessions: () => there.sessions }),
  );
});

const inCode = after(Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("a")) }));
const missing = TaskId.make("missing");

it("messages that name nothing the trace or the screen holds are ignored", () => {
  const cases: ReadonlyArray<readonly [typeof model, Message]> = [
    [model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.some(sha("f")) })],
    [model, Message.ClickedOpenCode({ id: bare.id, maybeSha: Option.some(sha("a")) })],
    [model, Message.ClickedOpenCode({ id: missing, maybeSha: Option.none() })],
    [model, Message.ClickedTreeTask({ id: stacked.id })],
    [model, Message.ClickedTreeCommit({ sha: sha("a") })],
    [model, Message.ClickedTreeFile({ path: "src/a.ts" })],
    [model, Message.ClickedBackToPlan()],
    [inCode, Message.ClickedTreeCommit({ sha: sha("f") })],
    [inCode, Message.ClickedTreeFile({ path: "docs/c.md" })],
    [inCode, Message.ClickedTreeTask({ id: missing })],
    [init().model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })],
  ];
  Array.forEach(cases, ([start, message]) => {
    assert(appUpdate(start, message).model).toEqual(start);
  });
});

// PATCHES

it.effect("opening a task asks for its patch route once, and shows it loading", () =>
  Effect.gen(function* () {
    const opened = appUpdate(
      model,
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    );
    assert(
      Array.map(
        Option.getOrElse(Option.fromUndefinedOr(opened.commands), () => []),
        (command) => [command.name, command.args],
      ),
    ).toEqual([["FetchPatch", { path: wholePath }]]);
    const s = yield* viewerScene(opened.model);
    s.expect(patch).toHaveText(containing("Loading"));
  }),
);

it.effect("a failed fetch shows its error, and selecting the path again fetches it again", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      after(
        Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
        Message.ReceivedPatch({ path: wholePath, result: Result.fail("unknown revision") }),
      ),
    );
    s.expect(patch)
      .toHaveText(containing("unknown revision"))
      .click(treeCommit(sha("a")))
      .pipe(
        pushedUrl,
        fetched(commitPath("a"), Result.succeed(commitPatch)),
        // The diff is keyed by its session once it is read, so the session's arrival draws it again.
        drawnDiff,
        fetchedSession(`${template.session}`),
      )
      .expect(patch)
      .toHaveAttribute("data-patch-path", commitPath("a"))
      .pipe(drawnDiff)
      .click(treeTask(stacked.id))
      .pipe(pushedUrl, fetched(wholePath, Result.succeed(rangePatch)))
      .expect(patch)
      .toHaveAttribute("data-patch-path", wholePath)
      .pipe(drawnDiff);
  }),
);

it.effect("a loaded path is not fetched again, and a loading one is not fetched twice", () =>
  Effect.gen(function* () {
    const loadedWhole = after(
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
      Message.ReceivedPatch({ path: wholePath, result: Result.succeed(rangePatch) }),
    );
    const s = yield* viewerScene(loadedWhole);
    s.pipe(drawnDiff)
      .click(treeCommit(sha("a")))
      .pipe(
        pushedUrl,
        fetched(commitPath("a"), Result.succeed(commitPatch)),
        // The diff is keyed by its session once it is read, so the session's arrival draws it again.
        drawnDiff,
        fetchedSession(`${template.session}`),
        drawnDiff,
      )
      // A loaded patch swapped for another is a new keyed element, so its mount draws again.
      .click(treeTask(stacked.id))
      .pipe(pushedUrl, drawnDiff)
      .expectNone()
      .expect(patch)
      .toHaveAttribute("data-patch-path", wholePath)
      .click(treeCommit(sha("a")))
      .pipe(pushedUrl, drawnDiff)
      .expectNone()
      .expect(patch)
      .toHaveAttribute("data-patch-path", commitPath("a"));
    const loading = appUpdate(
      appUpdate(model, Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() })).model,
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    );
    assert(loading.commands).toBeUndefined();
  }),
);

it.effect(
  "a loaded patch is handed to the mount whatever it holds, since only the mount parses it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(
        after(
          Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
          Message.ReceivedPatch({ path: wholePath, result: Result.succeed("") }),
        ),
      );
      s.expect(patch).toHaveAttribute("data-patch-path", wholePath).pipe(drawnDiff);
    }),
);

it.effect("the demo build fetches nothing and says the diff needs cairn serve", () =>
  Effect.gen(function* () {
    vi.stubEnv("PROD", true);
    const opened = appUpdate(
      model,
      Message.ClickedOpenCode({ id: stacked.id, maybeSha: Option.none() }),
    );
    assert(opened.commands).toBeUndefined();
    const s = yield* viewerScene(opened.model);
    s.expect(patch).toHaveText(containing("cairn serve"));
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
);
