import { UiStruct } from "@effect/ui";
import { Session } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Record, Result, Schema, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { SessionData, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { TURN_LINE_LIMIT } from "../src/view/sessionView.ts";
import {
  attr,
  both,
  containing,
  data,
  inside,
  loaded,
  notContaining,
  nth,
  pushedUrl,
  tag,
  viewerScene,
  withClass,
} from "./fixtures.ts";

/** A task with a commit that has a session; the code view on that commit asks for the session. */
const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) =>
    Array.some(each.commits, (commit) => commit.session !== null),
  ),
);
const commit = Option.getOrThrow(Array.findFirst(task.commits, (each) => each.session !== null));
const sessionId = `${commit.session}`;

type Turns = ReadonlyArray<Record<string, unknown>>;

const prompt = { at: "2026-11-25T10:00:00.000Z", id: "p1", kind: "prompt", text: "Add the pane." };
const reply = { at: "2026-11-25T10:00:01.000Z", id: "r1", kind: "reply", text: "Done." };
const tool = (id: string, extra: Record<string, unknown> = {}) => ({
  at: "2026-11-25T10:00:02.000Z",
  edits: [],
  failed: false,
  id,
  input: "ls",
  kind: "tool",
  name: "Bash",
  output: "a.ts",
  target: null,
  ...extra,
});

const sessionOf = (turns: Turns, extra: Record<string, unknown> = {}): Session =>
  Schema.decodeUnknownSync(Session)({
    format: "claude-code",
    id: sessionId,
    notes: [],
    redactions: {},
    skipped: 0,
    taskId: "t1",
    turns,
    version: 1,
    ...extra,
  });

const opened = appUpdate(
  loaded,
  Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
);

/** The code view on the commit, with this session arrived. */
const showing = (session: Session) =>
  appUpdate(
    opened.model,
    Message.ReceivedSession({ id: sessionId, result: Result.succeed(session) }),
  ).model;

const turn = (id: string) => data("turn", id);
const turnButton = (id: string) => inside(turn(id), both(tag("button"), attr("aria-expanded")));
const pane = data("code-pane", "session");
const turnId = (id: string) => attr("id", `turn-${id}`);
const output = (id: string) => inside(turn(id), inside(data("turn-part", "Output"), tag("pre")));
const moreOf = (id: string) => data("more-of-turn", id);

it.effect("opening a commit with a session asks for it once, and shows it loading", () =>
  Effect.gen(function* () {
    assert(
      Array.map(
        Option.getOrElse(Option.fromUndefinedOr(opened.commands), () => []),
        (command) => command.name,
      ),
    ).toContain("FetchSession");
    assert(Record.get(opened.model.sessions, sessionId)).toEqual(
      Option.some(SessionData.Loading()),
    );
    const again = appUpdate(
      opened.model,
      Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
    );
    assert(
      Array.some(
        Option.getOrElse(Option.fromUndefinedOr(again.commands), () => []),
        (command) => command.name === "FetchSession",
      ),
    ).toBe(false);
    const loading = yield* viewerScene(opened.model);
    loading.expect(pane).toHaveText(containing(`Loading session ${sessionId}`));
    const failed = yield* viewerScene(
      appUpdate(
        opened.model,
        Message.ReceivedSession({ id: sessionId, result: Result.fail("HTTP 404") }),
      ).model,
    );
    failed.expect(inside(pane, attr("role", "alert"))).toHaveText(containing("HTTP 404"));
  }),
);

it("a failed session is fetched again when the commit is selected again", () => {
  const failed = appUpdate(
    opened.model,
    Message.ReceivedSession({ id: sessionId, result: Result.fail("unreachable") }),
  ).model;
  const again = appUpdate(
    failed,
    Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
  );
  assert(
    Array.map(
      Option.getOrElse(Option.fromUndefinedOr(again.commands), () => []),
      (command) => command.name,
    ),
  ).toContain("FetchSession");
});

it.effect("turns are listed in order, with a label that names prompts and replies", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(showing(sessionOf([prompt, tool("c1"), reply])));
    s.expect(pane)
      .toHaveText(containing(`Session ${sessionId}`))
      .expect(data("turn"))
      .toHaveCount(3)
      .expect(nth(data("turn"), 0))
      .toHaveAttribute("data-turn", "p1")
      .expect(nth(data("turn"), 1))
      .toHaveAttribute("data-turn", "c1")
      .expect(nth(data("turn"), 2))
      .toHaveAttribute("data-turn", "r1")
      .expect(inside(turnId("p1"), data("turn-label")))
      .toHaveText("Prompt")
      .expect(inside(turnId("r1"), data("turn-label")))
      .toHaveText("Reply")
      .expect(turn("p1"))
      .toHaveText(containing("Add the pane."));
  }),
);

it.effect("a tool turn is one button line with its name and target, and a failed one says so", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      showing(
        sessionOf([
          tool("c1", { name: "Edit", target: "src/a.ts", failed: true }),
          tool("c2", { edits: [{ added: ["x"], path: "src/a.ts", removed: [] }] }),
          tool("c3"),
        ]),
      ),
    );
    s.expect(turnButton("c1"))
      .toHaveText(containing("Edit"))
      .expect(turnButton("c1"))
      .toHaveText(containing("src/a.ts"))
      .expect(inside(turn("c1"), data("mark", "failed")))
      .toExist()
      .expect(inside(turn("c2"), data("mark", "edits")))
      .toExist()
      .expect(inside(turn("c2"), data("mark", "failed")))
      .toBeAbsent()
      .expect(inside(turn("c3"), data("mark")))
      .toBeAbsent()
      .expect(turnButton("c1"))
      .toHaveAttribute("aria-expanded", "false")
      .expect(inside(turn("c1"), tag("pre")))
      .toBeAbsent();
  }),
);

it.effect(
  "clicking a tool turn opens it, showing its input and output, and clicking again closes it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(
        showing(sessionOf([tool("c1", { input: "git status", output: "clean" })])),
      );
      s.click(turnButton("c1"))
        .pipe(pushedUrl)
        .expect(turnButton("c1"))
        .toHaveAttribute("aria-expanded", "true")
        .expect(inside(turn("c1"), inside(data("turn-part", "Input"), tag("pre"))))
        .toHaveText("git status")
        .expect(output("c1"))
        .toHaveText("clean")
        .click(turnButton("c1"))
        .pipe(pushedUrl)
        .expect(turnButton("c1"))
        .toHaveAttribute("aria-expanded", "false")
        .expect(inside(turn("c1"), tag("pre")))
        .toBeAbsent();
    }),
);

it.effect("an opened turn is cut at 200 lines until its button asks for the rest", () =>
  Effect.gen(function* () {
    const long = Array.join(
      Array.makeBy(TURN_LINE_LIMIT + 50, (index) => `line ${index}`),
      "\n",
    );
    const s = yield* viewerScene(showing(sessionOf([tool("c1", { output: long })])));
    s.click(turnButton("c1"))
      .pipe(pushedUrl)
      .expect(output("c1"))
      .toHaveText(containing(`line ${TURN_LINE_LIMIT - 1}`))
      .expect(output("c1"))
      .toHaveText(notContaining(`line ${TURN_LINE_LIMIT}`))
      .expect(turn("c1"))
      .toHaveText(containing("Show the rest (50 more lines)"))
      .click(moreOf("c1"))
      .expect(output("c1"))
      .toHaveText(containing(`line ${TURN_LINE_LIMIT + 49}`))
      .expect(moreOf("c1"))
      .toBeAbsent();
  }),
);

it.effect("a short turn has no button for the rest", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(showing(sessionOf([tool("c1")])));
    s.click(turnButton("c1")).pipe(pushedUrl).expect(moreOf("c1")).toBeAbsent();
  }),
);

it.effect(
  "a redaction renders as a chip naming the kind, in a prompt, a reply and a tool output",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(
        showing(
          sessionOf([
            { ...prompt, text: "Use key [REDACTED:anthropic] now" },
            { ...reply, text: "I sent it to **[REDACTED:email]**." },
            tool("c1", { output: "token=[REDACTED:github]\nok" }),
          ]),
        ),
      );
      s.expect(inside(turnId("p1"), data("redacted", "anthropic")))
        .toHaveText("redacted: anthropic")
        .expect(turn("p1"))
        .toHaveText(notContaining("[REDACTED"))
        .expect(inside(turnId("r1"), data("redacted", "email")))
        .toExist()
        .click(turnButton("c1"))
        .pipe(pushedUrl)
        .expect(inside(turnId("c1"), data("redacted", "github")))
        .toExist();
    }),
);

it.effect(
  "a redaction in inline code, a fenced block or a tool target is a chip too, and plain code stays highlighted",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(
        showing(
          sessionOf([
            {
              ...prompt,
              text: "Run `curl [REDACTED:url]` then:\n\n```ts\nconst k = '[REDACTED:openai]';\n```",
            },
            { ...reply, text: "```ts\nconst a = 1;\n```" },
            tool("c1", { target: "curl [REDACTED:url]" }),
          ]),
        ),
      );
      s.expect(inside(turnId("p1"), inside(tag("code"), data("redacted", "url"))))
        .toExist()
        .expect(inside(turnId("p1"), inside(tag("pre"), data("redacted", "openai"))))
        .toExist()
        .expect(inside(turnId("p1"), tag("pre")))
        .toHaveText(notContaining("[REDACTED"))
        .expect(inside(turnId("c1"), inside(data("tool-target"), data("redacted", "url"))))
        .toExist()
        .expect(
          inside(turnId("r1"), inside(tag("pre"), both(tag("code"), withClass("language-ts")))),
        )
        .toExist();
    }),
);

it.effect("raw HTML in a prompt is not rendered as markup", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      showing(sessionOf([{ ...prompt, text: "<img src=x onerror=alert(1)> hello" }])),
    );
    s.expect(inside(turnId("p1"), tag("img")))
      .toBeAbsent()
      .expect(turn("p1"))
      .toHaveText(containing("hello"));
  }),
);

it.effect("the top shows the session ID, its notes and the redaction count of each kind", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(
      showing(
        sessionOf([prompt], {
          notes: [
            {
              anchor: "/task/t1",
              at: "2026-11-25T11:00:00.000Z",
              author: "ben",
              body: "Looks right.",
              id: "n_review0001",
              kind: "review",
              resolvedAt: null,
              session: sessionId,
              status: "open",
              task: "t1",
            },
          ],
          redactions: { email: 2, anthropic: 1, github: 0 },
        }),
      ),
    );
    s.expect(inside(data("session-header"), tag("h3")))
      .toHaveText(containing(sessionId))
      .expect(data("notes"))
      .toHaveText(containing("review by ben"))
      .expect(data("notes"))
      .toHaveText(containing("Looks right."))
      .expect(data("redaction-kind", "email"))
      .toHaveText("email: 2 redacted")
      .expect(data("redaction-kind", "anthropic"))
      .toHaveText("anthropic: 1 redacted")
      .expect(data("redaction-kind", "github"))
      .toBeAbsent();
  }),
);

it.effect("skipped lines show at the bottom only when there are some", () =>
  Effect.gen(function* () {
    const some = yield* viewerScene(showing(sessionOf([prompt], { skipped: 3 })));
    some.expect(data("skipped")).toHaveText("Cairn skipped 3 lines it could not read.");
    const none = yield* viewerScene(showing(sessionOf([prompt])));
    none.expect(data("skipped")).toBeAbsent();
  }),
);

it.effect("a session in a format Cairn cannot read says so and lists no turns", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(showing(sessionOf([], { format: "unknown", skipped: 12 })));
    s.expect(pane)
      .toHaveText(containing("Cairn cannot read that agent's log yet."))
      .expect(data("turns"))
      .toBeAbsent()
      .expect(data("skipped"))
      .toExist();
  }),
);

it.effect("a commit with no session says so", () =>
  Effect.gen(function* () {
    const stripped = Struct.evolve(task, {
      commits: (commits) =>
        Array.map(commits, (each) => Struct.evolve(each, { session: () => null })),
    });
    const model = UiStruct.evolve(loaded, {
      trace: () =>
        TraceData.Success({
          data: Struct.evolve(demoTrace, {
            tasks: (tasks) => Array.map(tasks, (each) => (each.id === task.id ? stripped : each)),
          }),
        }),
    });
    const without = appUpdate(
      model,
      Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
    );
    assert(
      Array.map(
        Option.getOrElse(Option.fromUndefinedOr(without.commands), () => []),
        (command) => command.name,
      ),
    ).toEqual(["FetchPatch"]);
    const s = yield* viewerScene(without.model);
    s.expect(pane).toHaveText(containing("No session was recorded"));
  }),
);

it.prop(
  "opening a turn twice leaves it closed, and showing the rest is kept",
  { id: Schema.String },
  ({ id }) => {
    const once = appUpdate(loaded, Message.ClickedTurn({ id })).model;
    assert(Record.get(once.openedTurns, id)).toEqual(Option.some(true));
    const twice = appUpdate(once, Message.ClickedTurn({ id })).model;
    assert(Record.get(twice.openedTurns, id)).toEqual(Option.some(false));
    const more = appUpdate(twice, Message.ClickedMoreOfTurn({ id })).model;
    assert(Record.get(appUpdate(more, Message.ClickedTurn({ id })).model.fullTurns, id)).toEqual(
      Option.some(true),
    );
  },
);
