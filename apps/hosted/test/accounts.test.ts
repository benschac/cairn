import {
  InvalidInput,
  Me,
  MyWorkspace,
  Unauthenticated,
  NewWorkspace,
  UserId,
  randomId,
} from "@cairn/contract/hosted";
import { expect, layer } from "@effect/vitest";
import { getMigrations } from "better-auth/db/migration";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  Array,
  Effect,
  HashSet,
  Layer,
  Option,
  Order,
  Redacted,
  Result,
  Ref,
  Schema,
  String,
  Struct,
} from "effect";
import { HttpRouter } from "effect/http";
import { SqlClient } from "effect/sql";
import { vi } from "vitest";

import {
  AccountSettings,
  authOptions,
  ensurePersonalWorkspace,
  type AccountSettingsShape,
} from "../src/auth.ts";
import { HostedEnv } from "../src/env.ts";
import { ReportedFailures } from "../src/http/reported-failures.ts";
import { Routes } from "../src/http/routes.ts";
import { Mailer, type Mail } from "../src/mailer.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly MIGRATIONS: D1Migration[];
    }
  }
}

const origin = "https://hosted.test";

/** Google's profile for a stubbed ID token, `confirmed:<email>` or `unconfirmed:<email>`. */
const googleProfile = (token: string) => {
  const parts = String.split(token, ":");
  const address = Option.getOrElse(Array.get(parts, 1), () => "");
  const confirmed = Array.headNonEmpty(parts) === "confirmed";
  return {
    data: {
      aud: "stub-google",
      azp: "stub-google",
      email: address,
      email_verified: confirmed,
      exp: 0,
      family_name: "Google",
      given_name: "From",
      iat: 0,
      iss: "https://accounts.google.com",
      name: "From Google",
      picture: "",
      sub: `google-${address}`,
    },
    user: { email: address, emailVerified: confirmed, name: "From Google" },
  };
};

const settings: AccountSettingsShape = {
  billing: "managed",
  origin,
  secret: Redacted.make("a-test-secret-that-signs-no-real-session"),
  socialProviders: {
    google: {
      clientId: "stub-google",
      clientSecret: "stub-google-secret",
      enabled: true,
      // Stands in for Google: every ID token verifies, and the profile is read from the token.
      getUserInfo: (tokens) =>
        Promise.resolve(
          googleProfile(Option.getOrElse(Option.fromNullishOr(tokens.idToken), () => "")),
        ),
      verifyIdToken: () => Promise.resolve(true),
    },
  },
  ways: HashSet.fromIterable(["google", "email"] as const),
};

// The routes as the Worker serves them, with a `Mailer` that keeps what it is asked to send.
const outbox = Ref.makeUnsafe<ReadonlyArray<Mail>>([]);
const services = Layer.mergeAll(
  HostedEnv.layer(env),
  Layer.succeed(AccountSettings, AccountSettings.of(settings)),
  Mailer.test(outbox),
);
const web = HttpRouter.toWebHandler(
  Routes.pipe(Layer.provide(services), Layer.provide(ReportedFailures)),
);

const migrate = Effect.promise(() => applyD1Migrations(env.DB, env.MIGRATIONS));

/** The account settings decoded from the test bindings with `CAIRN_AUTH` and GitHub's secrets replaced. */
const settingsFor = (ways: string, githubId: string, githubSecret: string) =>
  Effect.service(AccountSettings).pipe(
    Effect.provide(AccountSettings.layer),
    Effect.provideService(
      HostedEnv,
      Struct.assign(env, {
        CAIRN_AUTH: ways,
        GITHUB_CLIENT_ID: githubId,
        GITHUB_CLIENT_SECRET: githubSecret,
      }),
    ),
    Effect.result,
  );

/** A Better Auth callback that does nothing. */
const none = () => Promise.resolve();

const send = (path: string, init?: RequestInit) =>
  Effect.promise(() => web.handler(new Request(`${origin}${path}`, init)));

const post = (path: string, body: unknown, cookie = "") =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
    Effect.orDie,
    Effect.flatMap((text) =>
      send(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: text,
      }),
    ),
  );

/** A response's status and its JSON body decoded with `schema`. */
const answer = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Effect.fn("answer")(function* (response: Response) {
    const body = yield* Effect.promise(() => response.json());
    return { status: response.status, body: yield* Schema.decodeUnknownEffect(schema)(body) };
  });

/** The `name=value` pairs a response sets, as a `Cookie` header. */
const cookiesOf = (response: Response) =>
  Array.join(
    Array.map(response.headers.getSetCookie(), (cookie) =>
      Array.headNonEmpty(String.split(cookie, ";")),
    ),
    "; ",
  );

const startsSession = (response: Response) =>
  Array.some(response.headers.getSetCookie(), String.includes("session_token="));

/** A fresh address for each sign-up, so tests that share the database never share a person. */
const address = (name: string) => `${name}-${randomId("t")}@example.test`;

/** Asks for a sign-in link for `email` and returns the link in the mail the test `Mailer` kept. */
const requestLink = Effect.fn("requestLink")(function* (email: string) {
  const asked = yield* post("/api/auth/sign-in/magic-link", { email, callbackURL: "/" });
  expect(asked.status).toBe(200);
  const sent = yield* Ref.get(outbox);
  const mail = yield* Effect.fromOption(Array.last(sent));
  expect(mail.to).toBe(email);
  return yield* Effect.fromOption(
    Array.findFirst(
      String.split(mail.text, "\n"),
      String.startsWith(`${origin}/api/auth/magic-link/verify`),
    ),
  );
});

/** Opens a sign-in link as a browser does, without following its redirect. */
const open = (link: string) => Effect.promise(() => web.handler(new Request(link)));

/** Signs `email` in with a magic link and returns the session's cookies. */
const signIn = Effect.fn("signIn")(function* (email: string) {
  const link = yield* requestLink(email);
  const opened = yield* open(link);
  expect([opened.status, startsSession(opened)]).toEqual([302, true]);
  return cookiesOf(opened);
});

const me = (cookie: string) => Effect.flatMap(send("/api/me", { headers: { cookie } }), answer(Me));

const shapeOf = (workspace: MyWorkspace) => ({
  kind: workspace.kind,
  name: workspace.name,
  plan: workspace.plan,
  role: workspace.role,
});

/** Runs `effect` with Better Auth's clock moved `ms` ahead, and puts the clock back after. */
const later = <A, E, R>(ms: number, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(vi.getRealSystemTime() + ms);
    }),
    () => effect,
    () => Effect.sync(() => vi.useRealTimers()),
  );

layer(services)("accounts and workspaces", (it) => {
  it.effect("a magic-link sign-up gives one personal workspace, its owner, on the free plan", () =>
    Effect.gen(function* () {
      yield* migrate;
      const signedOut = yield* Effect.flatMap(send("/api/me"), answer(Unauthenticated));
      expect(signedOut.status).toBe(401);
      const email = address("ada");
      const before = yield* Ref.get(outbox);
      const cookie = yield* signIn(email);
      const { status, body } = yield* me(cookie);
      expect(status).toBe(200);
      expect(body.user.email).toBe(email);
      expect(Array.map(body.workspaces, shapeOf)).toEqual([
        {
          kind: "personal",
          name: `${Array.headNonEmpty(String.split(email, "@"))}'s workspace`,
          plan: "free",
          role: "owner",
        },
      ]);
      expect(body.sharedWithMe).toEqual([]);
      // Signing up asked for nothing but an email: one mail went out, and nothing else was called.
      const after = yield* Ref.get(outbox);
      expect(Array.length(after)).toBe(Array.length(before) + 1);
      const sql = yield* SqlClient.SqlClient;
      const usage = yield* sql<{ readonly workspace_id: string; readonly members: number }>`
        select u.workspace_id, u.members from usage u join workspaces w on w.id = u.workspace_id
        join member m on m.organizationId = w.organization_id where m.userId = ${body.user.id}`;
      expect(usage).toEqual(
        Array.map(body.workspaces, ({ id }) => ({ workspace_id: id, members: 1 })),
      );
    }),
  );

  it.effect("POST /api/workspaces with Acme makes /api/me list both workspaces", () =>
    Effect.gen(function* () {
      yield* migrate;
      const cookie = yield* signIn(address("grace"));
      const created = yield* Effect.flatMap(
        post("/api/workspaces", { name: "Acme" }, cookie),
        answer(MyWorkspace),
      );
      expect(created.status).toBe(200);
      expect(shapeOf(created.body)).toEqual({
        kind: "team",
        name: "Acme",
        plan: "free",
        role: "owner",
      });
      const { body } = yield* me(cookie);
      expect(Array.map(body.workspaces, ({ kind, name }) => [kind, name])).toEqual([
        ["personal", expect.stringMatching(/'s workspace$/u)],
        ["team", "Acme"],
      ]);
      const loneSurrogate = globalThis.String.fromCharCode(0xd800);
      const refused = yield* Effect.forEach(["", String.repeat(81)("x"), loneSurrogate], (name) =>
        Effect.flatMap(post("/api/workspaces", { name }, cookie), answer(InvalidInput)),
      );
      expect(Array.map(refused, (each) => [each.status, each.body.field])).toEqual(
        Array.replicate([400, "name"], 3),
      );
      const signedOut = yield* post("/api/workspaces", { name: "Acme" });
      expect(signedOut.status).toBe(401);
    }),
  );

  it.effect.prop(
    "a workspace made under any valid name is listed under that name",
    [NewWorkspace.fields.name],
    ([name]) =>
      Effect.gen(function* () {
        yield* migrate;
        const cookie = yield* signIn(address("prop"));
        const created = yield* Effect.flatMap(
          post("/api/workspaces", { name }, cookie),
          answer(MyWorkspace),
        );
        const { body } = yield* me(cookie);
        expect(Array.filter(body.workspaces, ({ id }) => id === created.body.id)).toEqual([
          created.body,
        ]);
        expect(created.body.name).toBe(name);
      }),
    { arbitrary: { runs: 10 } },
  );

  it.effect("a magic link works once, and not after five minutes", () =>
    Effect.gen(function* () {
      yield* migrate;
      const email = address("lin");
      const link = yield* requestLink(email);
      const first = yield* open(link);
      expect([first.status, startsSession(first)]).toEqual([302, true]);
      const second = yield* open(link);
      expect(second.status).toBe(302);
      expect(startsSession(second)).toBe(false);
      expect(second.headers.get("location")).toContain("error=INVALID_TOKEN");

      const withinFive = yield* requestLink(email);
      const opened = yield* later(4 * 60_000, open(withinFive));
      expect(startsSession(opened)).toBe(true);
      const stale = yield* requestLink(email);
      const expired = yield* later(5 * 60_000 + 1_000, open(stale));
      expect(startsSession(expired)).toBe(false);
      expect(expired.headers.get("location")).toContain("error=");
    }),
  );

  it.effect(
    "a Google sign-in with a confirmed email joins the magic-link user; an unconfirmed one does not",
    () =>
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const accountsOf = (email: string) =>
          sql<{ readonly providerId: string }>`
          select a.providerId from account a join user u on u.id = a.userId
          where u.email = ${email} order by a.providerId`;
        const usersNamed = (email: string) =>
          sql<{ readonly id: string }>`select id from user where email = ${email}`;

        const ada = address("ada");
        const adaCookie = yield* signIn(ada);
        const adaMe = yield* me(adaCookie);
        const google = yield* Effect.flatMap(
          post("/api/auth/sign-in/social", {
            provider: "google",
            idToken: { token: `confirmed:${ada}` },
          }),
          answer(Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })),
        );
        expect(google.status).toBe(200);
        expect(google.body.user.id).toBe(adaMe.body.user.id);
        const adaUsers = yield* usersNamed(ada);
        const adaAccounts = yield* accountsOf(ada);
        expect(adaUsers).toEqual([{ id: adaMe.body.user.id }]);
        expect(Array.map(adaAccounts, ({ providerId }) => providerId)).toEqual(["google"]);

        const bob = address("bob");
        const bobCookie = yield* signIn(bob);
        const bobMe = yield* me(bobCookie);
        const refused = yield* post("/api/auth/sign-in/social", {
          provider: "google",
          idToken: { token: `unconfirmed:${bob}` },
        });
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(startsSession(refused)).toBe(false);
        const bobUsers = yield* usersNamed(bob);
        const bobAccounts = yield* accountsOf(bob);
        expect(bobUsers).toEqual([{ id: bobMe.body.user.id }]);
        expect(bobAccounts).toEqual([]);
      }),
  );

  it.effect("making the personal workspace again creates nothing", () =>
    Effect.gen(function* () {
      yield* migrate;
      const email = address("kay");
      const cookie = yield* signIn(email);
      const { body } = yield* me(cookie);
      const user = { email, id: body.user.id, name: "" };
      yield* ensurePersonalWorkspace(user);
      yield* ensurePersonalWorkspace(user);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly workspaces: number; readonly organizations: number }>`
        select count(*) as workspaces, count(distinct w.organization_id) as organizations
        from workspaces w join member m on m.organizationId = w.organization_id
        where m.userId = ${UserId.make(body.user.id)} and w.kind = 'personal'`;
      expect(rows).toEqual([{ workspaces: 1, organizations: 1 }]);
    }),
  );

  it.effect("a session past its update age is renewed by the routes behind sign-in", () =>
    Effect.gen(function* () {
      yield* migrate;
      const cookie = yield* signIn(address("ren"));
      const fresh = yield* send("/api/me", { headers: { cookie } });
      expect([fresh.status, startsSession(fresh)]).toEqual([200, false]);
      // Better Auth renews a session a day after it was last renewed, and a session lasts a week.
      const renewed = yield* later(25 * 3_600_000, send("/api/me", { headers: { cookie } }));
      expect([renewed.status, startsSession(renewed)]).toEqual([200, true]);
      const renewedCookie = cookiesOf(renewed);
      const again = yield* later(
        50 * 3_600_000,
        post("/api/workspaces", { name: "Later" }, renewedCookie),
      );
      expect([again.status, startsSession(again)]).toEqual([200, true]);
      // Past the first session's week, the renewed cookie still signs the person in.
      const nextWeek = yield* later(8 * 24 * 3_600_000, me(cookiesOf(again)));
      expect(nextWeek.status).toBe(200);
    }),
  );

  it.effect("first sign-ins at once leave one personal workspace", () =>
    Effect.gen(function* () {
      yield* migrate;
      const email = address("twin");
      const cookie = yield* signIn(email);
      const first = yield* me(cookie);
      // As if the sign-up batch had failed, so the next sign-ins each find no workspace.
      const sql = yield* SqlClient.SqlClient;
      const theirs = sql`select organizationId from member where userId = ${first.body.user.id}`;
      yield* sql`delete from usage where workspace_id in (select id from workspaces where organization_id in (${theirs}))`;
      yield* sql`delete from workspaces where organization_id in (${theirs})`;
      yield* sql`delete from organization where id in (${theirs})`;
      const user = { email, id: first.body.user.id, name: "" };
      yield* Effect.all(Array.replicate(ensurePersonalWorkspace(user), 4), {
        concurrency: "unbounded",
      });
      const rows = yield* sql<{ readonly workspaces: number; readonly organizations: number }>`
        select count(*) as workspaces, count(distinct w.organization_id) as organizations
        from workspaces w join member m on m.organizationId = w.organization_id
        where m.userId = ${UserId.make(first.body.user.id)} and w.kind = 'personal'`;
      expect(rows).toEqual([{ workspaces: 1, organizations: 1 }]);
    }),
  );

  it.effect("Better Auth's member and invitation routes are off", () =>
    Effect.gen(function* () {
      yield* migrate;
      const ownerCookie = yield* signIn(address("lead"));
      const team = yield* Effect.flatMap(
        post("/api/workspaces", { name: "Team" }, ownerCookie),
        answer(MyWorkspace),
      );
      const memberCookie = yield* signIn(address("mate"));
      const member = yield* me(memberCookie);
      const inviteeEmail = address("invitee");
      const inviteeCookie = yield* signIn(inviteeEmail);
      const owner = yield* me(ownerCookie);
      const sql = yield* SqlClient.SqlClient;
      const [organizationId] = yield* Effect.map(
        sql<{
          readonly organization_id: string;
        }>`select organization_id from workspaces where id = ${team.body.id}`,
        Array.map(({ organization_id }) => organization_id),
      );
      const memberId = randomId("mem");
      const invitationId = randomId("inv");
      const at = "2026-11-27T00:00:00.000Z";
      yield* sql`insert into member (id, organizationId, userId, role, createdAt) values (${memberId}, ${organizationId}, ${member.body.user.id}, 'member', ${at})`;
      yield* sql`insert into invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) values (${invitationId}, ${organizationId}, ${inviteeEmail}, 'member', 'pending', '2999-01-01T00:00:00.000Z', ${at}, ${owner.body.user.id})`;
      const refused = yield* Effect.forEach(
        [
          [
            "/api/auth/organization/remove-member",
            { memberIdOrEmail: memberId, organizationId },
            ownerCookie,
          ],
          ["/api/auth/organization/leave", { organizationId }, memberCookie],
          [
            "/api/auth/organization/invite-member",
            { email: address("guest"), role: "member", organizationId },
            ownerCookie,
          ],
          ["/api/auth/organization/accept-invitation", { invitationId }, inviteeCookie],
        ] as const,
        ([path, request, cookie]) =>
          Effect.map(post(path, request, cookie), (response) => response.status),
      );
      expect(refused).toEqual([404, 404, 404, 404]);
      const members = yield* sql<{ readonly userId: string }>`
        select userId from member where organizationId = ${organizationId} order by userId`;
      const invitations = yield* sql<{ readonly status: string }>`
        select status from invitation where organizationId = ${organizationId}`;
      expect(Array.map(members, ({ userId }) => userId)).toEqual(
        Array.sort([owner.body.user.id, member.body.user.id], Order.String),
      );
      expect(invitations).toEqual([{ status: "pending" }]);
    }),
  );

  it.effect("GET /api/me lists a granted document from another workspace, with only its name", () =>
    Effect.gen(function* () {
      yield* migrate;
      const ownerCookie = yield* signIn(address("owner"));
      const acme = yield* Effect.flatMap(
        post("/api/workspaces", { name: "Acme" }, ownerCookie),
        answer(MyWorkspace),
      );
      const owner = yield* me(ownerCookie);
      const guestCookie = yield* signIn(address("guest"));
      const guest = yield* me(guestCookie);
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-27T00:00:00.000Z";
      const documentId = randomId("doc");
      yield* sql`insert into documents (id, workspace_id, title, visibility, member_access, current_prd, created_by, created_at, updated_at)
        values (${documentId}, ${acme.body.id}, 'Launch', 'private', 'edit', ${randomId("rev")}, ${owner.body.user.id}, ${at}, ${at})`;
      yield* sql`insert into document_grants values (${documentId}, ${guest.body.user.id}, 'comment', ${owner.body.user.id}, ${at})`;
      yield* sql`insert into document_grants values (${documentId}, ${owner.body.user.id}, 'manage', ${owner.body.user.id}, ${at})`;
      const guestNow = yield* me(guestCookie);
      const ownerNow = yield* me(ownerCookie);
      expect(guestNow.body.sharedWithMe).toEqual([
        { access: "comment", id: documentId, title: "Launch", workspaceName: "Acme" },
      ]);
      // A grant in a workspace the person belongs to is not "shared with me".
      expect(ownerNow.body.sharedWithMe).toEqual([]);
    }),
  );

  it.effect("a device code approved in the browser gives a bearer token that /api/me accepts", () =>
    Effect.gen(function* () {
      yield* migrate;
      const email = address("cli");
      const cookie = yield* signIn(email);
      const issued = yield* Effect.flatMap(
        post("/api/auth/device/code", { client_id: "cairn-cli" }),
        answer(
          Schema.Struct({ device_code: Schema.NonEmptyString, user_code: Schema.NonEmptyString }),
        ),
      );
      // The person opens the verification page signed in, which claims the code, then approves it.
      const claimed = yield* send(
        `/api/auth/device?user_code=${encodeURIComponent(issued.body.user_code)}`,
        { headers: { cookie } },
      );
      const approved = yield* post(
        "/api/auth/device/approve",
        { userCode: issued.body.user_code },
        cookie,
      );
      expect([issued.status, claimed.status, approved.status]).toEqual([200, 200, 200]);
      const token = yield* Effect.flatMap(
        post("/api/auth/device/token", {
          client_id: "cairn-cli",
          device_code: issued.body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        answer(Schema.Struct({ access_token: Schema.NonEmptyString })),
      );
      const signedIn = yield* Effect.flatMap(
        send("/api/me", { headers: { authorization: `Bearer ${token.body.access_token}` } }),
        answer(Me),
      );
      expect([signedIn.status, signedIn.body.user.email]).toEqual([200, email]);
      const forged = yield* send("/api/me", { headers: { authorization: "Bearer not-a-token" } });
      expect(forged.status).toBe(401);
    }),
  );

  it.effect("a person left without a personal workspace gets one at their next sign-in", () =>
    Effect.gen(function* () {
      yield* migrate;
      const email = address("eve");
      const firstCookie = yield* signIn(email);
      const first = yield* me(firstCookie);
      // As if the sign-up batch had failed: the user is there, the workspace is not.
      const sql = yield* SqlClient.SqlClient;
      const theirs = sql`select organizationId from member where userId = ${first.body.user.id}`;
      yield* sql`delete from usage where workspace_id in (select id from workspaces where organization_id in (${theirs}))`;
      yield* sql`delete from workspaces where organization_id in (${theirs})`;
      yield* sql`delete from organization where id in (${theirs})`;
      const cookie = yield* signIn(email);
      const stranded = yield* me(cookie);
      expect(Array.map(stranded.body.workspaces, ({ kind }) => kind)).toEqual(["personal"]);
      expect(stranded.body.user.id).toBe(first.body.user.id);
    }),
  );

  it.effect("the organization routes that would skip a workspace's rows are off", () =>
    Effect.gen(function* () {
      yield* migrate;
      const cookie = yield* signIn(address("ola"));
      const { body } = yield* me(cookie);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly organizationId: string; readonly memberId: string }>`
        select w.organization_id as organizationId, m.id as memberId
        from workspaces w join member m on m.organizationId = w.organization_id
        where m.userId = ${body.user.id}`;
      const { organizationId, memberId } = yield* Effect.fromOption(Array.head(rows));
      const refused = yield* Effect.forEach(
        [
          ["/api/auth/organization/update", { data: { name: "Renamed" }, organizationId }],
          ["/api/auth/organization/delete", { organizationId }],
          [
            "/api/auth/organization/update-member-role",
            { memberId, organizationId, role: ["owner", "admin"] },
          ],
        ] as const,
        ([path, request]) => Effect.map(post(path, request, cookie), (response) => response.status),
      );
      expect(Array.every(refused, (status) => status >= 400)).toBe(true);
      const after = yield* me(cookie);
      expect(after.body.workspaces).toEqual(body.workspaces);
    }),
  );

  it.effect("a way in is on only when CAIRN_AUTH names it, and needs its secrets", () =>
    Effect.gen(function* () {
      const emailOnly = yield* settingsFor("email", "", "");
      const both = yield* settingsFor("github, email", "id", "secret");
      const noSecrets = yield* settingsFor("google", "", "");
      const unknown = yield* settingsFor("email,password", "", "");
      expect(
        Array.map([emailOnly, both], (result) =>
          Result.match(result, {
            onFailure: () => [],
            onSuccess: ({ ways }) => Array.sort(Array.fromIterable(ways), Order.String),
          }),
        ),
      ).toEqual([["email"], ["email", "github"]]);
      expect(Array.map([noSecrets, unknown], Result.isFailure)).toEqual([true, true]);
    }),
  );

  it.effect("the D1 migrations hold every table and column Better Auth needs", () =>
    Effect.gen(function* () {
      yield* migrate;
      const { toBeAdded, toBeCreated } = yield* Effect.promise(() =>
        getMigrations(
          Struct.assign(
            authOptions(settings, {
              checkInvitation: none,
              membershipLimit: () => Promise.resolve(1),
              sendSignInLink: none,
              sessionCreated: none,
              userCreated: none,
            }),
            { database: env.DB, secret: Redacted.value(settings.secret) },
          ),
        ),
      );
      expect([toBeCreated, toBeAdded]).toEqual([[], []]);
    }),
  );
});
