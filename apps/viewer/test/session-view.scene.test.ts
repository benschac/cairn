import { Session } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Record, Result, Schema, Struct } from "effect";
import { all, click, expect, expectAll, given, nth, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { SessionData, TraceData } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { TURN_LINE_LIMIT } from "../src/view/sessionView.ts";
import { view as appView } from "../src/view/view.ts";
import { loaded } from "./fixtures.ts";

/** A task with a commit that has a session; the code view on that commit asks for the session. */
const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) =>
    Array.some(each.commits, (commit) => commit.session !== null),
  ),
);
const commit = Option.getOrThrow(Array.findFirst(task.commits, (each) => each.session !== null));
const sessionId = `${commit.session}`;

const app = { update: appUpdate, view: appView };

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

const turn = (id: string) => selector(`[data-turn="${id}"]`);
const turnButton = (id: string) => selector(`[data-turn="${id}"] button[aria-expanded]`);
const pane = selector('[data-code-pane="session"]');

it("opening a commit with a session asks for it once, and shows it loading", () => {
  assert(
    Array.map(
      Option.getOrElse(Option.fromUndefinedOr(opened.commands), () => []),
      (command) => command.name,
    ),
  ).toContain("FetchSession");
  assert(Record.get(opened.model.sessions, sessionId)).toEqual(Option.some(SessionData.Loading()));
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
  scene(app, given(opened.model), expect(pane).toContainText(`Loading session ${sessionId}`));
  scene(
    app,
    given(
      appUpdate(
        opened.model,
        Message.ReceivedSession({ id: sessionId, result: Result.fail("HTTP 404") }),
      ).model,
    ),
    expect(selector('[data-code-pane="session"] [role="alert"]')).toContainText("HTTP 404"),
  );
});

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

it("turns are listed in order, with a label that names prompts and replies", () => {
  scene(
    app,
    given(showing(sessionOf([prompt, tool("c1"), reply]))),
    expect(pane).toContainText(`Session ${sessionId}`),
    expectAll(all.selector("[data-turn]")).toHaveCount(3),
    expect(nth(all.selector("[data-turn]"), 0)).toHaveAttr("data-turn", "p1"),
    expect(nth(all.selector("[data-turn]"), 1)).toHaveAttr("data-turn", "c1"),
    expect(nth(all.selector("[data-turn]"), 2)).toHaveAttr("data-turn", "r1"),
    expect(selector("#turn-p1 [data-turn-label]")).toHaveText("Prompt"),
    expect(selector("#turn-r1 [data-turn-label]")).toHaveText("Reply"),
    expect(turn("p1")).toContainText("Add the pane."),
  );
});

it("a tool turn is one button line with its name and target, and a failed one says so", () => {
  scene(
    app,
    given(
      showing(
        sessionOf([
          tool("c1", { name: "Edit", target: "src/a.ts", failed: true }),
          tool("c2", { edits: [{ added: ["x"], path: "src/a.ts", removed: [] }] }),
          tool("c3"),
        ]),
      ),
    ),
    expect(turnButton("c1")).toContainText("Edit"),
    expect(turnButton("c1")).toContainText("src/a.ts"),
    expect(selector('[data-turn="c1"] [data-mark="failed"]')).toExist(),
    expect(selector('[data-turn="c2"] [data-mark="edits"]')).toExist(),
    expect(selector('[data-turn="c2"] [data-mark="failed"]')).toBeAbsent(),
    expect(selector('[data-turn="c3"] [data-mark]')).toBeAbsent(),
    expect(turnButton("c1")).toHaveAttr("aria-expanded", "false"),
    expect(selector('[data-turn="c1"] pre')).toBeAbsent(),
  );
});

it("clicking a tool turn opens it, showing its input and output, and clicking again closes it", () => {
  scene(
    app,
    given(showing(sessionOf([tool("c1", { input: "git status", output: "clean" })]))),
    click(turnButton("c1")),
    expect(turnButton("c1")).toHaveAttr("aria-expanded", "true"),
    expect(selector('[data-turn="c1"] [data-turn-part="Input"] pre')).toHaveText("git status"),
    expect(selector('[data-turn="c1"] [data-turn-part="Output"] pre')).toHaveText("clean"),
    click(turnButton("c1")),
    expect(turnButton("c1")).toHaveAttr("aria-expanded", "false"),
    expect(selector('[data-turn="c1"] pre')).toBeAbsent(),
  );
});

it("an opened turn is cut at 200 lines until its button asks for the rest", () => {
  const long = Array.join(
    Array.makeBy(TURN_LINE_LIMIT + 50, (index) => `line ${index}`),
    "\n",
  );
  scene(
    app,
    given(showing(sessionOf([tool("c1", { output: long })]))),
    click(turnButton("c1")),
    expect(selector('[data-turn="c1"] [data-turn-part="Output"] pre')).toContainText(
      `line ${TURN_LINE_LIMIT - 1}`,
    ),
    expect(selector('[data-turn="c1"] [data-turn-part="Output"] pre')).not.toContainText(
      `line ${TURN_LINE_LIMIT}`,
    ),
    expect(turn("c1")).toContainText("Show the rest (50 more lines)"),
    click(selector('[data-more-of-turn="c1"]')),
    expect(selector('[data-turn="c1"] [data-turn-part="Output"] pre')).toContainText(
      `line ${TURN_LINE_LIMIT + 49}`,
    ),
    expect(selector('[data-more-of-turn="c1"]')).toBeAbsent(),
  );
});

it("a short turn has no button for the rest", () => {
  scene(
    app,
    given(showing(sessionOf([tool("c1")]))),
    click(turnButton("c1")),
    expect(selector('[data-more-of-turn="c1"]')).toBeAbsent(),
  );
});

it("a redaction renders as a chip naming the kind, in a prompt, a reply and a tool output", () => {
  scene(
    app,
    given(
      showing(
        sessionOf([
          { ...prompt, text: "Use key [REDACTED:anthropic] now" },
          { ...reply, text: "I sent it to **[REDACTED:email]**." },
          tool("c1", { output: "token=[REDACTED:github]\nok" }),
        ]),
      ),
    ),
    expect(selector('#turn-p1 [data-redacted="anthropic"]')).toHaveText("redacted: anthropic"),
    expect(turn("p1")).not.toContainText("[REDACTED"),
    expect(selector('#turn-r1 [data-redacted="email"]')).toExist(),
    click(turnButton("c1")),
    expect(selector('#turn-c1 [data-redacted="github"]')).toExist(),
  );
});

it("a redaction in inline code, a fenced block or a tool target is a chip too, and plain code stays highlighted", () => {
  scene(
    app,
    given(
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
    ),
    expect(selector('#turn-p1 code [data-redacted="url"]')).toExist(),
    expect(selector('#turn-p1 pre [data-redacted="openai"]')).toExist(),
    expect(selector("#turn-p1 pre")).not.toContainText("[REDACTED"),
    expect(selector('#turn-c1 [data-tool-target] [data-redacted="url"]')).toExist(),
    expect(selector("#turn-r1 pre code.language-ts")).toExist(),
  );
});

it("raw HTML in a prompt is not rendered as markup", () => {
  scene(
    app,
    given(showing(sessionOf([{ ...prompt, text: "<img src=x onerror=alert(1)> hello" }]))),
    expect(selector("#turn-p1 img")).toBeAbsent(),
    expect(turn("p1")).toContainText("hello"),
  );
});

it("the top shows the session ID, its notes and the redaction count of each kind", () => {
  scene(
    app,
    given(
      showing(
        sessionOf([prompt], {
          notes: [
            { at: "2026-11-25T11:00:00.000Z", author: "ben", body: "Looks right.", kind: "review" },
          ],
          redactions: { email: 2, anthropic: 1, github: 0 },
        }),
      ),
    ),
    expect(selector("[data-session-header] h3")).toContainText(sessionId),
    expect(selector("[data-notes]")).toContainText("review by ben"),
    expect(selector("[data-notes]")).toContainText("Looks right."),
    expect(selector('[data-redaction-kind="email"]')).toHaveText("email: 2 redacted"),
    expect(selector('[data-redaction-kind="anthropic"]')).toHaveText("anthropic: 1 redacted"),
    expect(selector('[data-redaction-kind="github"]')).toBeAbsent(),
  );
});

it("skipped lines show at the bottom only when there are some", () => {
  scene(
    app,
    given(showing(sessionOf([prompt], { skipped: 3 }))),
    expect(selector("[data-skipped]")).toHaveText("Cairn skipped 3 lines it could not read."),
  );
  scene(app, given(showing(sessionOf([prompt]))), expect(selector("[data-skipped]")).toBeAbsent());
});

it("a session in a format Cairn cannot read says so and lists no turns", () => {
  scene(
    app,
    given(showing(sessionOf([], { format: "unknown", skipped: 12 }))),
    expect(pane).toContainText("Cairn cannot read that agent's log yet."),
    expect(selector("[data-turns]")).toBeAbsent(),
    expect(selector("[data-skipped]")).toExist(),
  );
});

it("a commit with no session says so", () => {
  const stripped = Struct.evolve(task, {
    commits: (commits) =>
      Array.map(commits, (each) => Struct.evolve(each, { session: () => null })),
  });
  const model = modifyFields(loaded, {
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
  scene(app, given(without.model), expect(pane).toContainText("No session was recorded"));
});

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
