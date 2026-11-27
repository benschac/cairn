import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Array, Effect, Schema, String } from "effect";

import { Event, EventJson, Trailers, formatTrailers as coreFormat } from "../src/index.ts";
import { CairnContractError, appendEvent, parseEvent, trailerArgs } from "../src/js.ts";

const scratch = () =>
  join(realpathSync(mkdtempSync(join(tmpdir(), "cairn-append-"))), "events.jsonl");
const lines = (path: string) =>
  Array.filter(String.split(readFileSync(path, "utf8"), "\n"), String.isNonEmpty);
const execFileAsync = promisify(execFile);
const isContractError = Schema.is(CairnContractError);

it.prop(
  "appendEvent writes one line per event that parseEvent reads back",
  [Schema.Array(Event)],
  ([events]) => {
    const path = scratch();
    Array.forEach(events, (event) => appendEvent(path, Schema.encodeSync(Event)(event)));
    if (Array.isReadonlyArrayEmpty(events)) return;
    expect(String.endsWith("\n")(readFileSync(path, "utf8"))).toBe(true);
    expect(Array.map(lines(path), parseEvent)).toEqual(events);
  },
);

it.prop("appendEvent keeps what is already in the file", [Event, Event], ([first, second]) => {
  const path = scratch();
  const existing = Schema.encodeSync(EventJson)(first);
  writeFileSync(path, `${existing}\n`);
  appendEvent(path, Schema.encodeSync(Event)(second));
  expect(Array.map(lines(path), parseEvent)).toEqual([first, second]);
});

it("appendEvent fills the defaults and refuses an invalid event without writing", () => {
  const path = scratch();
  appendEvent(path, { status: "running", taskId: "t1", ts: "2026-01-01T00:00:00Z" });
  const written = Array.map(lines(path), parseEvent);
  expect(Array.map(written, (event) => [event.v, event.actor])).toEqual([[1, "orchestrator"]]);
  let error: unknown;
  try {
    appendEvent(path, { status: "bogus", taskId: "t1", ts: "2026-01-01T00:00:00Z" });
  } catch (caught) {
    error = caught;
  }
  expect(isContractError(error) && error.path).toBe("status");
  expect(lines(path)).toHaveLength(1);
});

it("appendEvent starts a new line after an unterminated last event", () => {
  const path = scratch();
  const running = '{"status":"running","taskId":"t1","ts":"2026-01-01T00:00:00Z"}';
  writeFileSync(path, running);
  appendEvent(path, { status: "done", taskId: "t1", ts: "2026-01-01T00:00:00Z" });
  expect(Array.map(lines(path), (line) => parseEvent(line).status)).toEqual(["running", "done"]);
});

it.effect(
  "appendEvent from concurrent processes never interleaves lines",
  () =>
    Effect.gen(function* () {
      const path = scratch();
      const script = join(path, "..", "writer.ts");
      const module = join(import.meta.dirname, "../src/js.ts");
      writeFileSync(
        script,
        `const { appendEvent } = await import(process.argv[4]);
for (let i = 0; i < 200; i++) {
  appendEvent(process.argv[2], { detail: process.argv[3] + " ".repeat(2000) + i, status: "running", taskId: "t1", ts: "2026-01-01T00:00:00Z" });
}
`,
      );
      yield* Effect.forEach(
        ["a", "b", "c", "d"],
        (tag) => Effect.tryPromise(() => execFileAsync("node", [script, path, tag, module])),
        { concurrency: "unbounded" },
      );
      expect(lines(path)).toHaveLength(800);
      expect(Array.every(lines(path), (line) => parseEvent(line).taskId === "t1")).toBe(true);
    }),
  60_000,
);

it.prop("trailerArgs is formatTrailers as --trailer pairs", [Trailers], ([trailers]) => {
  const args = trailerArgs(trailers);
  expect(Array.filter(args, (_, index) => index % 2 === 0)).toEqual(
    Array.makeBy(args.length / 2, () => "--trailer"),
  );
  expect(
    Array.join(
      Array.filter(args, (_, index) => index % 2 === 1),
      "\n",
    ),
  ).toBe(coreFormat(trailers));
});
