import { ErrorReporter, Schema } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/http";

import { Slug } from "../manifest.ts";
import { Comment } from "./discussion.ts";
import { Dimension } from "./entitlements.ts";
import { RevisionBody } from "./revision.ts";

// Each class is an answer the API owes, so none is reported: each sets `ErrorReporter.ignore`. Its
// encoded form is `{ code, message, ... }` and its schema carries its status for the `HttpApi`.

export class NotFound
  extends Schema.Error<NotFound, { readonly brand: unique symbol }>("NotFound")(
    {
      code: Schema.tag("not-found"),
      message: Schema.String,
    },
    { httpApiStatus: 404 },
  )
  implements HttpServerRespondable.Respondable
{
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(NotFound)(this, { status: 404 });
  }

  override readonly [ErrorReporter.ignore] = true;
}

export class Unauthenticated extends Schema.Error<
  Unauthenticated,
  { readonly brand: unique symbol }
>("Unauthenticated")(
  {
    code: Schema.tag("unauthenticated"),
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 401 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

export class Forbidden extends Schema.Error<Forbidden, { readonly brand: unique symbol }>(
  "Forbidden",
)(
  {
    code: Schema.tag("forbidden"),
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 403 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

export class InvalidInput extends Schema.Error<InvalidInput, { readonly brand: unique symbol }>(
  "InvalidInput",
)(
  {
    code: Schema.tag("invalid-input"),
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 400 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

export class Conflict extends Schema.Error<Conflict, { readonly brand: unique symbol }>("Conflict")(
  {
    code: Schema.tag("conflict"),
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 409 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

export class StaleRevision extends Schema.Error<StaleRevision, { readonly brand: unique symbol }>(
  "StaleRevision",
)(
  {
    code: Schema.tag("stale-revision"),
    message: Schema.String,
    current: RevisionBody,
  },
  { httpApiStatus: 409 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

export class StaleComment extends Schema.Error<StaleComment, { readonly brand: unique symbol }>(
  "StaleComment",
)(
  {
    code: Schema.tag("stale-comment"),
    message: Schema.String,
    current: Comment,
  },
  { httpApiStatus: 409 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

/** A limit of the workspace's plan is reached: a `403`. */
export class LimitReached extends Schema.Error<LimitReached, { readonly brand: unique symbol }>(
  "LimitReached",
)(
  {
    code: Schema.tag("limit-reached"),
    message: Schema.String,
    allowed: Schema.Int,
    dimension: Schema.Union([Dimension, Schema.Literal("guests")]),
    plan: Slug,
    upgradeUrl: Schema.NullOr(Schema.String),
    used: Schema.Int,
  },
  { httpApiStatus: 403 },
) {
  override readonly [ErrorReporter.ignore] = true;
}

/** Every refusal the hosted API gives, by its `code`. */
export const HostedError = Schema.Union([
  NotFound,
  Unauthenticated,
  Forbidden,
  InvalidInput,
  Conflict,
  StaleRevision,
  StaleComment,
  LimitReached,
]);
export type HostedError = typeof HostedError.Type;
