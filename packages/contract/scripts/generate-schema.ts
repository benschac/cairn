// Writes the JSON Schemas of what a file in .cairn/ holds, for `@cairn/contract/js` to ship
// (spec.contract.javascript-entry):
//
//   node packages/contract/scripts/generate-schema.ts           write schema/*.schema.json
//   node packages/contract/scripts/generate-schema.ts --check   write nothing; fail when a committed file differs
//
// The files are compact JSON; `pnpm fix` formats them, so a comparison reads both as values.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array, Effect, FileSystem, Layer, Logger, Path, Record, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { Config } from "../src/config.ts";
import { Event } from "../src/events.ts";
import { Entitlements } from "../src/hosted/entitlements.ts";
import { HostedError } from "../src/hosted/errors.ts";
import { DocumentView } from "../src/hosted/document.ts";
import { ThreadView } from "../src/hosted/discussion.ts";
import { PlanRecord } from "../src/hosted/plan.ts";
import { RevisionBody, SaveInput } from "../src/hosted/revision.ts";
import { RoomMessage } from "../src/hosted/room.ts";
import { Manifest } from "../src/manifest.ts";

// A schema a validator can load as it is: the root schema with its `$schema` dialect and `$defs`,
// not Effect's `{ dialect, schema, definitions }` container, which no validator reads.
const standalone = (schema: Schema.Constraint): Record<string, unknown> => {
  const { dialect: _, schema: root, definitions } = Schema.toJsonSchemaDocument(schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...root,
    $defs: definitions,
  };
};

/** The standalone JSON Schema of each shipped schema, keyed by its file name in `schema/`. */
export const schemaDocuments = {
  "manifest.schema.json": standalone(Manifest),
  "event.schema.json": standalone(Event),
  "config.schema.json": standalone(Config),
  // What the hosted Worker, the viewer and `cairn connect` exchange (spec.hosted-launch.hosted-contract).
  "hosted-document.schema.json": standalone(DocumentView),
  "hosted-entitlements.schema.json": standalone(Entitlements),
  "hosted-error.schema.json": standalone(HostedError),
  "hosted-plan-record.schema.json": standalone(PlanRecord),
  "hosted-revision.schema.json": standalone(RevisionBody),
  "hosted-room-message.schema.json": standalone(RoomMessage),
  "hosted-save-input.schema.json": standalone(SaveInput),
  "hosted-thread.schema.json": standalone(ThreadView),
};

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeUnknownEffect(Json);
const decodeJson = Schema.decodeUnknownEffect(Json);

/** The schema directory of this package. */
export const schemaDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../schema", import.meta.url));
});

class Stale extends Schema.TaggedError<Stale, { readonly brand: unique symbol }>()("Stale", {
  files: Schema.Array(Schema.String),
}) {
  override get message() {
    return `${Array.join(this.files, ", ")} differ from the contract; run node packages/contract/scripts/generate-schema.ts and pnpm fix`;
  }
}

/** The files of `schema/` whose committed JSON is not the generated document. */
export const staleFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* schemaDir;
  const stale = yield* Effect.forEach(Record.toEntries(schemaDocuments), ([name, document]) =>
    fs.readFileString(path.join(dir, name)).pipe(
      Effect.flatMap(decodeJson),
      Effect.flatMap((committed) =>
        Effect.zipWith(encodeJson(committed), encodeJson(document), (a, b) => a !== b),
      ),
      Effect.orElseSucceed(() => true),
      Effect.map((differs) => (differs ? [name] : [])),
    ),
  );
  return Array.flatten(stale);
});

const generate = (input: { readonly check: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* schemaDir;
    if (input.check) {
      const files = yield* staleFiles;
      yield* Array.isReadonlyArrayNonEmpty(files) ? Effect.fail(new Stale({ files })) : Effect.void;
    } else {
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* Effect.forEach(Record.toEntries(schemaDocuments), ([name, document]) =>
        encodeJson(document).pipe(
          Effect.flatMap((text) => fs.writeFileString(path.join(dir, name), text)),
        ),
      );
    }
  });

if (import.meta.main) {
  const command = Command.make(
    "generate-schema",
    {
      check: Flag.Boolean("check").pipe(
        Flag.withDescription("Write nothing; fail when a committed file differs"),
        Flag.withDefault(false),
      ),
    },
    (input) =>
      generate(input).pipe(Effect.tapErrorTag("Stale", (error) => Effect.logError(error.message))),
  ).pipe(Command.withDescription("Regenerate the contract's JSON Schemas"));

  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
        NodeServices.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
