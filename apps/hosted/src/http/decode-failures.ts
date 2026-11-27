import { DecodeFailures, InvalidInput } from "@cairn/contract/hosted";
import { Array, Effect, Option, Predicate, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import type { HttpApiError } from "effect/http-api";

const standard = SchemaIssue.makeFormatterStandardSchemaV1();

/** A schema error's first issue as `InvalidInput`: its message, and its path as the field when it has one. */
export const invalidInput = (error: HttpApiError.HttpApiSchemaError): InvalidInput => {
  const first = Array.head(standard(error.cause.issue).issues);
  const field = first.pipe(
    Option.flatMap((issue) => Option.fromNullishOr(issue.path)),
    Option.filter(Array.isReadonlyArrayNonEmpty),
    Option.map((path) =>
      Array.join(
        Array.map(path, (segment) =>
          globalThis.String(Predicate.hasProperty(segment, "key") ? segment.key : segment),
        ),
        ".",
      ),
    ),
  );
  const message = Option.match(first, {
    onNone: () => `The request's ${error.kind} did not decode.`,
    onSome: (issue) => issue.message,
  });
  return Option.match(field, {
    onNone: () => new InvalidInput({ message }),
    onSome: (name) => new InvalidInput({ message, field: name }),
  });
};

/**
 * The request's path, query, headers or body that does not decode becomes `InvalidInput`. A response
 * the Worker cannot encode stays the reported `500`.
 */
export const DecodeFailuresLive = HttpApiMiddleware.layerSchemaErrorTransform(
  DecodeFailures,
  (error) =>
    error.kind === "Body" || error.kind === "ResponseHeaders"
      ? Effect.fail(error)
      : Effect.fail(invalidInput(error)),
);
