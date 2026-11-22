import { Effect, Schema } from "effect";

import { TaskId } from "./ids.ts";
import { TaskStatus } from "./manifest.ts";

/**
 * Who wrote an event. Only a `human:` actor can move a task out of
 * `blocked_on_human`.
 */
export const Actor = Schema.Union([
  Schema.Literal("orchestrator"),
  Schema.TemplateLiteral(["human:", Schema.String]),
  Schema.TemplateLiteral(["agent:", Schema.String]),
]);
export type Actor = typeof Actor.Type;

/**
 * One line of `events.jsonl`.
 *
 * Decoding fills the defaults: a missing `v` is `1` and a missing `actor` is
 * `"orchestrator"`. Encoding writes them out, so a decoded event re-encodes
 * with `v` and `actor` present. `ts` decodes to a `DateTime.Utc`.
 */
export const Event = Schema.Struct({
  actor: Actor.pipe(Schema.withDecodingDefaultKey(Effect.succeed("orchestrator" as const))),
  detail: Schema.optionalKey(Schema.String),
  status: TaskStatus,
  taskId: TaskId,
  ts: Schema.DateTimeUtcFromString,
  v: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
});
export type Event = typeof Event.Type;

export const EventJson = Schema.fromJsonString(Event);
