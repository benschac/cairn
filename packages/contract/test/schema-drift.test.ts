import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, Record } from "effect";

import { schemaDocuments, staleFiles } from "../scripts/generate-schema.ts";

it.layer(NodeServices.layer)("the committed JSON Schemas", (t) => {
  t.effect("are what the contract generates now", () =>
    Effect.gen(function* () {
      const stale = yield* staleFiles;
      expect(stale).toEqual([]);
    }),
  );

  t.effect("cover the manifest, an event, the configuration and the hosted shapes", () =>
    Effect.sync(() => {
      expect(Record.keys(schemaDocuments)).toEqual([
        "manifest.schema.json",
        "event.schema.json",
        "config.schema.json",
        "hosted-document.schema.json",
        "hosted-entitlements.schema.json",
        "hosted-error.schema.json",
        "hosted-plan-record.schema.json",
        "hosted-revision.schema.json",
        "hosted-room-message.schema.json",
        "hosted-save-input.schema.json",
        "hosted-thread.schema.json",
      ]);
      expect(
        Array.every(
          Record.values(schemaDocuments),
          (document) =>
            document.$schema === "https://json-schema.org/draft/2020-12/schema" &&
            !Record.has(document, "dialect") &&
            (Record.has(document, "type") || Record.has(document, "anyOf")),
        ),
      ).toBe(true);
    }),
  );
});
