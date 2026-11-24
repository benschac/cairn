import { expect, it } from "@effect/vitest";
import { Array, Order, Record } from "effect";

import { TaskEventType, TaskEvents } from "../src/index.ts";

it("every task event type names an event the machine accepts, and no other", () => {
  expect(Array.sort(Record.keys(TaskEvents), Order.String)).toStrictEqual(
    Array.sort(TaskEventType.literals, Order.String),
  );
});
