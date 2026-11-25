import { Session, Trace } from "@cairn/contract";
import {
  Duration,
  Effect,
  Filter,
  Match,
  Number,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
  String,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

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

/**
 * A built bundle is the demo, which has no server behind it: nothing under `/api` can be fetched.
 * Only `pnpm dev` runs the server beside the viewer until `cairn serve` serves a build of its own.
 */
export const isDemoBuild = (): boolean => import.meta.env.PROD;

/** The status from which a response is an error, and its body the reason. */
const FIRST_ERROR_STATUS = 400;

/**
 * Fetch a patch route's text. A network failure or a `4xx`/`5xx` response fails with a sentence
 * for the pane: the response body, which holds git's message, or its status when the body is empty.
 */
export const fetchPatch = (path: string): Effect.Effect<string, string> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(path)),
    Effect.flatMap((response) =>
      Effect.map(response.text, (text) => ({ status: response.status, text })),
    ),
    Effect.mapError((error) => error.message),
    Effect.flatMap(({ status, text }) =>
      Number.isGreaterThanOrEqualTo(status, FIRST_ERROR_STATUS)
        ? Effect.fail(String.isEmpty(String.trim(text)) ? `HTTP ${status}` : text)
        : Effect.succeed(text),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/** How often the viewer asks `cairn serve` whether the trace changed. */
export const TRACE_POLL_INTERVAL = "2 seconds";

/** The status that says the trace is the one the viewer already holds. */
const NOT_MODIFIED = 304;

/**
 * Ask `/api/trace` once, with the ETag of the last trace as `If-None-Match`. None for a `304`;
 * some trace and its ETag for a `200`. A failed request, an error status or a body that does
 * not decode fails with the sentence the viewer shows above the last good trace.
 */
export const fetchTrace = (
  maybeEtag: Option.Option<string>,
): Effect.Effect<
  Option.Option<{ readonly trace: Trace; readonly maybeEtag: Option.Option<string> }>,
  string,
  HttpClient.HttpClient
> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.get("/api/trace", {
        headers: Option.match(maybeEtag, {
          onNone: () => ({}),
          onSome: (etag) => ({ "if-none-match": etag }),
        }),
      }),
    ),
    Effect.mapError((error) => `The trace did not load: ${error.message}`),
    Effect.flatMap((response) =>
      response.status === NOT_MODIFIED
        ? Effect.succeedNone
        : Number.isGreaterThanOrEqualTo(response.status, FIRST_ERROR_STATUS)
          ? Effect.fail(`The trace did not load: HTTP ${response.status}`)
          : response.json.pipe(
              Effect.mapError((error) => `The trace did not load: ${error.message}`),
              Effect.flatMap((json) => decodeTrace(json).pipe(Effect.mapError(describeTraceError))),
              Effect.map((trace) =>
                Option.some({ maybeEtag: Option.fromUndefinedOr(response.headers["etag"]), trace }),
              ),
            ),
    ),
  );

/**
 * What `cairn serve` says about its trace, once now and then every `interval`: a trace that
 * changed, or the error that kept it from arriving. A `304` says nothing. An error forgets the
 * ETag, so the next good answer is a full `200` and clears the error even if the trace is the
 * one the viewer already holds.
 */
export const pollTrace = (
  interval: Duration.Input,
): Stream.Stream<Result.Result<Trace, string>, never, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.map(Ref.make(Option.none<string>()), (etag) =>
      Stream.tick(interval).pipe(
        Stream.mapEffect(() =>
          Ref.get(etag).pipe(
            Effect.flatMap(fetchTrace),
            Effect.tap((maybeFetched) =>
              Option.match(maybeFetched, {
                onNone: () => Effect.void,
                onSome: (fetched) => Ref.set(etag, fetched.maybeEtag),
              }),
            ),
            Effect.map(Option.map(({ trace }) => Result.succeed(trace))),
            Effect.catch((error) =>
              Ref.set(etag, Option.none()).pipe(Effect.as(Option.some(Result.fail(error)))),
            ),
          ),
        ),
        Stream.filterMap(
          Filter.fromPredicateOption(
            (polled: Option.Option<Result.Result<Trace, string>>) => polled,
          ),
        ),
      ),
    ),
  );

/**
 * Fetch a session by ID from the sessions route and decode it. A failed fetch fails as
 * `fetchPatch` does; a body that is not a `Session` fails with what did not decode.
 */
export const fetchSession = (id: string): Effect.Effect<Session, string> =>
  fetchPatch(`/api/sessions/${id}`).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(text).pipe(
        Effect.mapError((error) => `The session did not decode: ${error.message}`),
      ),
    ),
  );
