import { Schema } from "effect";

import { PrdSectionId } from "../ids.ts";
import { Event } from "../events.ts";
import { Sha256Hex } from "../judgments.ts";
import { Access } from "./access.ts";
import { EventId } from "./ids.ts";
import { GateApproval } from "./plan.ts";
import { Revision } from "./revision.ts";
import { ThreadView } from "./discussion.ts";

const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What the room sends a client over its WebSocket. Every write goes over HTTP. */
export const RoomMessage = Schema.Union([
  Schema.Struct({ revision: Revision, seq: Seq, type: Schema.Literal("revision") }),
  Schema.Struct({ seq: Seq, thread: ThreadView, type: Schema.Literal("thread") }),
  Schema.Struct({ hash: Sha256Hex, seq: Seq, type: Schema.Literal("trace") }),
  Schema.Struct({ event: Event, id: EventId, seq: Seq, type: Schema.Literal("event") }),
  Schema.Struct({ approval: GateApproval, seq: Seq, type: Schema.Literal("approval") }),
  Schema.Struct({
    seq: Seq,
    type: Schema.Literal("visibility"),
    visibility: Schema.Literals(["private", "public"]),
  }),
  Schema.Struct({
    access: Schema.Union([Access, Schema.Literal("none")]),
    type: Schema.Literal("access"),
  }),
  Schema.Struct({
    participants: Schema.Array(
      Schema.Struct({ name: Schema.String, section: Schema.NullOr(PrdSectionId) }),
    ),
    type: Schema.Literal("reading"),
  }),
]);
export type RoomMessage = typeof RoomMessage.Type;
