import { Event, Manifest, ParticipantKind, Sha, TaskStatus } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { setupEffect } from "@xstate/effect";
import { assertTestCoverage, mergeEventGenerators, propertyTest, replayTest } from "@xstate/test";
import type { TestSut, TestSutSession } from "@xstate/test";
import { eventsFromSchemas, fromEffectSchema } from "@xstate/test/effect-schema";
import {
  Array,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Number,
  Option,
  Random,
  Ref,
  Schema,
  String,
  Struct,
} from "effect";
import type { EventFrom, SnapshotFrom } from "xstate";

import { GitCommit, derive } from "../src/index.ts";
import type { GateConfig } from "../src/index.ts";
import { agentApproves, landingSkipsGate } from "./fixtures/derive-gate.ts";

/**
 * The model of one task's inputs (see spec.testing.derivation-model): what an orchestrator writes
 * to `events.jsonl` and what git shows. It keeps facts, not a running status: the reports so far,
 * whether any commit was made and whether one touched a gated path, and whether the task landed.
 * After every event it replays the reports from the start under those facts.
 */
const Report = Schema.Struct({ actor: ParticipantKind, status: TaskStatus });
type Report = typeof Report.Type;

const Facts = Schema.Struct({
  committed: Schema.Boolean,
  gated: Schema.Boolean,
  landed: Schema.Boolean,
  reports: Schema.Array(Report),
});
type Facts = typeof Facts.Type;

/** What a report does from a status, written from prd.orchestrator-contract and prd.human-gates. */
const lifecycle = (gated: boolean, from: TaskStatus, report: Report): Option.Option<TaskStatus> => {
  const finished: Option.Option<TaskStatus> =
    from === "running" ? Option.some(gated ? "blocked_on_human" : "done") : Option.none();
  return Match.value(report.status).pipe(
    Match.when("pending", () => Option.none()),
    Match.when("running", () =>
      from === "pending" || from === "failed" ? Option.some("running" as const) : Option.none(),
    ),
    // A gated task reported done stops for a human, and only a human's done takes it on.
    Match.when("done", () =>
      from === "blocked_on_human" && report.actor === "human"
        ? Option.some("done" as const)
        : finished,
    ),
    Match.when("blocked_on_human", () => finished),
    Match.when("failed", () =>
      from === "running" ? Option.some("failed" as const) : Option.none(),
    ),
    Match.when("landed", () => (from === "done" ? Option.some("landed" as const) : Option.none())),
    Match.exhaustive,
  );
};

interface Replayed {
  readonly status: TaskStatus;
  readonly warnings: number;
}

const warned = (replayed: Replayed): Replayed =>
  Struct.evolve(replayed, { warnings: Number.increment });

/**
 * The status and the number of warnings the facts give. A report the lifecycle does not allow is a
 * warning. A landed task lands from `done`; from anywhere else it keeps its status and warns.
 */
const unreported: Replayed = { status: "pending", warnings: 0 };

const replay = (facts: Facts): Replayed => {
  const reported = Array.reduce(facts.reports, unreported, (replayed, report) =>
    Option.match(lifecycle(facts.gated, replayed.status, report), {
      onNone: () => warned(replayed),
      onSome: (status) => Struct.evolve(replayed, { status: () => status }),
    }),
  );
  return !facts.landed || reported.status === "landed"
    ? reported
    : reported.status === "done"
      ? Struct.evolve(reported, { status: () => "landed" as const })
      : warned(reported);
};

const after = (facts: Facts) => ({ context: facts, target: replay(facts).status });

/** Every status takes every event the same way, each state with transitions of its own. */
const on = () => ({
  committed: ({ context, event }: { context: Facts; event: { readonly gated: boolean } }) =>
    after(
      Struct.evolve(context, { committed: () => true, gated: (gated) => gated || event.gated }),
    ),
  // A merge reaches the commits the task has; with none, nothing lands.
  merged: ({ context }: { context: Facts }) =>
    after(Struct.evolve(context, { landed: (landed) => landed || context.committed })),
  reported: ({ context, event }: { context: Facts; event: Report }) =>
    after(
      Struct.evolve(context, {
        reports: (reports) => Array.append(reports, { actor: event.actor, status: event.status }),
      }),
    ),
  squashed: ({ context }: { context: Facts }) =>
    after(Struct.evolve(context, { landed: () => true })),
});

const derivationModel = setupEffect({
  schemas: {
    context: Facts,
    events: {
      committed: Schema.Struct({ gated: Schema.Boolean }),
      merged: Schema.Struct({}),
      reported: Report,
      squashed: Schema.Struct({}),
    },
  },
}).createMachine({
  context: { committed: false, gated: false, landed: false, reports: [] },
  id: "derivation",
  initial: "pending",
  states: {
    blocked_on_human: { on: on() },
    done: { on: on() },
    failed: { on: on() },
    landed: { on: on() },
    pending: { on: on() },
    running: { on: on() },
  },
});

const TASK = "t1";
const BRANCH = "cairn-mvp/01-derive";
const MIGRATION = "db/migrations/001-init.sql";
const PLAIN = "packages/core/src/plain.ts";
const config: GateConfig = { humanPaths: ["**/migrations/**"] };

/** One task, ungated in the plan, so only a commit can gate it. */
const manifest = Schema.decodeSync(Manifest)({
  baseBranch: "main",
  feature: "cairn-mvp",
  tasks: [
    {
      branch: BRANCH,
      commits: [],
      dependsOn: [],
      files: [PLAIN],
      humanGate: { reasons: [], required: false },
      id: TASK,
      model: "sonnet",
      parent: null,
      prdSections: ["prd.orchestrator-contract"],
      reasoning: "low",
      sessions: [],
      specSections: ["spec.status.derivation"],
      status: "pending",
      title: "Derive me",
      worktree: null,
    },
  ],
  version: 1,
});

const shaOf = (n: number): Sha => Schema.decodeSync(Sha)(String.padStart(40, "0")(`${n}`));

/** The commit numbered `n`, with every trailer for the task. */
const commitOf = (
  n: number,
  files: ReadonlyArray<string>,
  branch: string | null,
  onBase: boolean,
) =>
  Schema.decodeSync(GitCommit)({
    branch,
    files,
    onBase,
    parents: n === 0 ? [] : [shaOf(n - 1)],
    sections: ["spec.status.derivation"],
    session: "s_abc123",
    sha: shaOf(n),
    subject: `Commit ${n}`,
    taskId: TASK,
  });

/**
 * Git as derivation reads it, with an in-memory commit graph for a layer. The live service is the
 * CLI's (spec.package-layout); core takes plain values, so the test reads the commits through this.
 * Stand-in until t21 adds the `Git` service: replace this with that service's in-memory layer.
 */
class Git extends Context.Service<
  Git,
  {
    /** A commit with the task's trailers on its branch. */
    readonly commit: (file: string) => Effect.Effect<void>;
    readonly log: Effect.Effect<ReadonlyArray<GitCommit>>;
    /** Merges the task branch: `baseBranch` reaches every commit on it so far. */
    readonly merge: Effect.Effect<void>;
    /** A squash merge: one commit on `baseBranch` with the task's trailer and its files. */
    readonly squash: Effect.Effect<void>;
  }
>()("@cairn/core/test/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const commits = yield* Ref.make<ReadonlyArray<GitCommit>>([]);
      const add = (make: (n: number, all: ReadonlyArray<GitCommit>) => GitCommit) =>
        Ref.update(commits, (all) => Array.append(all, make(all.length, all)));
      return Git.of({
        commit: (file) => add((n) => commitOf(n, [file], BRANCH, false)),
        log: Ref.get(commits),
        merge: Ref.update(
          commits,
          Array.map((commit) =>
            commit.branch === BRANCH ? Struct.evolve(commit, { onBase: () => true }) : commit,
          ),
        ),
        squash: add((n, all) =>
          commitOf(n, Array.dedupe(Array.flatMap(all, ({ files }) => files)), null, true),
        ),
      });
    }),
  );
}

type Model = typeof derivationModel;
type ModelEvent = EventFrom<Model>;

/** What a read compares: the task's status and how many warnings derivation gave. */
const projectModel = (snapshot: SnapshotFrom<Model>): Replayed => ({
  status: snapshot.value,
  warnings: replay(snapshot.context).warnings,
});

const actorOf = (kind: ParticipantKind) => (kind === "human" ? "human:ben" : "agent:codex");

const makeSession = Effect.gen(function* () {
  const git = yield* Git;
  const lines = yield* Ref.make<ReadonlyArray<Event>>([]);
  const reads = yield* Ref.make(0);

  const perform = Match.type<ModelEvent>().pipe(
    Match.discriminator("type")("reported", ({ actor, status }) =>
      Ref.update(lines, (written) =>
        Array.append(
          written,
          Schema.decodeSync(Event)({
            actor: actorOf(actor),
            status,
            taskId: TASK,
            // Each line is a second after the one before.
            ts: DateTime.formatIso(DateTime.makeUnsafe(written.length * 1000)),
          }),
        ),
      ),
    ),
    Match.discriminator("type")("committed", ({ gated }) => git.commit(gated ? MIGRATION : PLAIN)),
    Match.discriminator("type")("merged", () => git.merge),
    Match.discriminator("type")("squashed", () => git.squash),
    Match.exhaustive,
  );

  // The order of lines in the file must not matter, so every read shuffles them first.
  const read = Effect.gen(function* () {
    const seed = yield* Ref.getAndUpdate(reads, Number.increment);
    const shuffled = yield* Ref.get(lines).pipe(
      Effect.flatMap(Random.shuffle),
      Random.withSeed(seed),
    );
    const commits = yield* git.log;
    const derived = derive(manifest, [], config, shuffled, commits);
    return {
      status: Option.match(Array.head(derived.tasks), {
        onNone: () => "pending" as const,
        onSome: ({ status }) => status,
      }),
      warnings: derived.warnings.length,
    } satisfies Replayed;
  });

  return { perform, read };
});

const sutIn = (services: Context.Context<never>) => {
  const runWith = Effect.runPromiseWith(services);
  const sut: TestSut<SnapshotFrom<Model>, ModelEvent> = {
    create: () =>
      runWith(
        makeSession.pipe(
          Effect.provide(Git.layer),
          Effect.map(
            ({ perform, read }) =>
              ({
                read: () => runWith(read),
                send: (event) => runWith(perform(event)),
              }) satisfies TestSutSession<SnapshotFrom<Model>, ModelEvent>,
          ),
        ),
      ),
    projectModel,
  };
  return sut;
};

// A landing or a commit acts on the reports before it, so a report is as likely as the other three
// together; otherwise few runs reach `done` and its transitions go untaken.
const events = mergeEventGenerators(eventsFromSchemas(derivationModel), {
  reported: { generate: fromEffectSchema(Report), weight: 3 },
});

it.effect("derive gives the status and warnings a model of its inputs gives", () =>
  Effect.gen(function* () {
    const services = yield* Effect.context();
    const sut = sutIn(services);
    const { coverage } = yield* Effect.promise(() =>
      propertyTest(derivationModel, { events, maxCommands: 16, numRuns: 300, seed: 1, sut }),
    );
    assertTestCoverage(coverage, { transitions: 1 });
    // A transition function's transition is "unknown" until taken, and the ratio above skips it.
    expect(coverage.transitions.unknown).toStrictEqual([]);
  }),
);

// The shrunk failure of a derive that let an agent's done approve a gated task.
it.effect("an agent's done after a migration commit leaves the task blocked on a human", () =>
  Effect.gen(function* () {
    const services = yield* Effect.context();
    yield* Effect.promise(() =>
      replayTest(derivationModel, agentApproves, { expect: "pass", sut: sutIn(services) }),
    );
  }),
);

// The shrunk failure of a derive that dropped a merged commit's paths from the gate.
it.effect("a merge does not take a migration out of the gate", () =>
  Effect.gen(function* () {
    const services = yield* Effect.context();
    yield* Effect.promise(() =>
      replayTest(derivationModel, landingSkipsGate, { expect: "pass", sut: sutIn(services) }),
    );
  }),
);
