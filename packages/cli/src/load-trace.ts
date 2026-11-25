import { createHash } from "node:crypto";

import { rollupOf, traceOf } from "@cairn/core";
import type { TraceInput } from "@cairn/core";
import { Effect, Option, Schema, Struct } from "effect";

import { Git } from "./git.ts";
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
 * reads for the manifest. No judgments yet, so the Trace has none.
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
    prd,
    rollup: rollupOf,
    spec,
    specIndex: Option.match(specIndex, { onNone: () => [], onSome: Struct.get("sections") }),
  } satisfies TraceInput;
});

/** The `Trace` of the repository (see `spec.server`). */
export const loadTrace = Effect.map(loadTraceInput, traceOf);

/** The SHA-256, in hex, of the inputs the Trace is a function of; it changes when any of them does. */
export const inputsHashOf = (input: TraceInput): string =>
  createHash("sha256")
    .update(encodeJson(Struct.omit(input, ["rollup"])))
    .digest("hex");
