import {
  Event,
  Manifest,
  ParticipantKind,
  SessionId,
  SpecSectionId,
  TaskId,
  TaskStatus,
} from "@cairn/contract";
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
  Match,
  Number,
  Option,
  Random,
  Ref,
  Schema,
  Struct,
} from "effect";
import type { EventFrom, SnapshotFrom } from "xstate";

// Core takes plain values and the Git service is the CLI's (spec.package-layout); a package
// dependency would make a cycle, so the test reads the in-memory layer by path.
import { Git, GitHistory } from "../../cli/src/git.ts";
import { derive } from "../src/index.ts";
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

/** The trailers an orchestrator writes on every commit of the task. */
const trailers = {
  sections: [SpecSectionId.make("spec.status.derivation")],
  session: SessionId.make("s_abc123"),
  taskId: TaskId.make(TASK),
};

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
  const history = yield* GitHistory;
  yield* history.branch(BRANCH, manifest.baseBranch);
  const lines = yield* Ref.make<ReadonlyArray<Event>>([]);
  const reads = yield* Ref.make(0);

  const write = Match.type<ModelEvent>().pipe(
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
    Match.discriminator("type")("committed", ({ gated }) =>
      history.commit(
        BRANCH,
        Struct.assign(trailers, { files: [gated ? MIGRATION : PLAIN], subject: "Commit" }),
      ),
    ),
    Match.discriminator("type")("merged", () => history.merge(BRANCH, manifest.baseBranch)),
    Match.discriminator("type")("squashed", () =>
      history.squash(BRANCH, manifest.baseBranch, Struct.assign(trailers, { subject: "Squash" })),
    ),
    Match.exhaustive,
  );
  const perform = (event: ModelEvent) => Effect.asVoid(write(event));

  // The order of lines in the file must not matter, so every read shuffles them first.
  const read = Effect.gen(function* () {
    const seed = yield* Ref.getAndUpdate(reads, Number.increment);
    const shuffled = yield* Ref.get(lines).pipe(
      Effect.flatMap(Random.shuffle),
      Random.withSeed(seed),
    );
    const commits = yield* git.log(manifest);
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
          Effect.provide(Git.memory(manifest.baseBranch)),
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
