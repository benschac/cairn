import { expect, it } from "@effect/vitest";
import { Array, Effect, ErrorReporter, Exit, Option, Order, Schema, String, Struct } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/http";

import { Slug } from "../src/manifest.ts";

import {
  Access,
  Agent,
  AgentId,
  AgentRow,
  Comment,
  CommentCreate,
  CommentEdit,
  Conflict,
  Document,
  DocumentId,
  DocumentView,
  Forbidden,
  HostedError,
  InvalidInput,
  InvitationId,
  Invitation,
  LimitReached,
  NotFound,
  PlanRecordId,
  Revision,
  RevisionBody,
  RevisionId,
  RoomMessage,
  SaveInput,
  StaleComment,
  StaleRevision,
  Unauthenticated,
  WorkspaceId,
  atLeast,
  newId,
  randomId,
} from "../src/hosted/index.ts";

const exits = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

const ids = [
  { make: newId.workspace, prefix: "w", schema: WorkspaceId },
  { make: newId.document, prefix: "doc", schema: DocumentId },
  { make: newId.revision, prefix: "rev", schema: RevisionId },
  { make: newId.agent, prefix: "agt", schema: AgentId },
  { make: newId.invitation, prefix: "inv", schema: InvitationId },
  { make: newId.planRecord, prefix: "plan", schema: PlanRecordId },
];

it.effect("every ID schema accepts what the generator makes", () =>
  Effect.forEach(
    ids,
    ({ make, prefix, schema }) =>
      Effect.gen(function* () {
        const made = yield* Effect.all(Array.replicate(make, 25));
        expect(Array.every(made, Schema.is(schema))).toBe(true);
        expect(Array.every(made, (id) => /^[a-z]+_[a-z0-9]{12}$/u.test(id))).toBe(true);
        expect(Array.every(made, (id) => String.startsWith(`${prefix}_`)(id))).toBe(true);
      }),
    { discard: true },
  ),
);

it("every ID schema refuses the other prefixes", () => {
  Array.forEach(Array.cartesian(ids, ids), ([schemaOf, idOf]) => {
    const id = randomId(idOf.prefix);
    expect(exits(schemaOf.schema, id)).toBe(schemaOf.prefix === idOf.prefix);
  });
});

it.each([
  "w_ABCDEFGHIJKL",
  "w_abcdefghijk",
  "w_abcdefghijklm",
  "w_abcdefghijk-",
  "w-abcdefghijkl",
  "abcdefghijkl",
  "",
])("an ID that is %j is refused", (id) => {
  expect(Schema.is(WorkspaceId)(id)).toBe(false);
});

const order = ["read", "comment", "edit", "manage"] as const;

it.prop("atLeast follows the order of Access", [Access, Access], ([have, need]) => {
  const reached = Array.take(
    order,
    Array.length(Array.takeWhile(order, (each) => each !== have)) + 1,
  );
  expect(atLeast(have, need)).toBe(Array.contains(reached, need));
  expect(Access.literals).toEqual(order);
});

it.prop("none is never enough", [Access], ([need]) => {
  expect(atLeast("none", need)).toBe(false);
});

it.prop("manage is enough for every access, and read only for read", [Access], ([need]) => {
  expect(atLeast("manage", need)).toBe(true);
  expect(atLeast("read", need)).toBe(need === "read");
});

const invitation = {
  email: "ada@example.com",
  expiresAt: "2026-12-01T00:00:00.000Z",
  id: "inv_abcdefghijkl",
  invitedBy: "user-1",
  status: "pending",
  workspaceId: "w_abcdefghijkl",
};

it.each([
  [{ ...invitation, kind: "workspace", role: "member" }, true],
  [{ ...invitation, kind: "workspace", role: "admin" }, true],
  [{ ...invitation, kind: "workspace", role: "owner" }, false],
  [{ ...invitation, access: "read", documentId: "doc_abcdefghijkl", kind: "document" }, true],
  [{ ...invitation, access: "comment", documentId: "doc_abcdefghijkl", kind: "document" }, true],
  [{ ...invitation, access: "edit", documentId: "doc_abcdefghijkl", kind: "document" }, false],
  [{ ...invitation, access: "manage", documentId: "doc_abcdefghijkl", kind: "document" }, false],
  [{ ...invitation, access: "read", kind: "document" }, false],
])("an invitation %j is accepted: %s", (input, accepted) => {
  expect(exits(Invitation, input)).toBe(accepted);
});

const fieldsOf = (schema: { readonly fields: object }) =>
  Array.sort(Struct.keys(schema.fields), Order.String);

it("an agent the API returns has no secret hash, and the stored row has", () => {
  expect(fieldsOf(AgentRow)).toEqual(
    Array.sort(Array.append(fieldsOf(Agent), "secretHash"), Order.String),
  );
  expect(Array.contains(fieldsOf(Agent), "secretHash")).toBe(false);
});

it("a document view is the document with the reader's access, the markdown and whether it has a plan", () => {
  expect(fieldsOf(DocumentView)).toEqual(
    Array.sort(
      Array.appendAll(fieldsOf(Document), ["access", "hasPlan", "markdown"]),
      Order.String,
    ),
  );
});

it("a revision body adds the markdown, and a save carries only what a client says", () => {
  expect(fieldsOf(RevisionBody)).toEqual(
    Array.sort(Array.append(fieldsOf(Revision), "markdown"), Order.String),
  );
  expect(fieldsOf(SaveInput)).toEqual(["base", "clientId", "kind", "markdown"]);
});

it("no request decodes a field the server sets", () => {
  expect(fieldsOf(CommentCreate)).toEqual(["body"]);
  expect(fieldsOf(CommentEdit)).toEqual(["body", "version"]);
  expect(fieldsOf(Comment)).toEqual([
    "at",
    "author",
    "body",
    "editedAt",
    "id",
    "thread",
    "version",
  ]);
});

it.prop("a save is refused without its base or its client", [RevisionBody], ([body]) => {
  const save = Schema.encodeSync(SaveInput)({
    base: null,
    clientId: "tab-1",
    kind: body.kind,
    markdown: body.markdown,
  });
  expect(exits(SaveInput, save)).toBe(true);
  expect(exits(SaveInput, Struct.omit(save, ["base"]))).toBe(false);
  expect(exits(SaveInput, Struct.omit(save, ["clientId"]))).toBe(false);
});

it.prop(
  "a comment round-trips, and a body over 20,000 characters is refused",
  [Comment],
  ([comment]) => {
    const encoded = Schema.encodeSync(Comment)(comment);
    expect(Schema.decodeUnknownSync(Comment)(encoded)).toEqual(comment);
    expect(exits(Comment, { ...encoded, body: String.repeat(20_001)("x") })).toBe(false);
    expect(exits(Comment, { ...encoded, body: String.repeat(20_000)("x") })).toBe(true);
  },
);

const errors = (revision: RevisionBody, comment: Comment) => [
  new NotFound({ message: "No such document." }),
  new Unauthenticated({ field: "token", message: "Sign in." }),
  new Forbidden({ message: "You may not." }),
  new InvalidInput({ field: "title", message: "Too long." }),
  new Conflict({ message: "Taken." }),
  new StaleRevision({ current: revision, message: "Someone saved first." }),
  new StaleComment({ current: comment, message: "Someone edited first." }),
  new LimitReached({
    allowed: 3,
    dimension: "guests",
    message: "The plan is full.",
    plan: Slug.make("free"),
    upgradeUrl: null,
    used: 3,
  }),
];

it.prop("every HostedError round-trips", [RevisionBody, Comment], ([revision, comment]) => {
  Array.forEach(errors(revision, comment), (error) => {
    const encoded = Schema.encodeSync(HostedError)(error);
    const decoded = Schema.decodeUnknownSync(HostedError)(encoded);
    expect(Schema.is(HostedError)(decoded)).toBe(true);
    expect(Schema.encodeSync(HostedError)(decoded)).toEqual(encoded);
    expect(decoded).toBeInstanceOf(error.constructor);
  });
});

it.prop(
  "a HostedError is its code and message on the wire",
  [RevisionBody, Comment],
  ([revision, comment]) => {
    expect(
      Array.map(errors(revision, comment), (error) => Schema.encodeSync(HostedError)(error).code),
    ).toEqual([
      "not-found",
      "unauthenticated",
      "forbidden",
      "invalid-input",
      "conflict",
      "stale-revision",
      "stale-comment",
      "limit-reached",
    ]);
  },
);

const statusOf = (error: { readonly constructor: unknown }) =>
  Option.fromNullishOr(
    Schema.isSchema(error.constructor) ? error.constructor.ast.annotations : undefined,
  ).pipe(Option.flatMapNullishOr((annotations) => annotations.httpApiStatus));

it.prop(
  "an error is not reported, and carries its status",
  [RevisionBody, Comment],
  ([revision, comment]) => {
    expect(Array.map(errors(revision, comment), ErrorReporter.isIgnored)).toEqual(
      Array.replicate(true, 8),
    );
    expect(Array.map(errors(revision, comment), statusOf)).toEqual(
      Array.map([404, 401, 403, 400, 409, 409, 409, 403], Option.some),
    );
  },
);

it.effect("a NotFound renders its own 404 with its encoded form", () =>
  Effect.gen(function* () {
    const error = new NotFound({ message: "No such document." });
    const response = yield* HttpServerRespondable.toResponse(error);
    expect(response.status).toBe(404);
    const text = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
    const body = Schema.decodeUnknownSync(Schema.fromJsonString(HostedError))(text);
    expect(body).toEqual(error);
  }),
);

const codes = [
  "not-found",
  "unauthenticated",
  "forbidden",
  "invalid-input",
  "conflict",
  "stale-revision",
  "stale-comment",
  "limit-reached",
];

it.prop("an error whose code is not one of the eight is refused", [Schema.String], ([code]) => {
  if (Array.contains(codes, code)) return;
  expect(exits(HostedError, { code, message: "x" })).toBe(false);
});

it.prop("every room message round-trips", [RoomMessage], ([message]) => {
  const encoded = Schema.encodeSync(RoomMessage)(message);
  expect(Schema.decodeUnknownSync(RoomMessage)(encoded)).toEqual(message);
});

const types = [
  "revision",
  "thread",
  "trace",
  "event",
  "approval",
  "visibility",
  "access",
  "reading",
];

it.prop(
  "a room message with an unknown type is refused",
  [RoomMessage, Schema.String],
  ([message, type]) => {
    if (Array.contains(types, type)) return;
    expect(exits(RoomMessage, { ...Schema.encodeSync(RoomMessage)(message), type })).toBe(false);
  },
);

it("a room message with a known type and nothing else is refused", () => {
  Array.forEach(types, (type) => {
    expect(exits(RoomMessage, { type })).toBe(false);
  });
  expect(exits(RoomMessage, { access: "read", type: "access" })).toBe(true);
});
