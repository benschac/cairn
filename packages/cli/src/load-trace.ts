import { createHash } from "node:crypto";

import { rollupOf, traceOf } from "@cairn/core";
import type { TraceInput } from "@cairn/core";
import { Effect, Option, Schema, Struct } from "effect";

import { Git } from "./git.ts";
import { TraceStore } from "./trace-store.ts";
import {
  loadConfig,
  loadEvents,
  loadManifest,
  loadPrd,
  loadSpec,
  loadSpecIndex,
} from "./workspace.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Everything `traceOf` reads, from the main checkout's `.cairn/` files and from git: the PRD and
 * spec, the manifest, the spec index and events and config when present, and the commits `Git.log`
 * reads for the manifest. No judgments yet, so the Trace has none. Notes are in `cairn.db`, which
 * `loadServedTraceInput` adds, so these have none.
 */
export const loadTraceInput = Effect.gen(function* () {
  const git = yield* Git;
  const [prd, spec, manifest, specIndex, events, config] = yield* Effect.all([
    loadPrd,
    loadSpec,
    loadManifest,
    loadSpecIndex,
    loadEvents,
    loadConfig,
  ]);
  const commits = yield* git.log(manifest);
  return {
    commits,
    config,
    events,
    judgments: [],
    manifest,
    notes: [],
    prd,
    rollup: rollupOf,
    spec,
    specIndex: Option.match(specIndex, { onNone: () => [], onSome: Struct.get("sections") }),
  } satisfies TraceInput;
});

/**
 * What the server and `cairn status --json` build the Trace from: `loadTraceInput` and the notes in
 * `cairn.db`. A stored note that does not decode is a defect, as a session's row is in the server.
 */
export const loadServedTraceInput = Effect.gen(function* () {
  const store = yield* TraceStore;
  const [input, notes] = yield* Effect.all([
    loadTraceInput,
    store.notes.pipe(Effect.catchTag("SchemaError", (error) => Effect.die(error))),
  ]);
  return Struct.assign(input, { notes });
});

/** The `Trace` of the repository (see `spec.server`). */
export const loadTrace = Effect.map(loadTraceInput, traceOf);

/** The SHA-256, in hex, of the inputs the Trace is a function of; it changes when any of them does. */
export const inputsHashOf = (input: TraceInput): string =>
  createHash("sha256")
    .update(encodeJson(Struct.omit(input, ["rollup"])))
    .digest("hex");
