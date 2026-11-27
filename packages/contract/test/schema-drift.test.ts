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

  t.effect("cover the manifest, an event and the configuration", () =>
    Effect.sync(() => {
      expect(Record.keys(schemaDocuments)).toEqual([
        "manifest.schema.json",
        "event.schema.json",
        "config.schema.json",
      ]);
      expect(
        Array.every(
          Record.values(schemaDocuments),
          (document) =>
            document.$schema === "https://json-schema.org/draft/2020-12/schema" &&
            !Record.has(document, "dialect") &&
            Record.has(document, "type"),
        ),
      ).toBe(true);
    }),
  );
});
