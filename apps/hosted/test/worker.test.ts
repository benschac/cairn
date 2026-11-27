import { DecodeFailures, DocumentId, InvalidInput, NotFound } from "@cairn/contract/hosted";
import { expect, it, layer } from "@effect/vitest";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Array, Effect, Exit, Layer, Logger, Ref, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { SqlClient } from "effect/sql";

import { HostedEnv } from "../src/env.ts";
import { ReportedFailures } from "../src/http/reported-failures.ts";
import { routesFor } from "../src/http/routes.ts";
import worker from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly MIGRATIONS: D1Migration[];
    }
  }
}

/** A response's status and its JSON body decoded with `schema`. */
const answer = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Effect.fn("answer")(function* (response: Response) {
    const body = yield* Effect.promise(() => response.json());
    return { status: response.status, body: yield* Schema.decodeUnknownEffect(schema)(body) };
  });

it.effect.prop(
  "an unknown route under /api is a 404 in the error shape, stored by no cache",
  [
    Schema.Literals(["GET", "POST", "DELETE"]),
    Schema.String.check(Schema.isPattern(/^[a-z]{1,12}$/u)),
  ],
  ([method, segment]) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        worker.fetch(new Request(`http://hosted.test/api/${segment}/${segment}`, { method })),
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { status, body } = yield* answer(NotFound)(response);
      expect(status).toBe(404);
      expect(body.code).toBe("not-found");
    }),
);

// An API of the Worker's shape with a body, a path parameter and a bug, served through the same
// routes as the hosted API, with a logger that keeps what is logged as an error.
const Probe = Schema.Struct({ title: Schema.NonEmptyString, size: Schema.Int });
const ProbeApi = HttpApi.make("probe")
  .add(
    HttpApiGroup.make("probe")
      .add(HttpApiEndpoint.post("create", "/api/probe", { payload: Probe }))
      .add(HttpApiEndpoint.get("read", "/api/probe/:id", { params: { id: DocumentId } }))
      .add(HttpApiEndpoint.get("broken", "/api/broken")),
  )
  .middleware(DecodeFailures);
const ProbeLive = HttpApiBuilder.group(ProbeApi, "probe", (handlers) =>
  handlers
    .handle("create", () => Effect.void)
    .handle("read", () => Effect.void)
    .handle("broken", () => Effect.die("A bug in a handler")),
);
const errors = Ref.makeUnsafe<ReadonlyArray<string>>([]);
const Recording = Logger.layer([
  Logger.make(({ logLevel, message }) =>
    logLevel === "Error"
      ? Effect.runSync(Ref.update(errors, Array.append(globalThis.String(message))))
      : undefined,
  ),
]);
const probe = HttpRouter.toWebHandler(
  routesFor(HttpApiBuilder.layer(ProbeApi).pipe(Layer.provide(ProbeLive))).pipe(
    Layer.provide(ReportedFailures),
    Layer.provideMerge(Recording),
  ),
);
const send = (path: string, init?: RequestInit) =>
  Effect.promise(() => probe.handler(new Request(`http://hosted.test${path}`, init)));
const post = (body: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
    Effect.orDie,
    Effect.flatMap((text) =>
      send("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      }),
    ),
  );

it.effect.prop(
  "a body field that does not decode is invalid-input naming that field",
  [Probe, Schema.Literals(["title", "size"])],
  ([valid, broken]) =>
    Effect.gen(function* () {
      const response = yield* post({
        title: broken === "title" ? "" : valid.title,
        size: broken === "size" ? "many" : valid.size,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      const { status, body } = yield* answer(InvalidInput)(response);
      expect([status, body.field]).toEqual([400, broken]);
      const accepted = yield* post(valid);
      expect(accepted.status).toBe(204);
    }),
);

it.effect("a path parameter that does not decode is invalid-input naming the parameter", () =>
  Effect.gen(function* () {
    const response = yield* send("/api/probe/not-a-document");
    const { status, body } = yield* answer(InvalidInput)(response);
    expect([status, body.field]).toEqual([400, "id"]);
  }),
);

it.effect("only a defect is logged as an error; a refusal the API owes is not", () =>
  Effect.gen(function* () {
    const before = yield* Ref.get(errors);
    const refused = yield* Effect.forEach(
      [send("/api/nowhere"), send("/api/probe/not-a-document"), post({ title: "" })],
      (request) => Effect.map(request, (response) => response.status),
    );
    const afterRefusals = yield* Ref.get(errors);
    const broken = yield* send("/api/broken");
    const afterBug = yield* Ref.get(errors);
    expect(refused).toEqual([404, 400, 400]);
    expect(afterRefusals).toEqual(before);
    expect(broken.status).toBe(500);
    expect(Array.length(afterBug)).toBe(Array.length(before) + 1);
  }),
);

const migrate = Effect.promise(() => applyD1Migrations(env.DB, env.MIGRATIONS));

layer(HostedEnv.layer(env))("the D1 schema", (d1) => {
  d1.effect("the migrations create every table the hosted service adds", () =>
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`select name from sqlite_master where type = 'table'`;
      expect(Array.map(tables, ({ name }) => name)).toEqual(
        expect.arrayContaining([
          "workspaces",
          "documents",
          "document_grants",
          "document_invitations",
          "agents",
          "connections",
          "usage",
          "pending_revocations",
        ]),
      );
    }),
  );

  d1.effect(
    "a new document's access epoch starts at 0, and an organization has one workspace",
    () =>
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-27T00:00:00.000Z";
        yield* sql`insert into workspaces values ('w_aaaaaaaaaaaa', 'org-1', 'personal', 'Ada', ${at})`;
        yield* sql`insert into documents (id, workspace_id, title, visibility, member_access, current_prd, created_by, created_at, updated_at)
        values ('doc_aaaaaaaaaaaa', 'w_aaaaaaaaaaaa', 'Launch', 'private', 'edit', 'rev_aaaaaaaaaaaa', 'user-1', ${at}, ${at})`;
        const [document] = yield* sql<{
          readonly access_epoch: number;
        }>`select access_epoch from documents`;
        expect(document).toEqual({ access_epoch: 0 });
        const second = yield* Effect.exit(
          sql`insert into workspaces values ('w_bbbbbbbbbbbb', 'org-1', 'team', 'Ada', ${at})`,
        );
        expect(Exit.isFailure(second)).toBe(true);
      }),
  );
});
