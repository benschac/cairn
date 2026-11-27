import { Context, Effect, ErrorReporter, Scope } from "effect";

/**
 * Logs each failure a request was not owed, a `500` or a defect, as an error with its cause. A refusal
 * the API owes, such as `NotFound` or `InvalidInput`, sets `ErrorReporter.ignore` and is not reported.
 * The server calls a reporter outside any fiber, so it logs with the services of the layer that built
 * it, without that layer's `Scope`.
 */
export const ReportedFailures = ErrorReporter.layer([
  Effect.map(Effect.context<Scope.Scope>(), (context) => {
    const log = Effect.runSyncWith(Context.omit(Scope.Scope)(context));
    return ErrorReporter.make(({ cause }) => log(Effect.logError("A request failed", cause)));
  }),
]);
