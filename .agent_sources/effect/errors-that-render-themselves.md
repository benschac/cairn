# Errors that render themselves

A domain error decides how it becomes an HTTP response, and a handler only fails. A status written in a
`catchTag` beside each route is easy to forget, and a forgotten one turns an expected failure into a
`500`. From Harry Solovay's talk [Advanced Effect Design Patterns](https://youtu.be/_tSGby_q890?t=1210)
at Effect Miami 3, chapter "Errors that render themselves", from 20:10.

> Give each expected failure its own response, and let handlers simply fail.

Line numbers are for the installed `effect`. If one has moved, find the export again with
`rg -n '^export declare' <file>`.

## The API

| Need | Export | Declaration |
| --- | --- | --- |
| An error that renders its response | `implements HttpServerRespondable.Respondable` with a `[HttpServerRespondable.symbol]()` method returning `Effect<HttpServerResponse>` | `node_modules/effect/dist/http/HttpServerRespondable.d.ts` 11-47 |
| An expected failure that is not reported | `override readonly [ErrorReporter.ignore] = true`; `ErrorReporter.isIgnored(error)` reads it | `node_modules/effect/dist/ErrorReporter.d.ts` 292-362 |
| Somewhere the unexpected ones go | `ErrorReporter.layer([ErrorReporter.make(({ cause, error, severity }) => ...)])` | `node_modules/effect/dist/ErrorReporter.d.ts` 124-237 |
| One body shape for every error, RFC 9457 `application/problem+json` | `ProblemDetails.toResponse({ type, status, title, detail, ...extensions })`; `ProblemDetails.Schema` decodes one, keeping extensions | `node_modules/effect/dist/http/ProblemDetails.d.ts` 82-95 |
| The same with `HttpApi` | Annotate the error's schema: `HttpApiSchema.status(404)`, or `HttpApiSchema.asProblem({ title })` for a problem body; the generated client decodes it back into the class | `node_modules/effect/dist/http-api/HttpApiSchema.d.ts` 94-240 |

```ts
export class SessionNotFound
  extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", { id: SessionId })
  implements HttpServerRespondable.Respondable
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 404 }));
  }

  override readonly [ErrorReporter.ignore] = true;
}

export const SessionRoute = HttpRouter.add("GET", "/api/sessions/:id", () =>
  paramsOf(SessionParams).pipe(Effect.flatMap(({ id }) => sessionResponse(id))),
);
```

## What the server does with a failure

`causeResponse` in `node_modules/effect/dist/http/HttpServerError.js` (from line 237) picks the response, and
`HttpEffect.toHandled` reports the cause before the response is written:

- A failure that is `Respondable` gets its own response. So does a defect that is.
- A `SchemaError` gets an empty `400`, and a `NoSuchElementError` an empty `404`. **Both are still
  reported**, since neither sets `ErrorReporter.ignore`. Decode a route's parameters into an error of your own
  that renders its `400` and is ignored, as `paramsOf` and `MalformedParams` do in `packages/cli/src/api.ts`.
- Anything else is an empty `500`, and it is reported.
- `HttpRouter.serve`'s logger middleware logs every failure with its cause, ignored or not. Reporting is the
  separate channel for what nobody expected.

## Traps

- A `SchemaError` raised on the server's side, such as a stored row that does not decode, renders as the
  `400` of a malformed request. Turn it into a defect, or into an error of your own, before it leaves the
  handler: `store.get(id).pipe(Effect.catchTag("SchemaError", (error) => Effect.die(error)))`.
- `Schema.TaggedError`'s base already declares `[ErrorReporter.ignore]`, so the field needs `override`.
- With no reporter registered, nothing is reported: `CurrentErrorReporters` defaults to empty. The server's
  composition root provides one (`ReportedFailures` in `packages/cli/src/serve.ts`).
- The server calls a reporter outside any fiber. A reporter that logs or records runs its effect with a
  context captured where its layer is built, minus that layer's `Scope`, as the checklist's stored-effects
  row describes.
- `[ErrorReporter.ignore]` marks a failure the route owes the caller, a `4xx`. A `5xx` that renders a
  body of its own, such as `GitFailed` with git's message, still leaves it unset, so it is reported.

## Tests

Assert the status and that nothing was reported for each expected failure, and that an unexpected one was.
`packages/cli/test/api.test.ts` provides `ReportedFailures` with a logger that records into a `Recorder`,
and `reportedDuring(request)` returns what was reported while a request ran. To check a class alone,
`HttpServerRespondable.toResponse(error)` gives its response and `ErrorReporter.isIgnored(error)` its flag.

## Beyond HTTP

The same shape works where a failure becomes something other than a response. An error that carries its own
code and hint, read through one small protocol, replaces a central function that maps every error and turns
a forgotten one into `internal`. Cairn's operations (`OperationError` for the CLI and MCP adapters) and the
hosted API's `HostedError` are planned this way; see `prd.refactors.errors-that-render-themselves`.
