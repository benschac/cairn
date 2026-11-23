import { readFileSync } from "node:fs";

import { Session, SessionId, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Option, Schema, String } from "effect";

import { sessionOf, type StoredSession } from "../src/index.ts";

const stored: StoredSession = {
  id: Schema.decodeSync(SessionId)("s_abc123"),
  notes: [],
  redactions: { email: 2 },
  taskId: Schema.decodeSync(TaskId)("t77"),
};

const fixture = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");

const toolAt = (index: number) =>
  Option.getOrThrow(Array.get(toolTurns(sessionOf(fixture, stored)), index));

const toolTurns = (session: Session) => Array.filter(session.turns, (turn) => turn.kind === "tool");

it("reads the fixture turn by turn", () => {
  const session = sessionOf(fixture, stored);
  const shape = Array.map(session.turns, (turn) => [turn.kind, turn.id]);
  expect(shape).toEqual([
    ["prompt", "u-1"],
    ["reply", "a-1:1"],
    ["tool", "toolu_edit"],
    ["tool", "toolu_write"],
    ["tool", "toolu_bash"],
    ["tool", "toolu_pending"],
    ["tool", "toolu_outside"],
    ["reply", "a-7:0"],
  ]);
  expect(session).toMatchObject({
    format: "claude-code",
    id: stored.id,
    redactions: { email: 2 },
    skipped: 1,
    taskId: stored.taskId,
    version: 1,
  });
  expect(Schema.is(Session)(session)).toBe(true);
});

it("reads a prompt and a reply with their text and times", () => {
  const turns = sessionOf(fixture, stored).turns;
  const prompt = Option.getOrThrow(Array.get(turns, 0));
  const reply = Option.getOrThrow(Array.get(turns, 1));
  expect(prompt).toMatchObject({ kind: "prompt", text: "Add a greeting to the readme" });
  expect(reply).toMatchObject({ kind: "reply", text: "I will edit the readme." });
  expect(DateTime.formatIso(prompt.at)).toBe("2026-01-01T10:00:00.000Z");
});

it("takes an edit's lines from its patch, with paths relative to cwd", () => {
  const [edit, write] = toolTurns(sessionOf(fixture, stored));
  expect(edit).toMatchObject({
    edits: [{ added: ["# Repo", "", "Hello"], path: "README.md", removed: ["# Repo"] }],
    failed: false,
    name: "Edit",
    output: "The file has been updated.",
    target: "/work/repo/README.md",
  });
  expect(write).toMatchObject({
    edits: [
      {
        added: ['export const greet = "hi";', 'export const bye = "bye";'],
        path: "src/greet.ts",
        removed: [],
      },
    ],
  });
});

it("marks a failed call and joins its text output", () => {
  const bash = toolAt(2);
  expect(bash).toMatchObject({
    edits: [],
    failed: true,
    output: "Exit code 1\n1 test failed",
    target: "pnpm test",
  });
});

it("keeps a call with no result empty", () => {
  const pending = toolAt(3);
  expect(pending).toMatchObject({ edits: [], failed: false, output: "" });
});

it("leaves out an edit outside cwd but keeps the turn", () => {
  const outside = toolAt(4);
  expect(outside).toMatchObject({
    edits: [],
    id: "toolu_outside",
    output: "The file has been updated.",
  });
});

it("reads a log with no type, uuid and message as unknown", () => {
  const session = sessionOf('{"type":"mode"}\n{"uuid":"x"}\nnot json\n', stored);
  expect(session).toMatchObject({ format: "unknown", turns: [] });
  expect(Schema.is(Session)(session)).toBe(true);
  expect(sessionOf("", stored)).toMatchObject({ format: "unknown", skipped: 0, turns: [] });
});

it("counts each undecodable line of a read type once, and no other type", () => {
  const bad = '{"type":"assistant","uuid":"a","message":{"content":"x"}}';
  const other = '{"type":"api-request","uuid":"b","message":{}}';
  const log = Array.join([fixture, bad, bad, other, ""], "\n");
  expect(sessionOf(log, stored).skipped).toBe(3);
});

const Words = Schema.Literals([
  "alpha",
  "beta",
  "const x = 1;",
  "",
  "  indented",
  "+plus",
  "-minus",
]);

const Call = Schema.Struct({
  added: Schema.Array(Words),
  context: Schema.Array(Words),
  name: Schema.Literals(["Edit", "Write", "MultiEdit"]),
  removed: Schema.Array(Words),
});

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const logOf = (calls: ReadonlyArray<typeof Call.Type>) =>
  Array.join(
    Array.flatMap(calls, (call, index) => {
      const id = `toolu_${index}`;
      const line = { cwd: "/work/repo", timestamp: "2026-01-01T10:00:00.000Z" };
      return [
        encode({
          ...line,
          message: {
            content: [
              { id, input: { file_path: "/work/repo/a.ts" }, name: call.name, type: "tool_use" },
            ],
          },
          type: "assistant",
          uuid: `a-${index}`,
        }),
        encode({
          ...line,
          message: { content: [{ content: "ok", tool_use_id: id, type: "tool_result" }] },
          toolUseResult: {
            filePath: "/work/repo/a.ts",
            structuredPatch: [
              {
                lines: Array.flatten([
                  Array.map(call.context, (text) => ` ${text}`),
                  Array.map(call.removed, (text) => `-${text}`),
                  Array.map(call.added, (text) => `+${text}`),
                ]),
              },
            ],
          },
          type: "user",
          uuid: `u-${index}`,
        }),
      ];
    }),
    "\n",
  );

it.prop(
  "gives each tool_use ID one tool turn, whose edit is the + and - lines of its patch",
  { calls: Schema.Array(Call) },
  ({ calls }) => {
    const turns = toolTurns(sessionOf(logOf(calls), stored));
    expect(Array.map(turns, ({ id }) => id)).toEqual(
      Array.map(calls, (_, index) => `toolu_${index}`),
    );
    Array.forEach(Array.zip(turns, calls), ([turn, call]) => {
      expect(turn.edits).toEqual([{ added: call.added, path: "a.ts", removed: call.removed }]);
    });
  },
);

it.prop(
  "reads no tool turn twice when a log repeats its lines",
  { calls: Schema.Array(Call) },
  ({ calls }) => {
    const log = logOf(calls);
    const once = sessionOf(log, stored);
    expect(sessionOf(Array.join([log, log], "\n"), stored).turns).toEqual(once.turns);
    expect(String.isNonEmpty(log) || Option.isNone(Array.head(once.turns))).toBe(true);
  },
);
