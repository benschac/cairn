import { Trace } from "@cairn/contract";
import { Effect, Match, Schema } from "effect";

/** The trace file could not be read at all. */
export class TraceNotLoaded extends Schema.TaggedError<TraceNotLoaded>()("TraceNotLoaded", {
  cause: Schema.Defect(),
}) {}

/** The trace file was read but does not match the Trace schema. */
export class TraceNotDecoded extends Schema.TaggedError<TraceNotDecoded>()("TraceNotDecoded", {
  issue: Schema.String,
}) {}

export type TraceError = TraceNotLoaded | TraceNotDecoded;

/** Decode a trace as the server (or the demo build) hands it over. */
export const decodeTrace = (input: unknown) =>
  Schema.decodeUnknownEffect(Trace)(input).pipe(
    Effect.mapError((error) => new TraceNotDecoded({ issue: error.message })),
  );

/** The sentence the viewer shows for a trace that did not arrive. */
export const describeTraceError = (error: TraceError) =>
  Match.valueTags(error, {
    TraceNotDecoded: ({ issue }) => `The trace did not decode: ${issue}`,
    TraceNotLoaded: ({ cause }) => `The demo trace did not load: ${globalThis.String(cause)}`,
  });

/**
 * The demo build loads its trace once and never polls. A polling source for
 * `cairn serve` can sit beside this and feed the same messages.
 */
export const loadDemoTrace: Effect.Effect<Trace, TraceError> = Effect.tryPromise({
  catch: (cause) => new TraceNotLoaded({ cause }),
  try: () => import("./demo-trace.json"),
}).pipe(Effect.flatMap(({ default: json }) => decodeTrace(json)));
