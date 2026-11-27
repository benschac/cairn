import { Context, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";

import { Slug } from "../manifest.ts";
import { Access } from "./access.ts";
import { InvalidInput, Unauthenticated } from "./errors.ts";
import { DocumentId, UserId } from "./ids.ts";
import { Role, Workspace } from "./workspace.ts";

/**
 * Answers a request whose path, query, headers or body does not decode with `InvalidInput` naming the
 * field, in place of the `HttpApi`'s empty `400`. The Worker provides it once, where the API is built.
 */
export class DecodeFailures extends HttpApiMiddleware.Service<DecodeFailures>()(
  "@cairn/contract/hosted/DecodeFailures",
  { error: InvalidInput },
) {}

/** A signed-in person: the name, email and picture their first sign-in brought. */
export const User = Schema.Struct({
  email: Schema.NonEmptyString,
  id: UserId,
  image: Schema.NullOr(Schema.String),
  name: Schema.String,
});
export type User = typeof User.Type;

/** The person a request is signed in as, provided by `Authentication`. */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  "@cairn/contract/hosted/CurrentUser",
) {}

/** Resolves the request's session to `CurrentUser`; a request with none is `Unauthenticated`. */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("@cairn/contract/hosted/Authentication", { error: Unauthenticated }) {}

/** A workspace the person belongs to, with their role in it and the plan it is on. */
export const MyWorkspace = Workspace.pipe(Schema.fieldsAssign({ plan: Slug, role: Role }));
export type MyWorkspace = typeof MyWorkspace.Type;

/** A document the person holds a grant on in a workspace they are not a member of. */
export const SharedDocument = Schema.Struct({
  access: Access,
  id: DocumentId,
  title: Schema.String,
  workspaceName: Schema.String,
});
export type SharedDocument = typeof SharedDocument.Type;

/** What `GET /api/me` returns. */
export const Me = Schema.Struct({
  sharedWithMe: Schema.Array(SharedDocument),
  user: User,
  workspaces: Schema.Array(MyWorkspace),
});
export type Me = typeof Me.Type;

/**
 * What `POST /api/workspaces` takes. A name with a lone surrogate is refused: D1 would store it
 * changed.
 */
export const NewWorkspace = Schema.Struct({
  name: Workspace.fields.name.check(Schema.isPattern(/^\P{Cs}*$/u)),
});
export type NewWorkspace = typeof NewWorkspace.Type;

export class MeApi extends HttpApiGroup.make("me")
  .add(HttpApiEndpoint.get("me", "/api/me", { success: Me }))
  .middleware(Authentication) {}

export class WorkspacesApi extends HttpApiGroup.make("workspaces")
  .add(
    HttpApiEndpoint.post("create", "/api/workspaces", {
      payload: NewWorkspace,
      success: MyWorkspace,
    }),
  )
  .middleware(Authentication) {}

/**
 * The hosted Worker's API. Each group joins with `.add` before `.middleware(DecodeFailures)`: a middleware
 * reaches only the endpoints already in the API.
 */
export const HostedApi = HttpApi.make("hosted")
  .add(MeApi)
  .add(WorkspacesApi)
  .middleware(DecodeFailures);
