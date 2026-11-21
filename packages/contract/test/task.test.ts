import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import { Task } from "../src/index.ts";

const TaskJson = Schema.fromJsonString(Task);
const encode = Schema.encodeSync(TaskJson);
const decode = Schema.decodeUnknownSync(TaskJson);
const decodeTask = Schema.decodeUnknownExit(Task);

it.prop("a task survives a round trip through JSON", [Task], ([task]) => {
  expect(decode(encode(task))).toEqual(task);
});

it.prop("a task without a section is refused", [Task], ([task]) => {
  expect(Exit.isFailure(decodeTask({ ...task, section: "" }))).toBe(true);
});
