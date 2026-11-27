import { BetterAuth, Database } from "@alchemy.run/better-auth";
import { Slug } from "@cairn/contract";
import {
  Authentication,
  CurrentUser,
  MyWorkspace,
  Unauthenticated,
  User,
  UserId,
  newId,
  randomId,
  type Workspace,
} from "@cairn/contract/hosted";
import { D1Client } from "@effect/sql-d1";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization, magicLink, organization } from "better-auth/plugins";
import type { SocialProviders } from "better-auth/social-providers";
import {
  Array,
  Context,
  DateTime,
  Effect,
  HashSet,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  Scope,
  String,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { HostedEnv } from "./env.ts";
import { Mailer, type Mail } from "./mailer.ts";

/** A way in. Each one an operator turns on in `CAIRN_AUTH` needs its own secrets. */
export const Way = Schema.Literals(["github", "google", "email"]);
export type Way = typeof Way.Type;

/** What the deployment's settings say about accounts. */
export interface AccountSettingsShape {
  /** The site's origin, `https://<CAIRN_DOMAIN>`. Sign-in links and OAuth callbacks point here. */
  readonly origin: string;
  /** Signs the session cookies. */
  readonly secret: Redacted.Redacted;
  readonly ways: HashSet.HashSet<Way>;
  /** The OAuth apps of the ways that are on, as Better Auth takes them. */
  readonly socialProviders: SocialProviders;
  /** `managed` puts a workspace on the free plan, `off` on `self-hosted`. */
  readonly billing: "managed" | "off";
}

/** A way in is on but its secrets are missing, or a setting does not decode. */
export class SettingsInvalid extends Schema.TaggedError<
  SettingsInvalid,
  { readonly brand: unique symbol }
>()("SettingsInvalid", { message: Schema.String }) {}

const Env = Schema.Struct({
  AUTH_SECRET: Schema.NonEmptyString,
  CAIRN_AUTH: Schema.String,
  CAIRN_BILLING: Schema.Literals(["managed", "off"]),
  CAIRN_DOMAIN: Schema.NonEmptyString,
  GITHUB_CLIENT_ID: Schema.String,
  GITHUB_CLIENT_SECRET: Schema.String,
  GOOGLE_CLIENT_ID: Schema.String,
  GOOGLE_CLIENT_SECRET: Schema.String,
});

/** An OAuth app's credentials, required only when its way in is on. */
const oauthApp = (
  ways: HashSet.HashSet<Way>,
  way: "github" | "google",
  clientId: string,
  clientSecret: string,
) =>
  HashSet.has(ways, way)
    ? String.isNonEmpty(clientId) && String.isNonEmpty(clientSecret)
      ? Effect.succeed({ clientId, clientSecret, enabled: true })
      : Effect.fail(
          new SettingsInvalid({
            message: `CAIRN_AUTH turns ${way} on, but its client ID or secret is unset.`,
          }),
        )
    : Effect.succeed({ clientId, clientSecret, enabled: false });

export class AccountSettings extends Context.Service<AccountSettings, AccountSettingsShape>()(
  "@cairn/hosted/AccountSettings",
) {
  /** Decodes the settings from the Worker's bindings. */
  static readonly layer = Layer.effect(
    AccountSettings,
    Effect.gen(function* () {
      const bindings = yield* HostedEnv;
      const env = yield* Schema.decodeUnknownEffect(Env)(bindings).pipe(
        Effect.mapError((error) => new SettingsInvalid({ message: error.message })),
      );
      const named = yield* Effect.forEach(
        Array.filter(Array.map(String.split(env.CAIRN_AUTH, ","), String.trim), String.isNonEmpty),
        (way) =>
          Schema.decodeUnknownEffect(Way)(way).pipe(
            Effect.mapError(
              () =>
                new SettingsInvalid({ message: `CAIRN_AUTH names ${way}, which is not a way in.` }),
            ),
          ),
      );
      const ways = HashSet.fromIterable(named);
      const github = yield* oauthApp(
        ways,
        "github",
        env.GITHUB_CLIENT_ID,
        env.GITHUB_CLIENT_SECRET,
      );
      const google = yield* oauthApp(
        ways,
        "google",
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
      );
      return AccountSettings.of({
        billing: env.CAIRN_BILLING,
        origin: `https://${env.CAIRN_DOMAIN}`,
        secret: Redacted.make(env.AUTH_SECRET),
        socialProviders: { github, google },
        ways,
      });
    }),
  );
}

/** The plan a workspace is on before any subscription: free under managed billing, else self-hosted. */
export const planOf = (billing: AccountSettingsShape["billing"]): Slug =>
  Slug.make(
    Match.value(billing).pipe(
      Match.when("managed", () => "free"),
      Match.when("off", () => "self-hosted"),
      Match.exhaustive,
    ),
  );

/** The name a personal workspace takes: `<name>'s workspace`, the email's local part for a person with no name. */
export const personalWorkspaceName = (user: { readonly name: string; readonly email: string }) => {
  const name = String.isNonEmpty(String.trim(user.name))
    ? String.trim(user.name)
    : Option.getOrElse(Array.head(String.split(user.email, "@")), () => user.email);
  return `${String.slice(0, 68)(name)}'s workspace`;
};

/**
 * A new workspace with `owner` as its owner, in one D1 batch: Better Auth's organization and
 * membership, the `workspaces` row with Cairn's ID and kind, and the `usage` row.
 */
export const createWorkspace = Effect.fn("createWorkspace")(function* (input: {
  readonly owner: UserId;
  readonly kind: Workspace["kind"];
  readonly name: string;
}) {
  const sql = yield* D1Client.D1Client;
  const settings = yield* AccountSettings;
  const id = yield* newId.workspace;
  const organizationId = yield* Effect.sync(() => randomId("org"));
  const memberId = yield* Effect.sync(() => randomId("mem"));
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);
  yield* sql.batch([
    sql`insert into organization (id, name, slug, createdAt) values (${organizationId}, ${input.name}, ${id}, ${at})`,
    sql`insert into member (id, organizationId, userId, role, createdAt) values (${memberId}, ${organizationId}, ${input.owner}, 'owner', ${at})`,
    sql`insert into workspaces (id, organization_id, kind, name, created_at) values (${id}, ${organizationId}, ${input.kind}, ${input.name}, ${at})`,
    sql`insert into usage (workspace_id, members, prds, private_prds, public_prds) values (${id}, 1, 0, 0, 0)`,
  ]);
  return yield* Schema.decodeEffect(MyWorkspace)({
    createdAt: at,
    id,
    kind: input.kind,
    name: input.name,
    plan: planOf(settings.billing),
    role: "owner",
  });
});

/**
 * The personal workspace of a person who has just signed up. It checks for one first, so running it
 * again creates nothing.
 */
export const ensurePersonalWorkspace = Effect.fn("ensurePersonalWorkspace")(function* (user: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}) {
  const sql = yield* D1Client.D1Client;
  const owner = UserId.make(user.id);
  const existing = yield* sql<{ readonly id: string }>`
    select w.id from workspaces w join member m on m.organizationId = w.organization_id
    where m.userId = ${owner} and w.kind = 'personal' limit 1`;
  if (Array.isReadonlyArrayNonEmpty(existing)) return;
  yield* createWorkspace({ owner, kind: "personal", name: personalWorkspaceName(user) });
});

/** `ensurePersonalWorkspace` for the user with this ID. */
export const ensurePersonalWorkspaceOf = Effect.fn("ensurePersonalWorkspaceOf")(function* (
  userId: string,
) {
  const sql = yield* D1Client.D1Client;
  const users = yield* sql<{ readonly id: string; readonly name: string; readonly email: string }>`
    select id, name, email from user where id = ${userId}`;
  yield* Effect.forEach(users, ensurePersonalWorkspace, { discard: true });
});

/** Whether an organization is a personal workspace, which has one member and invites no one. */
const isPersonal = Effect.fn("isPersonal")(function* (organizationId: string) {
  const sql = yield* D1Client.D1Client;
  const rows = yield* sql<{ readonly kind: string }>`
    select kind from workspaces where organization_id = ${organizationId}`;
  return Array.some(rows, (row) => row.kind === "personal");
});

/** The email that carries a sign-in link. */
export const signInMail = (to: string, url: string): Mail => ({
  html: `<p><a href="${String.replaceAll("&", "&amp;")(url)}">Sign in to Cairn</a></p><p>The link works once and expires in five minutes. If you did not ask for it, ignore this email.</p>`,
  subject: "Sign in to Cairn",
  text: `Sign in to Cairn:\n\n${url}\n\nThe link works once and expires in five minutes. If you did not ask for it, ignore this email.\n`,
  to,
});

const SIGN_IN_PATHS = ["/sign-in/magic-link", "/magic-link/verify"];

/**
 * The organization plugin's routes that would change a workspace without its `workspaces` and
 * `usage` rows: a rename, a deletion, and a role change, which also takes a list of roles where
 * Cairn's `Role` is one. They stay off until a route keeps the rows in step.
 */
const UNGUARDED_ORGANIZATION_PATHS = [
  "/organization/update",
  "/organization/delete",
  "/organization/update-member-role",
];

/** What Better Auth calls back into: each runs an effect outside any fiber and settles when it ends. */
export interface AuthCallbacks {
  readonly userCreated: (user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  }) => Promise<void>;
  /** Makes the personal workspace of a signed-in person who has none, as after a failed sign-up. */
  readonly sessionCreated: (userId: string) => Promise<void>;
  readonly sendSignInLink: (email: string, url: string) => Promise<void>;
  /** At most one member in a personal workspace; the plugin's default of 100 in a team one. */
  readonly membershipLimit: (organizationId: string) => Promise<number>;
  /** Rejects with a `403` `APIError` for a personal workspace, which invites no one. */
  readonly checkInvitation: (organizationId: string) => Promise<void>;
}

/**
 * Better Auth's options for these settings, apart from the database: GitHub, Google and a magic link
 * that works once for five minutes; linking only on a provider-confirmed email; workspaces on the
 * organization plugin; and device authorization for `cairn connect`.
 */
export const authOptions = (settings: AccountSettingsShape, callbacks: AuthCallbacks) => ({
  basePath: "/api/auth",
  baseURL: settings.origin,
  secret: settings.secret,
  disabledPaths: Array.appendAll(
    UNGUARDED_ORGANIZATION_PATHS,
    HashSet.has(settings.ways, "email") ? [] : SIGN_IN_PATHS,
  ),
  socialProviders: settings.socialProviders,
  account: {
    // One person is one user: a sign-in joins the user with its email only when the provider
    // confirmed that email. No provider is trusted to link an email it has not confirmed.
    accountLinking: { enabled: true, trustedProviders: [], requireLocalEmailVerified: true },
  },
  databaseHooks: {
    user: { create: { after: callbacks.userCreated } },
    session: {
      create: {
        after: (session: { readonly userId: string }) => callbacks.sessionCreated(session.userId),
      },
    },
  },
  plugins: [
    magicLink({
      expiresIn: 300,
      storeToken: "hashed",
      sendMagicLink: ({ email, url }) => callbacks.sendSignInLink(email, url),
    }),
    organization({
      // A workspace is made by `POST /api/workspaces` or at sign-up, with its `workspaces` row.
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      membershipLimit: (_user, org) => callbacks.membershipLimit(org.id),
      organizationHooks: {
        beforeCreateInvitation: ({ organization: org }) => callbacks.checkInvitation(org.id),
      },
    }),
    // `cairn connect` signs in once through the browser (see spec.hosted-launch.cairn-connect), and
    // sends the session token it is given as a bearer token.
    deviceAuthorization({ verificationUri: "/device", expiresIn: "10m", interval: "5s" }),
    bearer(),
  ],
});

/**
 * Better Auth with its tables in D1, through Alchemy's Better Auth integration. The database layer is
 * the Worker's own D1 binding: its tables come from the numbered D1 migrations, so Better Auth's own
 * deploy-time migration is not registered.
 */
const makeAuth = Effect.gen(function* () {
  const settings = yield* AccountSettings;
  const mailer = yield* Mailer;
  // Better Auth calls its hooks and its mail callback outside any fiber.
  const context = yield* Effect.context<D1Client.D1Client | AccountSettings>();
  // Only the services the callbacks use go along, not the scope this layer is built in.
  const run = Effect.runPromiseWith(Context.pick(D1Client.D1Client, AccountSettings)(context));
  return yield* BetterAuth(
    authOptions(settings, {
      checkInvitation: (organizationId) =>
        run(
          Effect.flatMap(isPersonal(organizationId), (personal) =>
            personal
              ? Effect.fail(
                  new APIError("FORBIDDEN", {
                    message: "A personal workspace has one member and invites no one.",
                  }),
                )
              : Effect.void,
          ),
        ),
      membershipLimit: (organizationId) =>
        run(Effect.map(isPersonal(organizationId), (personal) => (personal ? 1 : 100))),
      sendSignInLink: (email, url) => run(mailer.send(signInMail(email, url))),
      sessionCreated: (userId) => run(ensurePersonalWorkspaceOf(userId)),
      userCreated: (user) => run(ensurePersonalWorkspace(user)),
    }),
  );
});

/** Better Auth's database is the Worker's D1 binding. */
const D1Database = Layer.effect(
  Database,
  Effect.map(Effect.service(HostedEnv), (env) =>
    Database.of({ provider: "sqlite", runtime: Effect.succeed(env.DB) }),
  ),
);

/**
 * Sign-in, built once per isolate from Alchemy's Better Auth integration; each request gets its own
 * Better Auth instance from it, in the request's scope.
 *
 * @effect-expect-leaking HttpServerRequest | Scope
 */
export class Auth extends Context.Service<
  Auth,
  {
    /** Better Auth's response to a request under `/api/auth/`, cookies and redirects included. */
    readonly fetch: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >;
    /** The request's signed-in person, or none. */
    readonly user: Effect.Effect<Option.Option<User>, never, HttpServerRequest.HttpServerRequest>;
  }
>()("@cairn/hosted/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const auth = yield* makeAuth;
      return Auth.of({
        // Alchemy's `RuntimeContext` only marks code that runs in a deployed Worker; it holds nothing.
        fetch: auth.fetch.pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom)),
        user: auth.getSession().pipe(
          Effect.orDie,
          Effect.flatMap((session) =>
            Option.match(Option.fromNullOr(session), {
              onNone: () => Effect.succeedNone,
              onSome: ({ user }) =>
                Schema.decodeEffect(User)({
                  email: user.email,
                  id: user.id,
                  image: Option.getOrNull(Option.fromNullishOr(user.image)),
                  name: user.name,
                }).pipe(Effect.orDie, Effect.asSome),
            }),
          ),
          Effect.provide(RuntimeContext.phantom),
        ),
      });
    }),
  ).pipe(Layer.provide(D1Database));
}

/** Better Auth's own routes, under `/api/auth/`, answered with its complete responses. */
export const AuthRoutes = HttpRouter.use((router) =>
  Effect.flatMap(Effect.service(Auth), (auth) => router.add("*", "/api/auth/*", auth.fetch)),
);

/** The session's user as `CurrentUser`; a request without a session is `Unauthenticated`. */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const signedIn = yield* auth.user;
        const user = yield* Effect.fromOption(signedIn).pipe(
          Effect.mapError(() => new Unauthenticated({ message: "Sign in first." })),
        );
        return yield* Effect.provideService(httpEffect, CurrentUser, user);
      });
  }),
);
