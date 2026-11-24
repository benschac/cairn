# Cairn MVP spec {#spec.cairn-mvp-spec}

This spec turns [prd.md](prd.md) into code. It is the first spec Cairn has, so it also sets the format that `cairn plan` writes.

Current implementation: the contract schemas, section parsing, task machine (including `failed`), gate detection, event and commit status derivation, presence, and the viewer’s canvas and reader are built. The CLI exposes `cairn init`; workspace loading and planner services are implemented underneath it. The viewer still loads a bundled demo trace. Planning commands, live trace integration, sessions and judging remain unfinished. Until live trace integration ships, the manifest and bundled demo are manually reconciled progress snapshots. Historical events are retained; they do not encode reopening completed tasks. The requirements below describe the complete target, not a claim that every section is built.

## Format {#spec.format}

- Context: `prd.goal`, `prd.non-goals-for-v1`, `prd.one-day-build-order`

Each spec section starts with a list of keys, before any prose. `cairn lint`, the planner and the viewer read them.

| Key          | Value                                        | Used for                                    |
| ------------ | -------------------------------------------- | ------------------------------------------- |
| `Implements` | PRD section IDs                              | Curves, rollup, coverage                    |
| `Files`      | Paths it will touch; a trailing `/` is a dir | Plan-time gate detection                    |
| `Depends on` | Spec section IDs                             | Stack order                                 |
| `Defers`     | PRD section IDs left for later               | Coverage; the viewer shows them as deferred |
| `Context`    | PRD section IDs that need no code            | Coverage; the viewer shows no badge         |

IDs are written in backticks and separated by commas. A key applies to its section and every section below it.

A PRD section is covered when it, or a section under it, appears in some `Implements`, `Defers` or `Context` key. A `Defers` or `Context` key covers the sections under the one it names too. "Under" means in the heading tree, not by ID prefix: the top heading does not namespace its children, so `prd.goal` sits under `prd.cairn-mvp`.

## Scope {#spec.scope}

- Defers: `prd.v2-diverging-state`, `prd.v2-multiplayer-on-cloudflare`, `prd.later`

This spec covers v1. Presence is the one v2 piece already built, and it stays: `cairn serve` keeps serving `/presence` next to the trace API.

## Package layout {#spec.package-layout}

- Implements: `prd.implementation-in-effect`

| Package       | Holds                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `contract`    | Schemas, generated JSON Schema, the plain JS entry                                                        |
| `core`        | Pure logic: sections, gates, stack order, lint, status derivation, rollup, redaction, machines            |
| `cli`         | Services, commands and the server. Two composition roots: `src/main.ts` (CLI) and `src/serve.ts` (server) |
| `apps/viewer` | The Foldkit viewer                                                                                        |

Core takes plain values and does no IO. Only the CLI touches disk, git, the database or a model, through these services:

| Service      | Live                                 | Test                           |
| ------------ | ------------------------------------ | ------------------------------ |
| `Git`        | `git` subprocesses                   | An in-memory commit graph      |
| `TraceStore` | `SqliteClient` on `.cairn/cairn.db`  | `SqliteClient` on `:memory:`   |
| `Planner`    | `LanguageModel` (see `spec.models`)  | Scripted replies from fixtures |
| `Judge`      | `DecisionModel` (see `spec.models`)  | Scripted answers               |
| `Redactor`   | Reads `.env*` and config, calls core | Fixed secret set               |

The PRD's `Clock` service is Effect's own `Clock`; tests use `TestClock`. Files go through Effect's `FileSystem`. Commands use `effect/cli`.

## Libraries {#spec.libraries}

- Implements: `prd.implementation-in-effect`, `prd.viewer`

Already installed, and kept:

| Library                       | Version                    | Used for                                          |
| ----------------------------- | -------------------------- | ------------------------------------------------- |
| `effect`                      | 4.1.5                      | Schema, services, `effect/cli`, `effect/ai`, HTTP |
| `xstate` and `@xstate/effect` | 6.0.0-beta.5, 1.0.0-beta.3 | Task and room machines                            |
| `foldkit`                     | 0.171.0                    | The viewer                                        |

Additional libraries, some installed and some planned:

| Library                                                                  | Version             | License    | Used for                                                                                                    |
| ------------------------------------------------------------------------ | ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `@pierre/diffs`                                                          | 1.6.4               | Apache-2.0 | Parsing patches into hunks and rendering task and commit diffs                                              |
| `@pierre/highlights`                                                     | 0.5.2               | Apache-2.0 | Syntax colours for fenced code in the viewer                                                                |
| `pele`                                                                   | 1.13.0              | MIT        | Drawing Mermaid diagrams as SVG in the viewer, and checking that one draws in `cairn lint` and `cairn plan` |
| `@xyflow/system`                                                         | 1.0.0               | MIT        | Bezier paths, viewport math and pan/zoom for the canvas; removed with it (see `spec.viewer.canvas-removal`) |
| `@effect/ai-anthropic`                                                   | 4.1.5               | MIT        | A live `LanguageModel` for the `Planner` when `planner.source` is `api`                                     |
| `@effect/ai-openai`, `@effect/ai-openai-compat`, `@effect/ai-openrouter` | 4.1.5               | MIT        | The other `api` providers (see `spec.models`)                                                               |
| `@effect/ai-typesafe`                                                    | 4.1.5               | MIT        | The live `DecisionModel` (Jev), for the `Judge`                                                             |
| `@effect/sql-sqlite-node`                                                | 4.1.5               | MIT        | `SqliteClient` and `SqliteMigrator` for `cairn.db`, on `node:sqlite` (see `spec.sessions.trace-store`)      |
| `mdast-util-from-markdown`, `mdast-util-gfm`, `micromark-extension-gfm`  | 2.1.0, 3.1.0, 3.0.0 | MIT        | Markdown to nodes for the viewer                                                                            |
| `@foldkit/ui`                                                            | 0.171.0             | MIT        | The switch and the disclosure in the viewer's design system; pinned with `foldkit`                          |

Built into Node 24, so no package: `path.matchesGlob` for gate patterns, and `node:sqlite`, which `@effect/sql-sqlite-node` runs on. Diffs come from `git`, so the CLI needs no diff library.

Considered and left out:

- `@pierre/words` renders markdown to HTML strings through WebAssembly and is built for streaming model output. It drops raw HTML and checks URLs, but its output is still a string, so the viewer would need `innerHTML` for the whole document, and its hooks take and return HTML strings, so the `{#id}` headings, their `data-section` attributes and the title buttons that send Messages would have to be rebuilt from strings. Its Mermaid plugin needs `pele` anyway, and its code plugin needs `@pierre/highlights`; the viewer uses both directly. It may suit streaming session logs later.
- `mermaid` for diagrams: 123 MB unpacked with d3, cytoscape and elkjs behind it, and an asynchronous render that needs a DOM. `pele` draws the same syntax (Mermaid 12.1.0) synchronously from one dependency-free package, and escapes the diagram text itself.
- Shiki, through `@pierre/diffs`, for code blocks: it loads grammars asynchronously, so a block would need a Model field and Messages to arrive after the first render. `@pierre/highlights` returns tokens synchronously, and the view turns them into spans with no `innerHTML`. It is in beta, so its version is pinned exactly. Diffs use it too: `@pierre/diffs` takes `preferredHighlighter: "highlights"`, so one set of lexers colours both fences and diffs and Shiki is never loaded.
- A SQLite driver such as `better-sqlite3`: `@effect/sql-sqlite-node` runs on `node:sqlite`, which needs no native build.
- An ORM such as Drizzle or Prisma. One table needs no query builder, and an ORM would declare row types a second time beside Effect Schema. Effect SQL decodes rows through Schema, and the same `SqlClient` runs on a Durable Object (`@effect/sql-sqlite-do`) or D1 (`@effect/sql-d1`) if v2 needs it.
- Rete, JointJS, Cytoscape, Drawflow and LiteGraph. Each owns its scene and graph state, which would put state in two places beside the Foldkit model.
- `elkjs` for layout: EPL-2.0 or GPL-3.0 and 8 MB. `@dagrejs/dagre` (MIT) is the choice when layout stops being fixed.
- The AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/typesafe-ai`). It would add a second schema language and a Promise API beside Effect, and `effect/ai` already covers both language and decision models with Effect Schema.
- Cloudflare AI Gateway as a dependency. It is a proxy, not a library; `baseUrl` in config lets a user route through it (see `spec.models`).
- Workers AI. Cairn runs on the user's machine, not in a Worker.
- A Google provider package. `@effect/ai-google` has no 4.1.5 release, and Google's models answer the OpenAI API, so `openai-compatible` with a `baseUrl` reaches them.
- The Claude Agent SDK for the `cli` source. It would run an agent loop inside Cairn; the planner needs one prompt in and one answer out, which `claude -p` gives with the person's own sign-in.

## Contract {#spec.contract}

- Implements: `prd.contract-package`
- Files: `packages/contract/src/`, `packages/contract/schema/`

Everything a file in `.cairn/` holds is decoded through a schema here. A decode failure is a typed error that names the file, the line where there is one, and the field path.

### Section IDs {#spec.contract.section-ids}

- Implements: `prd.section-ids`
- Files: `packages/contract/src/ids.ts`

`SectionId` exists. Add `PrdSectionId` and `SpecSectionId`, which also check the prefix.

`SectionId`, `TaskId` and the two prefixed IDs live in `ids.ts`, and `index.ts` re-exports them. Contract modules import IDs from `ids.ts`, never from `index.ts`, which re-exports them and would make a cycle. `TaskId` matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`, so it survives a `Cairn-Task` trailer.

### Manifest {#spec.contract.manifest}

- Implements: `prd.manifest-schema`
- Files: `packages/contract/src/manifest.ts`

```ts
Manifest = {
  version: 1
  feature: Slug
  baseBranch: string
  tasks: NonEmptyArray<ManifestTask>
}

ManifestTask = {
  id: TaskId // t1, t2, ... in dependency order (see spec.planning.stack-order)
  title: NonEmptyString
  prdSections: NonEmptyArray<PrdSectionId>
  specSections: NonEmptyArray<SpecSectionId>
  files: Array<string> // new: the declared files plan-time detection runs on
  branch: string // <feature>/<NN>-<slug>
  parent: TaskId | null // see spec.planning.stack-order
  dependsOn: Array<TaskId> // new: the tasks this one needs
  worktree: string | null // new: where it is built; null is the repo's own checkout
  model: NonEmptyString
  reasoning: "low" | "medium" | "high" | "xhigh" | "max"
  humanGate: { required: boolean; reasons: Array<GateReason> }
  status: TaskStatus
  commits: Array<Sha>
  sessions: Array<SessionId>
}

GateReason = "tag:human" | `path:${string}`
TaskStatus = "pending" | "running" | "blocked_on_human" | "failed" | "done" | "landed"
```

`TaskStatus` gains `failed`. The existing `Task` schema, with one `section` and a `gated` flag, is replaced by `ManifestTask`; the machine and the viewer move to it.

`status`, `commits` and `sessions` are a snapshot. Cairn writes them; nothing reads them to decide anything. Derived status (see `spec.status.derivation`) is the truth. Only Cairn writes `manifest.json`.

### Events {#spec.contract.events}

- Implements: `prd.orchestrator-contract`
- Files: `packages/contract/src/events.ts`

One JSON object per line of `events.jsonl`:

```ts
Event = {
  v?: 1 // missing means 1
  ts: string // ISO 8601, decoded to a DateTime.Utc
  taskId: TaskId
  status: TaskStatus
  detail?: string
  actor?: "orchestrator" | `human:${string}` | `agent:${string}` // missing means orchestrator
  model?: string // on a running event: the model the task was started with
  reasoning?: Reasoning // on a running event: the reasoning level it was started with
}
```

`actor` is new. Approvals need it: only a `human:` actor can move a task out of `blocked_on_human`.

`model` and `reasoning` are new and optional, with the manifest's types. The orchestrator sets both on a `running` event to what it started the task with, which is not always what the plan chose: a retry or a human can change it. An event without them still decodes, and on any other status they are ignored. The viewer reads them to show what ran (see `spec.viewer.models`).

### Trailers {#spec.contract.trailers}

- Implements: `prd.orchestrator-contract`
- Files: `packages/contract/src/trailers.ts`

```text
Cairn-Task: t1
Cairn-Section: spec.contract.manifest
Cairn-Section: spec.contract.events
Cairn-Session: s_8f2k1q
```

One `Cairn-Task` and one `Cairn-Session`. `Cairn-Section` repeats, once per spec section, since a task can have several. `SessionId` matches `^s_[a-z0-9]{6,}$`.

### Trace {#spec.contract.trace}

- Implements: `prd.viewer`, `prd.contract-package`
- Files: `packages/contract/src/trace.ts`
- Depends on: `spec.contract.manifest`, `spec.contract.events`, `spec.contract.trailers`

`Trace` is what the server sends and the viewer draws. `cairn status --json` prints it, and the demo loads one from a file.

```ts
Trace = {
  version: 1
  feature: Slug
  baseBranch: string
  prd: TraceDocument
  spec: TraceDocument
  tasks: Array<TraceTask> // manifest order
  sections: Array<{ id: SectionId; status: SectionStatus }> // every PRD and spec section
  warnings: Array<TraceWarning>
  judgments: Array<Judgment & { stale: boolean }> // empty until the judging work fills it (see spec.server)
}

TraceDocument = {
  path: string // ".cairn/prd.md" or ".cairn/spec.md"
  markdown: string // the whole file, rendered by the viewer
  sections: Array<TraceSection>
}

TraceSection = {
  id: SectionId
  title: string // without the {#id}
  level: number
  line: number
  parent: SectionId | null
  human: boolean
  summary: string | null // one sentence from spec.json; null in the PRD and for a section the index does not hold
  keys: {
    // own keys plus inherited ones; all empty in the PRD
    implements: Array<PrdSectionId>
    files: Array<string>
    dependsOn: Array<SpecSectionId>
    defers: Array<PrdSectionId>
    context: Array<PrdSectionId>
  }
}

TraceTask = Omit<ManifestTask, "status" | "commits"> & {
  status: TaskStatus // derived, not the manifest snapshot
  waiting: boolean // pending, with a blocked_on_human task below it
  gate: { required: boolean; reasons: Array<GateReason> } // effective: plan time plus the files its commits changed
  commits: Array<TraceCommit>
  events: Array<Event> // sorted as derivation sorts them
}

TraceCommit = {
  sha: Sha
  parents: Array<Sha>
  subject: string
  files: Array<string>
  sections: Array<SpecSectionId> // from Cairn-Section trailers
  session: SessionId | null // from Cairn-Session
}

TraceWarning = {
  kind: "illegal-transition" | "non-human-approval" | "unknown-task" | "missing-trailers" | "landed-without-approval" | "missing-session"
  message: string
  taskId: TaskId | null
  sha: Sha | null
}
```

`summary` is new. It is the section's `summary` in `spec.json` (see `spec.contract.spec-index`), carried in the trace so the viewer reads one thing. A trace written without it decodes with `null`. The spec cards show it (see `spec.viewer.spec-cards`).

`TraceSection` is declared here rather than imported from core's `Section`, so the viewer depends only on the contract. The trace carries no positions: the viewer lays everything out itself (see `spec.viewer.model-and-messages`).

The viewer is built against this schema and the demo trace, so it does not wait for the CLI or the server. The demo trace has to decode through `Trace`; a test checks it.

### Session {#spec.contract.session}

- Implements: `prd.code-view`
- Files: `packages/contract/src/session.ts`
- Depends on: `spec.contract.trailers`

`Session` is what `GET /api/sessions/:id` sends and the session pane draws. `cairn.db` keeps the redacted log as the agent wrote it; `Session` is how Cairn reads it (see `spec.sessions.reading`), so a better reader later needs no migration.

```ts
Session = {
  version: 1
  id: SessionId
  taskId: TaskId
  format: "claude-code" | "unknown"
  turns: Array<Turn> // log order
  skipped: number // lines of a read type that did not decode
  redactions: Record<string, number> // count per kind
  notes: Array<SessionNote>
}

Turn = PromptTurn | ReplyTurn | ToolTurn

PromptTurn = { kind: "prompt"; id: string; at: DateTime.Utc; text: string } // id: the log line's uuid
ReplyTurn = { kind: "reply"; id: string; at: DateTime.Utc; text: string }

ToolTurn = {
  kind: "tool"
  id: string // the tool call's id, which its result repeats
  at: DateTime.Utc
  name: string // "Edit", "Write", "Bash", ...
  target: string | null // the file path or command, for the one-line summary
  input: string // the call's input as JSON text
  output: string // the result's text; empty when no result arrived
  failed: boolean
  edits: Array<FileEdit>
}

FileEdit = {
  path: string // relative to the checkout the agent ran in
  added: Array<string> // lines the edit wrote, without the "+"
  removed: Array<string> // lines it removed, without the "-"
}

SessionNote = { kind: "note" | "review" | "annotation"; author: string; body: string; at: DateTime.Utc }
```

Turn IDs are unique within a session; the schema refuses a duplicate.

### Config {#spec.contract.config}

- Implements: `prd.human-gates`
- Files: `packages/contract/src/config.ts`

```ts
Config = {
  version: 1
  humanPaths: Array<string> // defaults to the PRD's list
  redact: { deny: Array<string> } // defaults to []
  planner: {
    source: "cli" | "api" // defaults to "cli"
    cli: "claude" | "codex" // defaults to "claude"; read when source is "cli"
    provider: "anthropic" | "openai" | "openrouter" | "openai-compatible" // defaults to "anthropic"; read when source is "api"
    model: string | undefined // undefined leaves the choice to the CLI; required when source is "api"
    small: string | undefined // the model for index and the two splits; defaults to model
    keyEnv: string | undefined // the environment variable holding the key; defaults per provider
    baseUrl: string | undefined // e.g. a Cloudflare AI Gateway URL; required for "openai-compatible"
  }
  judge: {
    model: string // defaults to "jev-1.14.0"
    baseUrl: string | undefined
    pass: number // defaults to 0.8
    flag: number // defaults to 0.5
    minConfidence: number // defaults to 0.5
    maxRounds: number // defaults to 2
    models: Record<string, string> // name the manifest uses, and when to use it
  }
}
```

A missing `.cairn/config.json` decodes to the defaults. A config whose `planner.source` is `api` with no `planner.model`, or whose provider is `openai-compatible` with no `planner.baseUrl`, fails to decode with a message naming the field. `judge.pass` must be greater than `judge.flag`, and all three thresholds lie in `[0, 1]`. `judge.models` defaults to:

| Name     | When to use it                                                                     |
| -------- | ---------------------------------------------------------------------------------- |
| `haiku`  | Mechanical changes: a schema field, a rename, a command wired to existing code     |
| `sonnet` | Most tasks: a feature or service with its tests across a few files                 |
| `opus`   | Logic where a subtle bug costs a lot: derivation, ordering, redaction, concurrency |

### Judgments {#spec.contract.judgments}

- Implements: `prd.judging-the-plan`
- Files: `packages/contract/src/judgments.ts`

```ts
Judgments = {
  version: 1
  model: string // the decision model that answered, e.g. "jev-1.14.0"
  judgments: Array<Judgment>
}

Judgment = {
  target:
    | { kind: "section"; id: SpecSectionId }
    | { kind: "task"; id: TaskId }
    | { kind: "draft"; title: string } // a draft that was split, so never got a TaskId
    | { kind: "stack" }
  question: "size" | "faithful" | "buildable" | "matches" | "model" | "reasoning" | "complete" | "ordered" | "oneFeature"
  verdict: "pass" | "flag" | "unsure"
  action: "none" | "split" | "routed" // what planning did because of it
  round: number // 1 for the first ask; a split's replacements are judged in round 2
  answer: RateAnswer | ProbabilityAnswer | Unanswered
  message: string
  inputHash: Sha256Hex
  at: DateTimeUtc
}

RateAnswer = { label: string; probabilities: Record<string, number>; confidence: number | undefined }
ProbabilityAnswer = { probability: number }
Unanswered = { unanswered: "Refused" | "Missing" | "Invalid"; description: string }
```

The answer shapes mirror `effect/ai`'s `RateAnswer`, `ProbabilityAnswer` and `Unanswered`; a `classify` answer uses `RateAnswer`'s shape. Judgments on drafts that became tasks are keyed by the task's ID once `stackOf` assigns it. Only Cairn writes `judgments.json`. A missing file decodes to no judgments.

### Spec index {#spec.contract.spec-index}

- Implements: `prd.repo-layout`
- Files: `packages/contract/src/spec-index.ts`, `packages/cli/src/spec-index.ts`
- Depends on: `spec.sections.parsing`, `spec.planning.planner-service`

`spec.json` is a structured copy of `spec.md`, so the planner, the judge and other tools read the spec without parsing markdown.

```ts
SpecIndex = {
  version: 1
  source: string // ".cairn/spec.md"
  prd: string
  manifest: string
  sections: Array<IndexedSection> // in document order
}

IndexedSection = {
  // derived by code from spec.md and manifest.json
  id: SpecSectionId
  title: string
  level: number
  line: number
  parent: SpecSectionId | null
  children: Array<SpecSectionId>
  human: boolean
  implements: Array<PrdSectionId> // own keys only, not inherited
  files: Array<string>
  dependsOn: Array<SpecSectionId>
  defers: Array<PrdSectionId>
  context: Array<PrdSectionId>
  tasks: Array<TaskId> // tasks whose specSections name this section
  // recorded when the section is written or first indexed
  writtenFrom: {
    body: string | null // hash of the section's body as the planner wrote it; null for a section a person wrote
    prd: Record<PrdSectionId, string> // hash of each PRD section it implements, as it was then
  }
  // extracted from the section's prose by Planner.index
  summary: string
  requirements: Array<{ id: `${SpecSectionId}#r${number}`; level: "must" | "must-not" | "should" | "may"; text: string }>
  artifacts: Array<Artifact> // { id, kind, name, location, description, ...kind-specific fields }
  tests: Array<{ id: `${SpecSectionId}#t${number}`; kind: "check" | "example" | "property" | "scene" | "integration" | "mutation"; text: string }>
  decisions: Array<{ id: `${SpecSectionId}#d${number}`; text: string; why: string | null }> // null when the spec gives no reason
}
```

`cairn plan` writes `spec.json` whenever it writes `spec.md` or `manifest.json`. Code fills the derived fields. `Planner.index` fills the rest, one call per section whose body changed; a section whose body is unchanged keeps its entry.

`writtenFrom` is what planning again reads (see `spec.planning.again`). A hash is the SHA-256 of the section's body with trailing whitespace removed from each line, in hex. A section's body hash differing from `writtenFrom.body` means a person edited it. `writtenFrom` is set once, when the section is written or first indexed, and only a rewrite of that section replaces it.

Until the CLI exists, `spec.json` is written by hand in this format, and the lint rule `index-drift` is what keeps it honest.

### JavaScript entry {#spec.contract.javascript-entry}

- Implements: `prd.contract-package`
- Files: `packages/contract/src/js.ts`, `packages/contract/package.json`

`@cairn/contract/js` exports functions that need no Effect:

- `parseManifest(input)`, `parseEvent(line)`, `parseConfig(input)` return the decoded value or throw a `CairnContractError` with `path` (the field path) and a message.
- `formatTrailers({ taskId, sections, sessionId })` returns the trailer block. `trailerArgs(...)` returns the same as `--trailer` arguments for `git commit`.
- `appendEvent(path, event)` validates the event and appends it in a single `O_APPEND` write, so concurrent writers never interleave lines.
- `cairnDir(cwd)` returns the main checkout's `.cairn/` the same way the CLI finds it, so an orchestrator working in a worktree appends to the shared `events.jsonl`.
- `migrateManifest(input)` upgrades older versions. Version 1 is the only one, so for now it checks the version and returns the input.

The package ships `.d.ts` files and `schema/{manifest,event,config}.schema.json`, generated with `Schema.toJsonSchemaDocument`. A test regenerates them and fails if the committed files differ, so `pnpm check` catches drift.

## Sections {#spec.sections}

### Parsing {#spec.sections.parsing}

- Implements: `prd.section-ids`
- Files: `packages/core/src/section-ids.ts`, `packages/core/src/sections.ts`

`sectionsOf(markdown)` returns every heading outside a fence:

```ts
Section = {
  id: SectionId | undefined
  level: number
  title: string // without the {#id}
  line: number // 1-based, for lint output
  parent: SectionId | undefined
  body: string // up to the next heading of any level
  human: boolean // its body or an ancestor's body has <!-- human -->
  keys: { implements; files; dependsOn; defers; context } // own keys plus inherited ones
}
```

It reuses the fence and heading rules `assignSectionIds` already has, so both agree on what counts as a heading.

### `cairn ids` {#spec.sections.cairn-ids}

- Implements: `prd.cli`, `prd.section-ids`
- Files: `packages/cli/src/commands/ids.ts`
- Depends on: `spec.sections.parsing`

Runs `assignSectionIds` on `prd.md` with `prd` and on `spec.md` with `spec`. Writes a file only when IDs were added, and prints each added ID. `--check` writes nothing and exits 1 if any heading lacks an ID.

## Gates {#spec.gates}

### Path matching {#spec.gates.path-matching}

- Implements: `prd.human-gates`
- Files: `packages/core/src/gates.ts`

Patterns use `path.matchesGlob` from Node, with one gitignore rule added: a pattern without a `/` matches the file name in any directory. Without it, `*.sql` would miss `db/001.sql`. A declared path ending in `/` is a directory and matches when a file inside it would.

Outstanding correction: task `t18` is recorded as `failed`, with its existing commits retained, because the current matcher probes only a file named `x` inside a declared directory. It therefore misses patterns such as `*.sql` for `db/`, and `**/migrations/**` for `db/`, even though files beneath that directory can match. Directory matching and its tests must cover those cases. Post-commit detection against actual file paths does not replace the plan-time requirement.

### Detection {#spec.gates.detection}

- Implements: `prd.human-gates`
- Files: `packages/core/src/gates.ts`
- Depends on: `spec.gates.path-matching`, `spec.sections.parsing`, `spec.contract.manifest`

`gateOf(task, sections, config, changedFiles)` returns `{ required, reasons }`:

- `tag:human` if any linked PRD or spec section has `human: true`.
- `path:<pattern>` for each pattern that matches a file in `task.files` (plan time) or in `changedFiles` (after commits).

The plan stores the plan-time result in `humanGate`. Status derivation recomputes it with the files the task's commits actually changed, so a hit after commit gates a task the plan did not.

## Models {#spec.models}

- Implements: `prd.implementation-in-effect`, `prd.judging-the-plan`, `prd.planning.writers`
- Files: `packages/cli/src/models.ts`, `packages/cli/src/cli-model.ts`
- Depends on: `spec.contract.config`

Cairn uses two kinds of model, each behind an `effect/ai` service. `models.ts` builds both Layers from config, and the CLI composition root provides them.

| Service         | Does                                       | Live layer                                                        | Used by   |
| --------------- | ------------------------------------------ | ----------------------------------------------------------------- | --------- |
| `LanguageModel` | Writes text and schema-decoded objects     | One of the planner sources below, chosen by `planner.source`      | `Planner` |
| `DecisionModel` | Answers typed questions with probabilities | `@effect/ai-typesafe`, `TypeSafeDecisionModel.model(judge.model)` | `Judge`   |

The `cli` source, the default. `cli-model.ts` is a `LanguageModel` that runs the person's agent CLI once per call and reads its answer, so planning uses that CLI's sign-in and Cairn reads no key.

Current support: the Claude CLI source, the Codex CLI source and the Anthropic API layer are implemented. Codex runs with the person's `~/.codex/config.toml` and execpolicy rules ignored and every tool, app, plugin and hook switched off, each flag checked against a real `codex-cli 0.172.0` run (`cli-model.ts` lists them and what a run showed). The other API providers are pending in `t106`.

| `planner.cli` | Command                                                      | Structured output                             |
| ------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `claude`      | `claude -p --tools "" --output-format json`, prompt on stdin | `--json-schema` with the call's JSON Schema   |
| `codex`       | `codex exec`, prompt on stdin                                | The schema flag `codex exec --help` documents |

- `--model` is passed only when `planner.model` or `planner.small` is set.
- The CLI runs with no tools, in a temporary directory, so it cannot read or change the repository. Everything it needs is in the prompt.
- The command runs through `ChildProcess` from `effect/unstable/process`. A non-zero exit, or output that is not the expected JSON, is a `PlannerError` carrying the CLI's stderr.
- Read `claude --help` and `codex exec --help` on the machine before writing the flags; both CLIs change often. A flag the installed CLI does not have fails with a message naming the CLI's version.
- A binary that is not on `PATH` fails before any file changes: `claude was not found. Install Claude Code, or set planner.cli or planner.source in .cairn/config.json.`

The `api` source. `planner.provider` picks the layer:

| Provider            | Layer                                 | Key, unless `planner.keyEnv` names another |
| ------------------- | ------------------------------------- | ------------------------------------------ |
| `anthropic`         | `@effect/ai-anthropic`                | `ANTHROPIC_API_KEY`                        |
| `openai`            | `@effect/ai-openai`                   | `OPENAI_API_KEY`                           |
| `openrouter`        | `@effect/ai-openrouter`               | `OPENROUTER_API_KEY`                       |
| `openai-compatible` | `@effect/ai-openai-compat`, `baseUrl` | `OPENAI_COMPATIBLE_API_KEY`, or none       |

- `openai-compatible` is how Google's models and open-weight models are reached, hosted or on the person's machine. A local endpoint needs no key, so a missing key is not an error for this provider.
- Read each package's `index.d.ts` for its layer and client constructors before writing `models.ts`.

Both sources:

- `languageModelFor(call)` gives the `Planner` its model per call: `planner.small` for `index`, `splitSection` and `splitTask` when it is set, and `planner.model` otherwise.
- Keys are read with `Config.Redacted`, never written and never logged. The `Redactor` adds the value of every key Cairn reads to its secret set, so a key in the shell environment is stripped from session logs like one in `.env`.
- Layers are built only when a command needs them. A command that calls no model never reads a key or looks for a CLI. `cairn plan` with `source: "api"` and no key for its provider fails before it changes any file.
- `planner.baseUrl` and `judge.baseUrl` become each client's `apiUrl`. Setting them routes calls through a proxy, such as Cloudflare AI Gateway for logs, caching and spend. Cairn ships no gateway and needs no Cloudflare account.
- The Jev model is pinned (`jev-1.14.0`, not `jev-latest`) so the same input gets the same model, and `judgments.json` records it.
- No test reads a key, touches the network or runs a real CLI. `Planner` and `Judge` tests provide scripted Layers. `cli-model.ts` is tested against a stub executable on a temporary `PATH` that prints a recorded answer: it gets the prompt on stdin and the schema flag, a non-zero exit becomes a `PlannerError` with its stderr, and a missing binary gives the message above.

## Planning {#spec.planning}

### Planner service {#spec.planning.planner-service}

- Implements: `prd.cli`, `prd.planning.diagrams`
- Files: `packages/cli/src/planner.ts`, `packages/cli/prompts/`
- Depends on: `spec.models`

Six calls, each with a prompt file in `packages/cli/prompts/`:

- `spec(prd)` returns spec markdown. The prompt includes this file as its worked example.
- `sections(prd, spec, prdSections)` returns markdown for new spec sections that implement the given PRD sections, written to sit in the spec it is given: it reuses that spec's names and files, and each section says which existing section it goes under.
- `tasks(prd, spec, specSections, existing)` returns `TaskDraft[]` for the given spec sections: title, PRD and spec sections, files, what it depends on, model and reasoning. A draft depends on other drafts or on tasks in `existing`, by ID. On a first plan `specSections` is every section and `existing` is empty. Model and reasoning are proposals; routing (see `spec.judging.checkpoints`) can replace them.
- `splitSection(section, reason)` returns markdown for two or more sections that replace it, under the same parent and with the same `Implements`.
- `splitTask(draft, spec, reason)` returns two or more `TaskDraft`s that together cover the draft's spec sections and files.
- `index(section)` returns the prose fields of an `IndexedSection` (see `spec.contract.spec-index`).

`reason` is the judgment that asked for the split, so the prompt says what was wrong. Every structured output is decoded through its schema. A failed decode retries once with the error in the prompt, then fails with a `PlannerError`.

Diagrams. The `spec` and `sections` prompts say when to draw a Mermaid diagram: for a machine's states and events, for messages between two processes, and for data that passes through three or more steps, and not for anything a list already says. Each Mermaid block in the returned markdown goes through `drawsOf` (see `spec.lint`). A block that does not draw is sent back once with the error, as a failed decode is; if it still does not draw, the block is removed and the plan output warns, naming the section.

The model never decides gates, IDs, branch names, order or the stack diagram. Those are deterministic and tested.

The live layer uses the `LanguageModel` from `spec.models`, whichever source config names. The test layer replays fixtures: this `spec.md`, the drafts behind this repo's `manifest.json`, this repo's `spec.json`, the sections and drafts of one later addition to the plan, and scripted splits.

### Stack order {#spec.planning.stack-order}

- Implements: `prd.human-gates`, `prd.cli`, `prd.manifest-schema`
- Files: `packages/core/src/stack.ts`
- Depends on: `spec.gates.detection`

`stackOf(feature, drafts, gates, existing)` returns the tasks as a set of stacks. `existing` is the tasks already in the manifest, empty on a first plan. They are returned as they are and placed first; the steps below order the drafts after them, with IDs continuing from the highest existing one, and a draft's parent, dependencies and worktree may be existing tasks.

1. Topologically sort by dependency. Among tasks whose dependencies are placed, take gated ones first, then planner order. IDs are `t1`… in that order. Branches are `<feature>/<NN>-<slug>`.
2. `dependsOn` is the draft's dependencies, as task IDs.
3. `parentOf` sets the parent. A task with no dependencies starts a stack on `baseBranch`: `parent` is `null`. A task whose dependencies all lie on one chain takes the latest of them as its parent. A task whose dependencies lie on different stacks has `parent: null` and starts from `baseBranch` once every dependency has landed.
4. A cycle fails with a `PlannerError` naming the tasks in it.
5. `worktreesOf` gives each task a `worktree`. Walking tasks in ID order, a task takes the worktree of its parent, or else of one of its dependencies, when that worktree's latest task is one it depends on and no other task has taken it next. Otherwise it gets a new one. The first worktree is the repo's own checkout (`null`); the rest are `wt-1`, `wt-2`, ….

Tasks that share a worktree always run one after another, so a chain is built in one checkout. Tasks that can run at the same time never share one.

Every ancestor of a task is something it depends on. So a gated task has nothing below it but its own dependencies, and tasks on different stacks can be built at the same time.

This repo's stacks, drawn from [manifest.json](manifest.json). Each box is a stack built bottom to top, and stacks run in parallel. A solid arrow is a parent branch; a dashed arrow means the task starts from `main` once that dependency has landed. The last line of each task is its worktree. Purple is opus, blue is sonnet, yellow is haiku; a red border and GATE mark a human gate. Stacks are numbered in the order of their first task and named for the second part of that task's first spec section. The viewer draws the same stacks by the same rules (see `spec.viewer.stacks`), and a test fails when this diagram and the manifest disagree, so redraw it when the manifest changes.

```mermaid
flowchart BT
  main(["main"])
  subgraph s1["Stack 1 · sessions"]
    direction BT
    t1["t1 · 01-redact · GATE<br/>Redact secrets from session logs<br/>main checkout"]
    t3["t3 · 03-redactor-service · GATE<br/>Add the Redactor service<br/>main checkout"]
  end
  subgraph s2["Stack 2 · sessions"]
    direction BT
    t2["t2 · 02-trace-store · GATE<br/>Add the trace store and its first migration<br/>wt-1"]
  end
  subgraph s3["Stack 3 · status"]
    direction BT
    t5["t5 · 05-failed-status<br/>Add the failed status to the task machine<br/>wt-3"]
  end
  subgraph s4["Stack 4 · contract"]
    direction BT
    t7["t7 · 07-decode-error<br/>Add a decode error that names the file, line and field path<br/>wt-5"]
  end
  subgraph s5["Stack 5 · contract"]
    direction BT
    t8["t8 · 08-event-schema<br/>Add the event schema with an actor<br/>wt-6"]
    t82["t82 · 82-event-model<br/>Record the model and reasoning a task ran with on its running event<br/>wt-27"]
    t83["t83 · 83-trace-summary<br/>Carry each spec section's summary in the Trace<br/>wt-27"]
  end
  subgraph s6["Stack 6 · contract"]
    direction BT
    t9["t9 · 09-trailer-schema<br/>Add the trailer and commit schemas<br/>wt-7"]
    t6["t6 · 06-manifest-schema<br/>Add the manifest schema<br/>wt-7"]
    t76["t76 · 76-session-schema<br/>Add the Session schema<br/>wt-22"]
    t77["t77 · 77-session-reader<br/>Read Claude Code session logs into a Session<br/>wt-22"]
  end
  subgraph s7["Stack 7 · contract"]
    direction BT
    t10["t10 · 10-trace-schema<br/>Add the Trace schema<br/>wt-7"]
    t13["t13 · 13-viewer-manifest-task<br/>Move the viewer to ManifestTask<br/>wt-7"]
    t43["t43 · 43-chain-of<br/>Add chainOf for linked sections and tasks<br/>wt-7"]
    t44["t44 · 44-demo-trace<br/>Add a demo trace built from this repo<br/>wt-14"]
  end
  subgraph s8["Stack 8 · contract"]
    direction BT
    t11["t11 · 11-config-schema<br/>Add the config schema with defaults<br/>wt-8"]
    t28["t28 · 28-planner-service<br/>Add the Planner service with a fixture layer<br/>wt-8"]
    t29["t29 · 29-planner-live<br/>Add the planner's CLI source and its prompts<br/>wt-8"]
    t57["t57 · 57-decision-model<br/>Add the Jev decision model layer<br/>wt-17"]
    t61["t61 · 61-planner-split<br/>Add the split and index planner calls<br/>wt-17"]
    t55["t55 · 55-judgment-schema<br/>Add the judgments file schema and the judge config<br/>wt-15"]
    t106["t106 · 106-planner-providers<br/>Add the API providers for the planner<br/>wt-32"]
  end
  subgraph s9["Stack 9 · status"]
    direction BT
    t12["t12 · 12-machine-manifest-task<br/>Move the task machine to ManifestTask and an effective gate, and remove Task<br/>wt-4"]
  end
  subgraph s10["Stack 10 · contract"]
    direction BT
    t14["t14 · 14-js-parse<br/>Add the plain JS entry with parse functions and cairnDir<br/>wt-9"]
    t15["t15 · 15-js-append-event<br/>Add trailerArgs and appendEvent to the JS entry<br/>wt-9"]
    t16["t16 · 16-json-schema<br/>Generate the contract JSON Schema and declaration files<br/>wt-9"]
  end
  subgraph s11["Stack 11 · sections"]
    direction BT
    t17["t17 · 17-sections-of<br/>Parse markdown into sections with keys and human tags<br/>wt-10"]
    t24["t24 · 24-cairn-ids<br/>Add cairn ids<br/>wt-10"]
  end
  subgraph s12["Stack 12 · gates"]
    direction BT
    t18["t18 · 18-gate-path-matching<br/>Match gate patterns against declared paths<br/>wt-11"]
  end
  subgraph s13["Stack 13 · gates"]
    direction BT
    t19["t19 · 19-gate-detection<br/>Detect human gates from tags and paths<br/>wt-11"]
    t20["t20 · 20-stack-order<br/>Order drafts into stacks by dependency<br/>wt-11"]
    t25["t25 · 25-lint-sections<br/>Lint section IDs and PRD coverage<br/>wt-11"]
    t26["t26 · 26-lint-stack<br/>Lint parents, dependencies and gates<br/>wt-11"]
    t27["t27 · 27-cairn-lint<br/>Add cairn lint<br/>wt-11"]
    t66["t66 · 66-index-drift<br/>Lint spec.json for drift<br/>wt-11"]
    t111["t111 · 111-stack-existing<br/>Order new drafts after the tasks a manifest already has<br/>wt-35"]
  end
  subgraph s14["Stack 14 · status"]
    direction BT
    t21["t21 · 21-git-service<br/>Add the Git service with live and in-memory layers<br/>wt-4"]
  end
  subgraph s15["Stack 15 · cli"]
    direction BT
    t22["t22 · 22-cli-init<br/>Add the cairn binary and cairn init<br/>wt-12"]
    t23["t23 · 23-workspace-loader<br/>Load the .cairn files through the contract schemas<br/>wt-12"]
  end
  subgraph s16["Stack 16 · planning"]
    direction BT
    t30["t30 · 30-cairn-plan<br/>Add cairn plan<br/>wt-8"]
  end
  subgraph s17["Stack 17 · status"]
    direction BT
    t31["t31 · 31-derive-events<br/>Derive task status from events<br/>wt-6"]
    t32["t32 · 32-derive-commits<br/>Derive effective gates and landing from commits<br/>wt-6"]
    t33["t33 · 33-section-rollup<br/>Roll task status up to sections<br/>wt-6"]
  end
  subgraph s18["Stack 18 · server"]
    direction BT
    t34["t34 · 34-trace-schema<br/>Build the Trace from derived state<br/>wt-4"]
  end
  subgraph s19["Stack 19 · status"]
    direction BT
    t35["t35 · 35-cairn-status<br/>Add cairn status<br/>wt-8"]
    t36["t36 · 36-cairn-approve<br/>Add cairn approve<br/>wt-8"]
  end
  subgraph s20["Stack 20 · sessions"]
    direction BT
    t37["t37 · 37-cairn-session<br/>Add cairn session put<br/>main checkout"]
  end
  subgraph s21["Stack 21 · orchestrator-adapter"]
    direction BT
    t38["t38 · 38-orchestrator-contract-test<br/>Test the orchestrator contract end to end<br/>main checkout"]
  end
  subgraph s22["Stack 22 · server"]
    direction BT
    t39["t39 · 39-api-trace<br/>Serve the trace at /api/trace with an ETag<br/>wt-8"]
    t40["t40 · 40-api-sessions-commits<br/>Serve sessions and commit patches<br/>wt-8"]
    t41["t41 · 41-cairn-serve<br/>Add cairn serve with the built viewer<br/>wt-8"]
  end
  subgraph s23["Stack 23 · viewer"]
    direction BT
    t42["t42 · 42-markdown-rendering<br/>Render markdown to Foldkit nodes<br/>wt-13"]
  end
  subgraph s24["Stack 24 · viewer"]
    direction BT
    t45["t45 · 45-viewer-columns<br/>Show the trace as PRD, spec and stack columns, with the stack layout<br/>wt-14"]
    t46["t46 · 46-trace-polling<br/>Load the demo trace through a command<br/>wt-14"]
    t47["t47 · 47-chain-highlight<br/>Highlight the chain on hover and select it on click<br/>wt-14"]
    t48["t48 · 48-curves-of<br/>Compute bezier curves between linked nodes<br/>wt-14"]
    t49["t49 · 49-curves-overlay<br/>Measure node positions and draw the curves<br/>wt-14"]
    t50["t50 · 50-canvas-pan-zoom<br/>Pan and zoom the canvas with XYPanZoom<br/>wt-14"]
    t51["t51 · 51-canvas-presence<br/>Keep presence cursors in canvas coordinates<br/>wt-14"]
    t52["t52 · 52-detail-drawer<br/>Open the detail drawer from sections and tasks<br/>wt-14"]
    t69["t69 · 69-stacks-of<br/>Group the tasks into stacks and levels<br/>wt-19"]
    t70["t70 · 70-stack-boxes<br/>Draw the stacks as boxes over the base branch<br/>wt-19"]
    t71["t71 · 71-fuzzy-matching<br/>Index and rank fuzzy matches for titles, IDs and branches<br/>wt-20"]
    t72["t72 · 72-search-interaction<br/>Add search navigation and temporary chain highlighting<br/>wt-20"]
    t73["t73 · 73-prose-search<br/>Search markdown prose with snippets and inline match highlights<br/>wt-20"]
    t75["t75 · 75-code-screen<br/>Open the code view with the stack tree<br/>wt-21"]
    t53["t53 · 53-diff-parse<br/>Fetch and parse task and commit patches with @pierre/diffs<br/>wt-21"]
    t54["t54 · 54-diff-render<br/>Render task and commit diffs with syntax highlighting in the code view<br/>wt-21"]
    t67["t67 · 67-judgment-markers<br/>Show judgments in the trace and the viewer<br/>wt-21"]
    t81["t81 · 81-demo-patches · GATE<br/>Ship the demo's commit patches as static files<br/>wt-26"]
  end
  subgraph s25["Stack 25 · contract"]
    direction BT
    t56["t56 · 56-spec-index-schema<br/>Add the spec index schema<br/>wt-16"]
  end
  subgraph s26["Stack 26 · judging"]
    direction BT
    t58["t58 · 58-judging-questions<br/>Define the judging questions and their inputs<br/>wt-18"]
  end
  subgraph s27["Stack 27 · judging"]
    direction BT
    t59["t59 · 59-verdicts<br/>Turn answers into verdicts and routes<br/>wt-18"]
  end
  subgraph s28["Stack 28 · judging"]
    direction BT
    t60["t60 · 60-judge-service<br/>Add the Judge service with a scripted layer<br/>wt-18"]
    t65["t65 · 65-cairn-judge<br/>Add cairn judge<br/>wt-18"]
  end
  subgraph s29["Stack 29 · judging"]
    direction BT
    t62["t62 · 62-refine<br/>Refine the spec and drafts at the checkpoints<br/>wt-17"]
  end
  subgraph s30["Stack 30 · contract"]
    direction BT
    t63["t63 · 63-spec-index-writer<br/>Write spec.json from the spec and manifest<br/>wt-16"]
  end
  subgraph s31["Stack 31 · planning"]
    direction BT
    t64["t64 · 64-plan-checkpoints<br/>Run the checkpoints inside cairn plan<br/>wt-16"]
  end
  subgraph s32["Stack 32 · viewer"]
    direction BT
    t68["t68 · 68-api-trace-polling<br/>Poll /api/trace under cairn serve<br/>wt-14"]
  end
  subgraph s33["Stack 33 · patch-routes"]
    direction BT
    t74["t74 · 74-patch-routes<br/>Serve commit and task patches from git<br/>wt-25"]
  end
  subgraph s34["Stack 34 · server"]
    direction BT
    t78["t78 · 78-session-route<br/>Serve sessions from cairn.db<br/>wt-23"]
  end
  subgraph s35["Stack 35 · viewer"]
    direction BT
    t79["t79 · 79-session-pane<br/>Draw the session pane<br/>wt-24"]
    t80["t80 · 80-attribution<br/>Mark each hunk with the turn that wrote it<br/>wt-24"]
  end
  subgraph s36["Stack 36 · viewer"]
    direction BT
    t84["t84 · 84-reader-derive<br/>Derive what the reader shows for a PRD section<br/>wt-27"]
    t85["t85 · 85-reader-screen<br/>Add the reader screen with the PRD pane and its current section<br/>wt-27"]
    t86["t86 · 86-spec-cards<br/>Show the current section's spec as cards with their tasks<br/>wt-27"]
    t87["t87 · 87-card-density<br/>Add the density control and render a card's full spec section<br/>wt-27"]
    t88["t88 · 88-stack-chips<br/>Draw the stacks pane as chips over the base branch<br/>wt-27"]
    t89["t89 · 89-wires-of<br/>Compute the reader's curves from measured boxes<br/>wt-27"]
    t90["t90 · 90-wires-overlay<br/>Measure the panes, draw the curves and light a chain on hover<br/>wt-27"]
    t91["t91 · 91-models-switch<br/>Show the model and reasoning each task ran with or is planned for<br/>wt-27"]
    t92["t92 · 92-pane-dividers<br/>Resize the panes by dragging their dividers<br/>wt-27"]
    t93["t93 · 93-detail-trail<br/>Open a task's detail in a panel with a trail<br/>wt-27"]
    t94["t94 · 94-detail-code<br/>Show a task's stacked diff in its detail<br/>wt-27"]
    t95["t95 · 95-reader-search<br/>Bring search results into view in the reader<br/>wt-27"]
    t96["t96 · 96-reading-presence<br/>Show who is reading which PRD section<br/>wt-27"]
    t97["t97 · 97-remove-canvas · GATE<br/>Make the reader the viewer and remove the canvas<br/>wt-27"]
  end
  subgraph s37["Stack 37 · viewer"]
    direction BT
    t98["t98 · 98-detail-session<br/>Show the agent session in a task's detail<br/>wt-27"]
  end
  subgraph s38["Stack 38 · viewer"]
    direction BT
    t99["t99 · 99-design-tokens<br/>Add the design tokens and the base stylesheet<br/>wt-28"]
    t100["t100 · 100-ui-pieces<br/>Build the shared marks and controls on the tokens<br/>wt-28"]
    t101["t101 · 101-restyle-code-view<br/>Move the code view, search and code blocks to the design system<br/>wt-28"]
  end
  subgraph s39["Stack 39 · testing"]
    direction BT
    t102["t102 · 102-xstate-test<br/>Add @xstate/test and move xstate to 6.0.0-beta.5<br/>wt-29"]
    t103["t103 · 103-presence-model<br/>Test the presence server against the room machine<br/>wt-29"]
  end
  subgraph s40["Stack 40 · testing"]
    direction BT
    t104["t104 · 104-reader-models<br/>Test the reader's trail, pin and dividers against models<br/>wt-30"]
  end
  subgraph s41["Stack 41 · testing"]
    direction BT
    t105["t105 · 105-derive-model<br/>Test derivation against a model of its inputs<br/>wt-31"]
  end
  subgraph s42["Stack 42 · contract"]
    direction BT
    t107["t107 · 107-written-from<br/>Record what each spec section was written from<br/>wt-33"]
  end
  subgraph s43["Stack 43 · lint"]
    direction BT
    t108["t108 · 108-diagram-draws<br/>Check that a Mermaid block draws<br/>wt-34"]
  end
  subgraph s44["Stack 44 · planning"]
    direction BT
    t109["t109 · 109-stack-diagram<br/>Draw the stack diagram from the manifest<br/>wt-34"]
  end
  subgraph s45["Stack 45 · lint"]
    direction BT
    t110["t110 · 110-diagram-checks<br/>Keep diagrams true in cairn lint and cairn plan<br/>wt-34"]
  end
  subgraph s46["Stack 46 · planning"]
    direction BT
    t112["t112 · 112-replan<br/>Find what planning again has to add<br/>wt-33"]
  end
  subgraph s47["Stack 47 · planning"]
    direction BT
    t113["t113 · 113-plan-again<br/>Plan again after the PRD changes<br/>wt-34"]
  end
  subgraph s48["Stack 48 · planning"]
    direction BT
    t114["t114 · 114-plan-dry-run<br/>Add dry runs and one-run planner choices to cairn plan<br/>wt-32"]
  end
  main --> t1
  main --> t2
  t1 --> t3
  main --> t5
  t9 --> t6
  main --> t7
  main --> t8
  main --> t9
  t6 -.-> t10
  t8 -.-> t10
  t9 -.-> t10
  main --> t11
  t5 -.-> t12
  t6 -.-> t12
  t10 --> t13
  main --> t14
  t14 --> t15
  t15 --> t16
  main --> t17
  main --> t18
  t6 -.-> t19
  t17 -.-> t19
  t18 -.-> t19
  t19 --> t20
  t8 -.-> t21
  t9 -.-> t21
  t12 -.-> t21
  t19 -.-> t21
  main --> t22
  t22 --> t23
  t17 --> t24
  t20 --> t25
  t25 --> t26
  t26 --> t27
  t11 --> t28
  t28 --> t29
  t24 -.-> t30
  t27 -.-> t30
  t29 -.-> t30
  t8 -.-> t31
  t9 -.-> t31
  t12 -.-> t31
  t19 -.-> t31
  t31 --> t32
  t32 --> t33
  t2 -.-> t34
  t21 -.-> t34
  t32 -.-> t34
  t21 -.-> t35
  t30 -.-> t35
  t32 -.-> t35
  t35 --> t36
  t2 -.-> t37
  t3 -.-> t37
  t16 -.-> t38
  t36 -.-> t38
  t37 -.-> t38
  t34 -.-> t39
  t36 -.-> t39
  t39 --> t40
  t40 --> t41
  main --> t42
  t13 --> t43
  t13 --> t44
  t42 -.-> t45
  t43 -.-> t45
  t44 -.-> t45
  t45 --> t46
  t46 --> t47
  t47 --> t48
  t48 --> t49
  t49 --> t50
  t50 --> t51
  t51 --> t52
  t52 -.-> t68
  t39 -.-> t68
  t52 --> t75
  t75 --> t53
  t53 --> t54
  t11 --> t55
  t17 -.-> t56
  t29 -.-> t56
  t29 --> t57
  t6 -.-> t58
  t17 -.-> t58
  t55 -.-> t59
  t58 -.-> t59
  t57 -.-> t60
  t59 -.-> t60
  t57 --> t61
  t60 -.-> t62
  t61 -.-> t62
  t56 -.-> t63
  t61 -.-> t63
  t30 -.-> t64
  t62 -.-> t64
  t63 -.-> t64
  t60 --> t65
  t27 --> t66
  t54 --> t67
  t52 --> t71
  t71 --> t72
  t72 --> t73
  t52 --> t69
  t69 --> t70
  main --> t74
  t9 --> t76
  t76 --> t77
  t2 -.-> t78
  t74 -.-> t78
  t77 -.-> t78
  t54 -.-> t79
  t76 -.-> t79
  t79 --> t80
  t54 --> t81
  t8 --> t82
  t82 --> t83
  t69 -.-> t84
  t83 -.-> t84
  t101 -.-> t84
  t84 --> t85
  t85 --> t86
  t86 --> t87
  t87 --> t88
  t88 --> t89
  t89 --> t90
  t90 --> t91
  t91 --> t92
  t92 --> t93
  t93 --> t94
  t94 --> t95
  t95 --> t96
  t96 --> t97
  t79 -.-> t98
  t97 -.-> t98
  main --> t99
  t99 --> t100
  t100 --> t101
  main --> t102
  t102 --> t103
  t85 -.-> t104
  t92 -.-> t104
  t93 -.-> t104
  t102 -.-> t104
  t32 -.-> t105
  t102 -.-> t105
  t29 --> t106
  main --> t107
  main --> t108
  t88 -.-> t109
  t108 -.-> t109
  t30 -.-> t110
  t109 -.-> t110
  t20 --> t111
  t26 -.-> t112
  t107 -.-> t112
  t30 -.-> t113
  t63 -.-> t113
  t110 -.-> t113
  t111 -.-> t113
  t112 -.-> t113
  t106 -.-> t114
  t113 -.-> t114
  class t1,t3,t20,t31,t32,t58,t60,t62,t80,t105,t111,t112 opus
  class t2,t5,t6,t7,t8,t9,t10,t12,t13,t14,t15,t16,t17,t18,t19,t21,t22,t23,t25,t26,t28,t29,t30,t33,t34,t35,t36,t37,t38,t39,t40,t41,t42,t43,t45,t46,t47,t48,t49,t50,t51,t52,t53,t54,t55,t57,t59,t61,t63,t64,t65,t67,t68,t69,t70,t71,t72,t73,t74,t75,t76,t77,t78,t79,t81,t82,t83,t84,t85,t86,t87,t88,t89,t90,t91,t92,t93,t94,t95,t96,t97,t98,t99,t100,t101,t103,t104,t106,t108,t109,t110,t113,t114 sonnet
  class t11,t24,t27,t44,t56,t66,t102,t107 haiku
  class t1,t2,t3,t81,t97 gate
  classDef opus fill:#7c3aed,color:#ffffff,stroke:#4c1d95
  classDef sonnet fill:#2563eb,color:#ffffff,stroke:#1e3a8a
  classDef haiku fill:#facc15,color:#111111,stroke:#a16207
  classDef gate stroke:#dc2626,stroke-width:5px
  style main fill:#e5e7eb,color:#111111,stroke:#6b7280
```

### `cairn plan` {#spec.planning.cairn-plan}

- Implements: `prd.cli`, `prd.planning.two-reviews`
- Files: `packages/cli/src/commands/plan.ts`
- Depends on: `spec.planning.planner-service`, `spec.planning.stack-order`, `spec.lint`, `spec.sections.cairn-ids`, `spec.judging.checkpoints`, `spec.contract.spec-index`

The command runs two steps and asks before each write that follows a model's work.

Step 1, the spec:

1. Assign missing IDs in `prd.md`.
2. If `spec.md` is missing, or `--respec` is passed, generate it with `Planner.spec`. If it exists, find what planning again adds (see `spec.planning.again`). If there is nothing to write, go to step 2.
3. If `TYPESAFE_API_KEY` is set, run the sections checkpoint on what was written (see `spec.judging.checkpoints`). Otherwise print `Judging skipped: TYPESAFE_API_KEY is not set.` once.
4. Assign IDs, write `spec.md` and `spec.json`, and print each section written with its line and the PRD sections it implements.
5. With `--spec`, stop. Otherwise ask `Draft tasks from this spec? [y/N]`. No stops with the spec on disk and prints `Edit .cairn/spec.md, then run cairn plan again.`

Step 2, the tasks:

6. Read `spec.md` from disk. Draft tasks for the spec sections that need them: every section on a first plan, and otherwise the ones `spec.planning.again` names.
7. Run the task size and routing checkpoints on the drafts when the key is set.
8. Compute gates, order the stack with the existing tasks, ask the stack questions, and lint the result in memory.
9. Print what judging changed, then the stack as `cairn status` would with new tasks marked `new`, lint findings and `flag` or `unsure` judgments, and ask `Write manifest.json? [y/N]`.
10. Refuse to write if lint has errors. Judgments never block the write.
11. Write `manifest.json`, then `spec.md` with the stack diagram drawn again (see `spec.planning.stack-diagram`) and any split sections, then `spec.json` and `judgments.json`.

- `--yes` answers yes to both questions.
- `--respec` is refused when the manifest has a task that is not `pending`. It replaces the spec and the manifest; re-planning a started stack from nothing is v2's rebase flow.
- A run that finds nothing to write in either step prints `The plan is up to date.` and exits 0.

Tests use the scripted `Planner` and `Judge` in a temporary repository: answering no after the spec leaves `spec.md` written and no manifest; a second run does not call `Planner.spec` and plans from the edited file; `--spec` never asks; `--yes` writes both; a lint error refuses the write and leaves the manifest as it was.

### Planning again {#spec.planning.again}

- Implements: `prd.planning.again`
- Files: `packages/core/src/replan.ts`, `packages/cli/src/commands/plan.ts`, `packages/core/src/lint.ts`
- Depends on: `spec.planning.cairn-plan`, `spec.contract.spec-index`, `spec.planning.stack-order`, `spec.lint`

`replanOf(prd, spec, index, manifest)` is pure and returns what a second `cairn plan` has to do:

| Field           | Holds                                                                                                                           | `cairn plan` does                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `uncovered`     | PRD sections that are not covered (see `spec.format`)                                                                           | `Planner.sections` writes spec for them |
| `rewritable`    | Spec sections Cairn wrote, nobody edited and no task builds, that implement a PRD section whose hash differs from `writtenFrom` | `Planner.sections` writes them again    |
| `staleSections` | Every other spec section that implements a changed PRD section                                                                  | Reported                                |
| `untasked`      | Spec sections with a `Files` key that no task names in `specSections`, and are not parents of sections that have tasks          | `Planner.tasks` drafts tasks for them   |
| `staleTasks`    | Tasks whose spec sections are in `staleSections`, or whose spec section's body hash differs from the index's                    | Reported                                |

- New spec sections go where the planner says: under the existing section it names, after that section's last child. A section it places nowhere goes at the end of the spec, before `spec.acceptance` when there is one.
- A rewritten section keeps its ID and its place.
- Existing tasks pass through `stackOf` untouched. After the write, every task that was in the manifest is equal to what it was, field for field.
- `staleSections` and `staleTasks` are the lint rules `stale-section` and `stale-task`, so `cairn lint` and the plan output report them the same way. A person settles one by editing the spec section, which makes it theirs, or by accepting it: `cairn plan --accept <section>` records the current hashes in `writtenFrom` and changes nothing else.

Tests: properties over generated plans with an added PRD section, that every existing task is unchanged and every new ID is higher than every old one; that a section a person edited is never in `rewritable`; that a section with a task is never in `rewritable`; and that `replanOf` of a plan just written is empty. One example in a temporary repository adds a section to a PRD and finds new spec sections, new tasks and an unchanged old manifest.

### Stack diagram {#spec.planning.stack-diagram}

- Implements: `prd.planning.diagrams`
- Files: `packages/core/src/stack-diagram.ts`, `packages/core/src/stacks.ts`, `apps/viewer/src/stacks.ts`
- Depends on: `spec.planning.stack-order`, `spec.viewer.stacks`

`stackDiagramOf(manifest)` is pure and returns the Mermaid text of the plan's stacks, in the format of the diagram in `spec.planning.stack-order`: a `main` node, a subgraph per stack labelled `Stack N · <area>`, a node per task with its ID, branch slug, `GATE` when gated, title and worktree, a solid arrow from a parent, a dashed arrow from a dependency on another stack, and a class per model plus `gate`.

- Which tasks form a stack, its number and its area are the viewer's rules (see `spec.viewer.stacks`). That grouping moves from `apps/viewer/src/stacks.ts` to `packages/core/src/stacks.ts`, and the viewer imports it, so the pane and the diagram cannot disagree. The viewer keeps its layout: rows, columns and levels.
- The diagram sits between `<!-- cairn:stacks -->` and `<!-- /cairn:stacks -->` in `spec.md`. `withStackDiagram(spec, manifest)` replaces what is between them. A spec without the markers gets a `## Stacks {#spec.stacks}` section with a `Context` key naming the PRD's top section, before `spec.acceptance` when there is one and at the end otherwise.
- `cairn plan` calls it on every manifest write. Nothing else writes between the markers.
- Model classes come from the manifest's model names. `opus`, `sonnet` and `haiku` keep the colours this file uses; any other model takes one neutral class.

Done when `stackDiagramOf` of this repo's manifest equals the diagram in this file byte for byte, with the markers added round it by this task, and the viewer's stacks tests pass against the moved grouping.

Tests: properties that every task is a node in exactly one subgraph, every `parent` is a solid arrow and every other dependency a dashed one, the text draws (`drawsOf`), and `withStackDiagram` applied twice equals applied once and changes nothing outside the markers.

### Dry runs {#spec.planning.dry-run}

- Implements: `prd.planning.comparing`
- Files: `packages/cli/src/commands/plan.ts`, `packages/cli/src/print-stack.ts`
- Depends on: `spec.planning.cairn-plan`, `spec.models`

- `cairn plan --dry-run` runs both steps in memory, asks nothing and writes nothing. It prints what step 4 and step 9 print, then one line: `planned <n> sections, <n> tasks, <n> lint errors, <n> flags in <n>s with <source> <provider or cli> <model>`.
- `--source`, `--provider` and `--model` replace `planner.source`, `planner.provider` and `planner.model` for the run. The merged planner config is decoded again, so `--source api` with no model fails as the config would.
- A dry run plans from the files on disk, so it also shows what planning again would add.

Tests, with the scripted layers: a dry run leaves every file in `.cairn/` byte for byte as it was; the totals line counts what the scripted plan holds; `--source api` without a model fails before any call.

## Lint {#spec.lint}

- Implements: `prd.cli`, `prd.section-ids`, `prd.planning.diagrams`
- Files: `packages/core/src/lint.ts`, `packages/core/src/diagrams.ts`, `packages/cli/src/commands/lint.ts`
- Depends on: `spec.sections.parsing`, `spec.gates.detection`, `spec.planning.stack-order`

`lint(prd, spec, manifest, config)` is pure and returns a list of `Finding`, each `{ rule, severity, file, line, message }`. The command prints `file:line rule message` and exits 1 on any error.

| Rule                | Severity | Fires when                                                                                                                 |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `unknown-section`   | error    | A task or spec key names an ID that no heading has, including a deleted heading                                            |
| `unmapped-section`  | error    | A PRD section is not covered (see `spec.format`)                                                                           |
| `missing-id`        | error    | A heading has no ID. The message says to run `cairn ids`                                                                   |
| `duplicate-id`      | error    | Two headings share an ID                                                                                                   |
| `wrong-prefix`      | error    | A `spec.` ID in `prd.md`, or the reverse                                                                                   |
| `bad-parent`        | error    | A parent or dependency that is not in the manifest, or a cycle                                                             |
| `parent-mismatch`   | error    | `parent` differs from what `parentOf` computes from `dependsOn`                                                            |
| `worktree-clash`    | error    | Two tasks share a `worktree` and neither depends on the other                                                              |
| `gate-mismatch`     | error    | `humanGate` differs from what plan-time detection computes                                                                 |
| `no-commits-landed` | warning  | A task is `landed` with no commits                                                                                         |
| `index-drift`       | warning  | A derived field in `spec.json` differs from `spec.md` or `manifest.json`; the message names the section and field          |
| `bad-diagram`       | error    | A Mermaid block in `prd.md` or `spec.md` does not draw; the message carries the parser's error                             |
| `diagram-drift`     | error    | The text between the stack diagram's markers differs from `stackDiagramOf(manifest)`. The message says to run `cairn plan` |
| `stale-section`     | warning  | A spec section implements a PRD section that changed after the spec section was written (see `spec.planning.again`)        |
| `stale-task`        | warning  | A task builds a spec section that is stale or was edited after the task was planned                                        |

`drawsOf(mermaid)` in `diagrams.ts` returns the parser's error or nothing. It parses with `pele`, the library the viewer draws with, so a block that passes lint draws in the viewer. Read `pele`'s `core` and `detect` declarations for a parse that needs no DOM; lint runs in Node. `diagram-drift` does not fire on a spec with no markers and no manifest.

## Judging {#spec.judging}

- Implements: `prd.judging-the-plan`

Lint says whether the plan is well formed. Judging asks a decision model, at each step of the breakdown, whether the pieces are the right size and which model each task needs. The language model writes and splits; the decision model decides when to split and which model to use; code decides what each answer means and keeps every change within bounds.

### Questions {#spec.judging.questions}

- Files: `packages/core/src/judging/questions.ts`
- Depends on: `spec.sections.parsing`, `spec.contract.manifest`

Three `Decision.make` definitions from `effect/ai`, each an input schema and named decisions. They are plain data, so they live in core. `inputsOf(prd, spec, manifest)` is pure and returns one input per spec section, per task and for the stack.

| Target  | Input                                                                                     | Decision     | Kind                                          | Asks                                                                              |
| ------- | ----------------------------------------------------------------------------------------- | ------------ | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Section | The section's title, body and files; the title and body of each PRD section it implements | `size`       | rate: `too_small`, `right`, `too_large`       | Is it one to three tasks' worth, or a detail of a neighbour, or several features? |
|         |                                                                                           | `faithful`   | probability                                   | It does what its PRD sections ask and adds no behaviour they do not ask for       |
|         |                                                                                           | `buildable`  | probability                                   | An agent could build it from its text and files without asking a question         |
| Task    | Title, files, the titles it depends on; the bodies of its spec and PRD sections           | `size`       | rate: `too_small`, `right`, `too_large`       | Is it one reviewable diff from one agent session?                                 |
|         |                                                                                           | `matches`    | probability                                   | Its title and files carry out its spec sections, and nothing they do not ask      |
|         |                                                                                           | `model`      | classify: the names in `judge.models`         | Which model the task needs, from each model's description in config               |
|         |                                                                                           | `reasoning`  | rate: `low`, `medium`, `high`, `xhigh`, `max` | How much reasoning the work needs                                                 |
| Stack   | Feature, the PRD goal, every PRD section's ID and title, every task's title and sections  | `complete`   | probability                                   | Together the tasks build every PRD section listed                                 |
|         |                                                                                           | `ordered`    | probability                                   | Each task can be built and tested with only the tasks it depends on               |
|         |                                                                                           | `oneFeature` | probability                                   | It builds one feature, not several that could ship alone                          |

The task input leaves out the planner's own model and reasoning, so Jev's choice does not lean on them.

Each rating level and probability carries a description in the definition, with an example from this repo's own plan. The definitions are the prompt; there is no prompt file.

### Verdicts {#spec.judging.verdicts}

- Files: `packages/core/src/judging/verdicts.ts`
- Depends on: `spec.judging.questions`, `spec.contract.judgments`

`verdictOf(question, outcome, thresholds, task?)` is pure and returns `pass`, `flag` or `unsure`:

- A probability: `pass` at or above `judge.pass`, `flag` below `judge.flag`, `unsure` between.
- `size`: `unsure` when confidence is below `judge.minConfidence`; otherwise `pass` for `right` and `flag` for the other two, with the label in the message.
- An unanswered decision (refused, missing or invalid) is `unsure`, with the reason in the message.

`model` and `reasoning` choose rather than judge. `routeOf(answers, draft, thresholds)` returns the model and reasoning to use, each with `source: "judge" | "planner"`. An answer with confidence at or above `judge.minConfidence` gives Jev's label and `pass`; a lower one keeps the planner's value and gives `unsure`. In `cairn judge`, which changes nothing, a confident answer that differs from the manifest is a `flag`.

Properties: raising a probability never turns `pass` into `flag`; lowering confidence never turns `unsure` into `pass`; an unanswered decision is never `pass`; `routeOf` never returns a model that is not in `judge.models`.

### Judge service {#spec.judging.judge-service}

- Files: `packages/cli/src/judge.ts`
- Depends on: `spec.models`, `spec.judging.verdicts`

`Judge.judge(inputs, previous)` returns `Judgments`. For each target it hashes the encoded input with SHA-256. A previous judgment with the same hash and model is kept without a call. The rest go to `DecisionModel.decideSettled`, one request per target with all its questions, four requests at a time. A task's `model` question is left out of the request when `judge.models` names fewer than two models, since there is nothing to choose between.

- The TypeSafe client does not retry. `Judge` retries a rate-limit error up to three times, waiting the delay the provider gives.
- Any other `AiError` fails with a `JudgeError` that names the target. A missing key fails with a `JudgeError` that names `TYPESAFE_API_KEY`.
- The test layer builds a `DecisionModel` with `DecisionModel.make` and a scripted `decide`. Tests count its calls to show that an unchanged target is not asked again.

### Checkpoints {#spec.judging.checkpoints}

- Files: `packages/cli/src/refine.ts`
- Depends on: `spec.judging.judge-service`, `spec.planning.planner-service`

`refine({ prd, spec, drafts, specGenerated })` runs the first three checkpoints in order and returns the refined spec, the refined drafts and the judgments behind every change:

1. Sections, only for the sections written in this run: every section when `specGenerated` is true, and the new or rewritten ones when planning again. A section whose `size` is `too_large` with confidence at or above `judge.minConfidence` goes to `Planner.splitSection`. Its replacement sections get IDs and are judged again. `too_small`, `faithful` and `buildable` are reported. A spec a human wrote or edited is reported on, never rewritten.
2. Task size. A draft whose `size` is confidently `too_large` goes to `Planner.splitTask`, and the new drafts are judged again. `too_small` and `matches` are reported.
3. Routing. Each draft's `model` and `reasoning` answers go through `routeOf`. A confident answer replaces the planner's value; otherwise the planner's value stays and the judgment is `unsure`.

The fourth checkpoint, the stack questions, runs in `cairn plan` after `stackOf` has ordered the drafts. It only reports.

Bounds:

- Steps 1 and 2 run at most `judge.maxRounds` rounds each. Anything still too large after the last round is reported as `flag`.
- A split has to cover what it replaces: the replacement sections keep the original's `Implements`, and the new drafts together keep the original's spec sections and files. A split that drops one is discarded, the original is kept, and the judgment says why.
- Every change is a judgment with `action: "split"` or `action: "routed"`. `cairn plan` prints them before the stack, for example `split  draft "Add the trace store" into 2 tasks (size too_large, confidence 0.83)` and `routed t12 sonnet to haiku (confidence 0.91)`.
- Without `TYPESAFE_API_KEY`, `refine` returns its input unchanged with no judgments.

Tests use the scripted `Judge` and `Planner` layers: one `too_large` answer causes one split; a split that drops a spec section is discarded; rounds stop at `judge.maxRounds` even when every answer is `too_large`; a low-confidence `model` answer leaves the planner's model.

### `cairn judge` {#spec.judging.cairn-judge}

- Files: `packages/cli/src/commands/judge.ts`
- Depends on: `spec.judging.judge-service`, `spec.contract.judgments`

`cairn judge` judges the current `spec.md` and `manifest.json`, writes `.cairn/judgments.json`, and prints one line per `flag` or `unsure`: `file:line judge:<question> <verdict> <message>`, with the probability or the label and confidence. Task lines point at the task's first spec section.

- `--fresh` ignores previous judgments and asks again.
- `--strict` exits 1 on any `flag`. Without it the command exits 0 unless it fails.
- It never writes `manifest.json`, `spec.md`, `spec.json` or `prd.md`. To act on a flag, edit the spec or re-run additive `cairn plan`, which preserves existing tasks and reports stale work. Only `cairn plan --respec`, which replaces the plan, requires every task to be `pending`.

## Status {#spec.status}

### Task machine {#spec.status.task-machine}

- Implements: `prd.orchestrator-contract`
- Files: `packages/core/src/task-machine.ts`
- Depends on: `spec.contract.manifest`

Add `failed`: `running` goes there on `fail`, and `start` takes it back to `running`. The machine's input is the task plus its effective gate. Everything else stays: a gated task reaches `done` only through `approve`, and `land` is ignored outside `done`.

### Derivation {#spec.status.derivation}

- Implements: `prd.orchestrator-contract`, `prd.human-gates`
- Files: `packages/core/src/derive.ts`
- Depends on: `spec.status.task-machine`, `spec.contract.events`, `spec.contract.trailers`, `spec.gates.detection`

`derive(manifest, sections, config, events, commits)` recomputes every task from scratch each time:

1. Group commits by their `Cairn-Task` trailer. The files they change give each task's effective gate.
2. Sort the task's events by `ts`, then by status and actor, so the order of lines in the file never matters.
3. Fold them through the task machine. `running` sends `start`; `done` sends `approve` from `blocked_on_human` when the actor is human, and `finish` otherwise; `blocked_on_human` sends `finish`; `failed` sends `fail`; `landed` sends `land`.
4. Send `land` when the task's commits are reachable from `baseBranch`, or a commit on `baseBranch` carries the task's trailer (a squash merge).

An orchestrator that reports `done` for a gated task still leaves it in `blocked_on_human`: the machine enforces the gate, not the orchestrator.

Anything the machine ignores becomes a warning in the result, not an error: an illegal transition, an approval from a non-human actor, an event or trailer for an unknown task, a commit on a task branch without trailers, and a branch that landed without approval.

A `pending` task with a `blocked_on_human` task below it is marked `waiting`, so the viewer can show why it has not started.

### Section rollup {#spec.status.section-rollup}

- Implements: `prd.viewer`
- Files: `packages/core/src/rollup.ts`
- Depends on: `spec.status.derivation`

A section's status comes from the tasks linked to it or to any section under it. The first rule that matches wins:

1. `deferred` or `context` if a spec key says so.
2. `unmapped` if no task links to it.
3. `blocked_on_human`, then `failed`, then `running`, if any task has that status.
4. `landed` if all have landed, `done` if all are done or landed, `pending` if all are pending.
5. `in_progress` otherwise.

`SectionStatus` goes in the contract next to `TaskStatus`.

### `cairn status` and `cairn approve` {#spec.status.cairn-status-and-cairn-approve}

- Implements: `prd.cli`, `prd.human-gates`
- Files: `packages/cli/src/commands/status.ts`, `packages/cli/src/commands/approve.ts`, `packages/cli/src/git.ts`
- Depends on: `spec.status.derivation`

`cairn status` prints each stack as a tree, top to bottom, one line per task with status, branch, model and a gate marker, then any warnings. A task that waits for another stack to land names what it waits for. `--json` prints the `Trace` the server serves. Both refresh the manifest snapshot when it changed.

`cairn approve <taskId>` appends `{ status: "done", actor: "human:<git user.name>" }` and prints the new status. It refuses a task that is not `blocked_on_human`. The PRD has no way to approve a gate; this is it.

`Git.log` reads each task branch with `git log --format=%H%x1f%P%x1f%(trailers:key=Cairn-Task,key=Cairn-Section,key=Cairn-Session)` and `git show --name-only` for changed files. Its in-memory layer replaces the stand-in `Git` in `packages/core/test/derive.model.test.ts`.

## Sessions {#spec.sessions}

### Trace store {#spec.sessions.trace-store}

- Implements: `prd.orchestrator-contract`, `prd.repo-layout`
- Files: `packages/cli/src/trace-store.ts`, `packages/cli/src/migrations/`

`TraceStore` is a service over Effect SQL's `SqlClient`, from `@effect/sql-sqlite-node`, which runs on `node:sqlite`, so there is no native dependency. Queries are `SqlClient` tagged templates, and rows decode through Effect Schema, so a row that does not match is a typed error, not a cast.

The live layer is `SqliteClient.layer` on `.cairn/cairn.db`; the test layer is the same client on `:memory:`. The client opens with `journal_mode = WAL` and a five-second busy timeout, its defaults, because tasks running in parallel store sessions at the same time.

Migrations are Effect modules named `NNNN_<name>.ts` in `packages/cli/src/migrations/`, each exporting an Effect that runs its SQL. `SqliteMigrator.layer` runs them through `Migrator.fromRecord`, so a bundled CLI needs no directory scan, and records what has run in its own table. A migration is never edited once it lands; a change is a new migration.

`0001_init` creates one table:

```sql
create table sessions (
  id text primary key,          -- s_...
  task_id text not null,
  agent text,
  model text,
  started_at text,
  ended_at text,
  log text not null,            -- redacted JSONL
  redactions text not null,     -- JSON: count per kind
  stored_at text not null
);
```

Notes are not stored yet. A note in the PRD (`prd.viewer.notes`) has a deep-link anchor and an open or resolved state, and can be about a section or a task that has no session, so its table waits for the notes and deep-link work to be planned and comes in its own migration. Until then `Session.notes` is empty.

`cairn.db` is gitignored: even redacted, session logs stay on the machine that made them.

### Redaction {#spec.sessions.redaction}

<!-- human -->

- Implements: `prd.redaction`
- Files: `packages/core/src/redact.ts`, `packages/cli/src/redactor.ts`

`redact(jsonl, secrets)` in core parses each line, rewrites every string value, and serializes it again. Working on decoded strings catches secrets that JSON escaping would hide from a regex over raw text. A line that does not parse fails the whole session.

Secrets come from three places:

- Values in `.env*` files at the repo root, and the current environment's values for the same names. Values under 8 characters are skipped, so `PORT=3000` does not redact every 3000.
- Token patterns: Anthropic and OpenAI keys, GitHub tokens, AWS access keys, Slack tokens, bearer tokens, JWTs and PEM private key blocks.
- `config.redact.deny`.

Each match becomes `[REDACTED:<kind>]`. The result carries a count per kind, stored with the session and printed. Any error fails closed: nothing is written and the command exits non-zero.

Redaction is a mutation-testing target, as is gate detection and derivation.

### `cairn session` {#spec.sessions.cairn-session}

- Implements: `prd.orchestrator-contract`
- Files: `packages/cli/src/commands/session.ts`
- Depends on: `spec.sessions.trace-store`, `spec.sessions.redaction`

- `cairn session put --task t1 [--id s_x] < log.jsonl` redacts, stores and prints the session ID, generating one if none is given.

Redaction lives in Cairn, not in each adapter, so there is one implementation to get right and to test.

### Reading a session {#spec.sessions.reading}

- Implements: `prd.code-view`
- Files: `packages/core/src/session.ts`
- Depends on: `spec.contract.session`

`sessionOf(log, stored)` in core is pure. It takes the redacted JSONL and the stored row's ID, task, redaction counts and notes, and returns a `Session`. It reads Claude Code's log, decoding each line through a schema of only the fields it uses. Those schemas live in core, not the contract: the format is Claude Code's, not Cairn's.

| Line                                                      | Read as                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `type: "user"` whose content is a string or `text` blocks | A prompt                                                                          |
| `type: "user"` whose content is `tool_result` blocks      | The output of the tool turn with the same `tool_use_id`; `failed` from `is_error` |
| `type: "assistant"`                                       | A reply per `text` block and a tool turn per `tool_use` block, in block order     |
| Any other `type`, such as `attachment` or `api-request`   | Skipped and not counted                                                           |

Edits come from `toolUseResult` on the line that carries a tool result:

- An edit or overwrite has `filePath` and `structuredPatch`, a list of hunks whose `lines` start with `+`, `-` or a space. The `+` lines become `added` and the `-` lines `removed`.
- A new file (`type: "create"`) has `filePath` and `content`, and every line of `content` is added.
- `path` is `filePath` relative to the line's `cwd`, the checkout the agent ran in, which for a parallel task is its worktree rather than the repo's own checkout. An edit to a file outside `cwd` is left out.

A line of a read type that does not decode is skipped and counted. A log in which no line has a `type`, a `uuid` and a `message` is `format: "unknown"` with no turns. A tool call with no result keeps an empty `output` and no edits.

Tests: a fixture trimmed from one of this repo's sessions and run through `redact`, checked turn by turn; a property that every `tool_use` ID gives exactly one tool turn, and that each edit's `added` and `removed` are exactly the `+` and `-` lines of its patch.

## Orchestrator adapter {#spec.orchestrator-adapter}

- Implements: `prd.orchestrator-contract`
- Depends on: `spec.contract.javascript-entry`, `spec.sessions.cairn-session`, `spec.status.cairn-status-and-cairn-approve`

What the existing orchestrator does per task, using only `@cairn/contract/js` and the CLI:

1. Read the manifest with `parseManifest`. Take every task that is `pending` in `cairn status --json` whose dependencies are `done` or `landed`, and whose dependencies off its own chain are `landed`. Run them in parallel. How many run at once is the orchestrator's choice; the plan only guarantees that tasks running at once have different worktrees.
2. Work in the task's `worktree`: the repo's own checkout when it is `null`, otherwise `git worktree add ../<repo>-<worktree>` the first time it is used. There, `gt checkout` the parent branch, or `baseBranch` after `gt sync` when the task has no parent, so it starts from the latest `baseBranch`.
3. `appendEvent` with `running`.
4. Run the agent with a new session ID. Its first commit is `gt create <branch> -m <message>`, and later ones are `gt modify --commit -m <message>`. Each message ends with the `formatTrailers` block. `gt modify` restacks the branches above automatically.
5. Pipe the session log to `cairn session put`.
6. `appendEvent` with `failed`, or with `blocked_on_human` when `humanGate.required` and `done` otherwise. A blocked task stops its chain until `cairn approve`.

Graphite does the rest of the stack work: `gt submit --stack` opens or updates one pull request per task, and `gt sync` pulls `baseBranch`, deletes merged branches and restacks what is left. Landing is still read from git (see `spec.status.derivation`): a squash merge carries the task's trailers onto `baseBranch`. Graphite runs git hooks by default, so `pnpm check` still gates every commit; `--no-verify` is refused as before.

The `adapters` package from the vision comes later. For dogfooding, this list is the contract the orchestrator has to meet.

## CLI {#spec.cli}

- Implements: `prd.cli`, `prd.repo-layout`
- Files: `packages/cli/src/main.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/package.json`

One `cairn` binary built with `effect/cli`. Each command finds `.cairn/` in the repo's main checkout, from `git rev-parse --path-format=absolute --git-common-dir`, not from the current worktree. Commands run inside a worktree read and write the same `events.jsonl` and `cairn.db` as everyone else.

`cairn init` creates `.cairn/` with a PRD template, an empty `events.jsonl` and a `config.json` that lists the default `humanPaths` for the project to edit, and adds `.cairn/cairn.db` to `.gitignore`. It refuses to overwrite an existing `.cairn/`.

## Patch routes {#spec.patch-routes}

- Implements: `prd.code-view`
- Files: `packages/cli/src/api.ts`, `packages/cli/src/serve.ts`, `packages/cli/test/api.test.ts`, `apps/viewer/vite.config.ts`

The code view reads its diffs from two routes. They need only git, so they ship on the server `pnpm dev` already runs, before the rest of the API; `spec.server` adds its routes beside them.

| Route                        | Returns                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/commits/:sha`      | `git show --patch <sha>`: the commit's header and message, then its patch                  |
| `GET /api/diffs/:base/:head` | `git diff --patch <base> <head>`: everything `head` changes on top of `base`, as one patch |

- Each SHA decodes through the contract's `Sha`, 40 lowercase hex characters. Anything else is `400` and never reaches git.
- Git runs as a child process with an argument list, never through a shell.
- A SHA git does not know is `404`. Any other git failure is `500` with git's message.
- The body is `text/plain`. A patch for a pair of SHAs never changes, so it carries `Cache-Control: max-age=31536000, immutable`.

In dev, Vite proxies `/api` to the server, as it proxies `/presence`.

Tests run against a temporary repository with two commits: the commit route returns the second commit's message and patch, the range route returns the change between them, and a malformed SHA, an unknown SHA and a range with an unknown end give `400`, `404` and `404`.

## Server {#spec.server}

- Implements: `prd.cli`, `prd.viewer`, `prd.code-view`
- Files: `packages/cli/src/serve.ts`, `packages/cli/src/api.ts`
- Depends on: `spec.status.cairn-status-and-cairn-approve`, `spec.sessions.trace-store`, `spec.sessions.reading`

`cairn serve` runs the existing server on port 4310 with these routes:

| Route                        | Returns                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/trace`             | The `Trace`: both documents' markdown and sections (each spec section with its summary from `spec.json`), the derived tasks, section statuses, commits, events, judgments and warnings. An `ETag` from a hash of the inputs |
| `GET /api/sessions/:id`      | The `Session`: the stored log read by `sessionOf`, with its redaction counts and notes. `404` for an unknown ID                                                                                                             |
| `GET /api/commits/:sha`      | `git show --patch` output as text, which `parsePatchFiles` reads (see `spec.patch-routes`)                                                                                                                                  |
| `GET /api/diffs/:base/:head` | `git diff --patch` output as text for a task's whole diff (see `spec.patch-routes`)                                                                                                                                         |
| `WS /presence`               | Unchanged                                                                                                                                                                                                                   |
| `GET /*`                     | The built viewer. In dev, Vite serves it and proxies `/api`                                                                                                                                                                 |

The viewer polls `/api/trace` every two seconds with `If-None-Match` (the viewer side is in `spec.viewer.model-and-messages`). A file watcher can replace polling later; the PRD allows either.

`Trace` is a contract schema (see `spec.contract.trace`), so the server encodes and the viewer decodes the same type.

Each judgment in the `Trace` carries `stale: boolean`. The server recomputes `inputsOf` and marks a judgment stale when its `inputHash` no longer matches.

## Viewer {#spec.viewer}

### Model and messages {#spec.viewer.model-and-messages}

- Implements: `prd.viewer`
- Files: `apps/viewer/src/model.ts`, `apps/viewer/src/main.ts`, `apps/viewer/src/trace.ts`, `apps/viewer/src/load.ts`
- Depends on: `spec.contract.trace`, `spec.viewer.markdown-rendering`

The model holds the trace, the screen (the reader, or the code view, see `spec.viewer.code-view`), the reader's own state (see `spec.viewer.reader`), the hovered node, the detail panel's trail (see `spec.viewer.detail-panel`), the search, the presence state and the patches and sessions loaded so far. Messages every screen shares: `SettledLoadTrace`, `HoveredNode`, `LeftNode`, `ReceivedPatch`, `ReceivedSession`, `ClickedOpenCode`, `ClickedBackToPlan`, `ClickedTreeTask`, `ClickedTreeCommit`, `ClickedTreeFile`, `ClickedDiffStyle`, `ClickedTurn`, `ClickedHunkMark`. Each reader section below names the messages it adds.

`chainOf(trace, node)` is pure: the PRD sections, spec sections and tasks linked to a node, in both directions. Hovering a spec card, a task row or a chip previews its chain: its curves are drawn in ink and every card, row and chip outside the chain is dimmed. A click does not pin a chain. A click on a task opens its detail, and the one thing a reader pins is a PRD section (see `spec.viewer.reader`). The coloured pins, "Clear pins" and "Show all curves" belong to the canvas and go with it (see `spec.viewer.canvas-removal`).

Layout as the PRD gives it: the PRD pane, the spec pane, then the stacks pane. Each PRD heading carries its status line, and each task shows its status and a gate marker. A spec card or task with a `flag` or `unsure` judgment also shows a judgment marker, dimmed when the judgment is stale.

The stacks pane draws the plan's stack diagram: one box per stack, the boxes in rows over the base branch. `stacksOf(tasks)` lays it out (see `spec.viewer.stacks`).

Loading: under `cairn serve`, a subscription in `load.ts` fetches `/api/trace` every two seconds with `If-None-Match` (see `spec.server`). A `200` is decoded through the `Trace` schema and sends `SettledLoadTrace` with the trace; a `304` sends nothing; a network or decode error sends `SettledLoadTrace` with the error, and the view shows the error above the last good trace. The demo build (`vite build --mode demo`) loads `demo-trace.json` once and never polls.

### Markdown rendering {#spec.viewer.markdown-rendering}

- Implements: `prd.viewer`
- Files: `apps/viewer/src/markdown.ts`, `apps/viewer/src/code.ts`, `apps/viewer/src/diagram.ts`

Parse with `mdast-util-from-markdown` plus GFM tables and map the nodes to Foldkit's `h` builders. No `innerHTML`, so a PRD cannot inject markup, and Scene tests see the rendered text. Each heading's `{#id}` becomes its element ID and `data-section` attribute. The key list at the top of a spec section renders as small chips. HTML comments are dropped.

A fenced block with a language `@pierre/highlights` has a lexer for renders a span per token, coloured inline, and keeps `language-x` on its `code` element. The highlighter is synchronous, so a block needs no Message. Any other language stays plain text. A `mermaid` fence renders through the caller's `diagramView` hook, which for the canvas is an empty placeholder with a `DrawDiagram` Mount. A Mount runs once, when its element is inserted, so the placeholder is keyed by the diagram's source and the line its fence starts on: a diagram that changes gets a new element and is drawn again. The Mount draws the diagram with `pele` (links and images off, text escaped), which is the one place SVG becomes DOM. A diagram that cannot be drawn shows its source and a one-line reason in its place. A diagram changes the height of its column, so the Mount measures the canvas layer once it has drawn and sends `MeasuredLayout`; the layer's own `ResizeObserver` only fires when the layer itself changes size.

### Design system {#spec.viewer.design-system}

- Implements: `prd.viewer`
- Files: `apps/viewer/src/ui/tokens.css`, `apps/viewer/src/ui/base.css`, `apps/viewer/src/ui/components.css`, `apps/viewer/src/ui/marks.ts`, `apps/viewer/src/ui/controls.ts`, `apps/viewer/src/entry.ts`, `apps/viewer/index.html`, `apps/viewer/package.json`, `apps/viewer/src/code.ts`, `apps/viewer/src/diagram.ts`, `apps/viewer/src/view/view.ts`, `apps/viewer/src/view/codeView.ts`, `apps/viewer/src/view/diffView.ts`, `apps/viewer/src/view/treeView.ts`, `apps/viewer/src/view/searchView.ts`, `apps/viewer/src/view/nodeView.ts`, `apps/viewer/test/design.test.ts`, `apps/viewer/test/ui.scene.test.ts`
- Depends on: `spec.viewer.markdown-rendering`

The viewer has one look, the paper look of the Curves mockup in `.cairn/design/prd-curves.html`: paper and ink, 1.5px ink borders, a flat ink shadow under what is raised or selected, monospace for the interface and a serif for prose. This section gives each value of that look one name. A view uses the names and never writes a colour, a size or a timing of its own. Where the mockup and this section disagree, this section wins.

Three stylesheets in `apps/viewer/src/ui/`, imported by `entry.ts` in this order:

- `tokens.css`: the custom properties below on `:root`, and nothing else.
- `base.css`: the page (border-box sizing, the body's paper, ink, font and size), the button reset, the focus ring, `prose`, the search mark, `light-only` and the reduced-motion rule.
- `components.css`: one class for each piece in the table of pieces below.

They are plain CSS. There is no Tailwind, no CSS-in-JS and no preprocessor. A view puts a class on an element with `h.Class` and says what state the element is in with the attributes its own section gives it, such as `aria-pressed`, `aria-expanded`, `aria-checked`, `aria-current`, `data-current` and `data-ran`. The stylesheets select on those, so a Scene test and a style read the same attribute. `h.Style` is kept for a value that is computed: a pane's width, a meter's fill, a table cell's alignment, a highlighted token's colour.

Every colour is a token, and every colour token is written once as `light-dark(<light>, <dark>)`. `:root` sets `color-scheme: light dark`, and `index.html` has `<meta name="color-scheme" content="light dark" />` so the page is not white before the stylesheet loads. The palette then follows the system's setting with no switch, no Model field and no Message, as the diff view does (see `spec.viewer.diff-view`). The light values are the mockup's, but for `--muted`, which is one step darker so that it reads on paper, and `--blocked-ink`, which is new for the same reason.

| Token           | Light     | Dark      | Used for                                                    |
| --------------- | --------- | --------- | ----------------------------------------------------------- |
| `--bg`          | `#f3efe6` | `#1a1815` | The page and the panes                                      |
| `--card`        | `#fbf9f4` | `#23201c` | Cards, buttons, code blocks, the detail panel               |
| `--raised`      | `#ffffff` | `#2c2823` | Tags and chips, which sit on a card or a fill               |
| `--ink`         | `#1d1b18` | `#ece6d9` | Text, strong borders, the flat shadow                       |
| `--ink-soft`    | `#4c463c` | `#cfc7b8` | A card's summary                                            |
| `--muted`       | `#736b5e` | `#9c9385` | Labels, counts and other small print                        |
| `--hair`        | `#ddd5c6` | `#3a352e` | Quiet borders and rules                                     |
| `--green`       | `#cfe7b3` | `#3d5a2a` | What is on or selected; a done chip while models are hidden |
| `--prd`         | `#f4dc96` | `#6b5516` | PRD fills, section references, the search mark              |
| `--spec`        | `#dcd0f4` | `#4a3d73` | Spec card headers and spec tags                             |
| `--pending`     | `#bdb3a2` | `#6f675b` | The dot of a task not started                               |
| `--progress`    | `#e7a13a` | `#e7a13a` | The dot of a task or section under way                      |
| `--done`        | `#5ea659` | `#6fbf68` | The dot of a done task, a meter's fill                      |
| `--blocked`     | `#df513c` | `#f0705c` | The dot of a failed or waiting task, a gated chip's border  |
| `--blocked-ink` | `#b93a27` | `#f0705c` | `GATE` and gate reasons, as text                            |
| `--m-opus`      | `#dcd0f4` | `#4a3d73` | Opus (see `spec.viewer.models`)                             |
| `--m-sonnet`    | `#cfe0fb` | `#2c4a73` | Sonnet                                                      |
| `--m-haiku`     | `#f7e6a6` | `#6b5516` | Haiku                                                       |
| `--m-other`     | `#e4ded2` | `#3f3a33` | Any other model                                             |

`--edge` is `color-mix(in srgb, var(--ink) 50%, transparent)`, the border of a stack box and of a chip at rest. `--tint` is `color-mix(in srgb, var(--ink) 6%, transparent)`, the fill of a hovered row and of inline code. Text on any fill is `--ink`.

`light-only` sets `color-scheme: light` and sets the element's own `color` and `background` again from the tokens, so everything inside it takes the light values. Three things carry it: a highlighted code block and a drawn diagram, whose colours come from `pierre-light` and from Pele and are light only, and the canvas screen's `main` until `spec.viewer.canvas-removal`, because the canvas's views carry light colours inline. The diff is drawn by `@pierre/diffs` with its own light and dark themes.

Shape:

- `--line: 1.5px` is the width of every border and rule. The base branch's bar is 3px.
- Radii: `--r-s: 4px` for tags, chips and inline code; `--r-m: 8px` for buttons, rows, code blocks, stack boxes and the segmented control; `--r-l: 12px` for cards and the detail panel. A dot and a pill are fully round.
- `--lift: 0 2px 0 var(--ink)` sits under a button, the selected chip and a divider's grip. `--lift-l: 0 3px 0 var(--ink)` sits under a card, the detail panel and a stack that holds the current section. A pressed button moves down 2px and loses its shadow. There is no blurred shadow and no gradient.

Type:

- `--mono` is `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`, for the interface. `--prose` is `Charter, "Iowan Old Style", "Palatino Linotype", Georgia, serif`, for prose. No web font is shipped.
- Sizes: `--t-xs: 10px` for tags, `GATE`, reasoning marks, stack numbers and labels; `--t-s: 11.5px` for rows, chips, counts and controls; `--t-m: 12.5px` for the body; `--t-l: 14px` for card titles and a card's full section; `--t-xl: 16px` for the name, level 3 headings and the detail panel's title; `--t-2xl: 20px` for level 2 headings; `--t-3xl: 30px` for the document's title; and `--t-prose: 16.5px` for PRD prose, at a line height of 1.62. Monospace text has a line height of 1.5.
- A label is uppercase `--t-xs` with `0.08em` of letter spacing. Counts use tabular numbers.

Motion:

- `--ease` is `cubic-bezier(0.23, 1, 0.32, 1)`.
- `--d-fade: 150ms` with `ease-out`, for opacity and colour. `--d-press: 160ms` with `--ease`, for a press and an arrow's turn. `--d-move: 240ms` with `--ease`, for the detail panel sliding in and the page's first paint.
- Only `opacity`, `transform` and colours are animated.
- Under `prefers-reduced-motion: reduce`, `base.css` turns every transition and animation off.

Every button, link and divider shows `:focus-visible` as a 2px `--ink` outline, 2px off the element.

The pieces. Each is a class in `components.css`. The views named use it and write no rule of their own for it.

| Class                                          | Look                                                                                                                                                                                                                                                                               | Used by                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `topbar`                                       | A 52px bar with a `--hair` rule under it                                                                                                                                                                                                                                           | The reader, the code view                                                         |
| `label`                                        | Uppercase `--t-xs` in `--muted`                                                                                                                                                                                                                                                    | The heading over a pane, the legend                                               |
| `dot`                                          | An 8px round mark: `--done` for `done` and `landed`, `--progress` for `running` and `in_progress`, `--blocked` for `failed` and `blocked_on_human`, `--pending` otherwise                                                                                                          | Task rows, stack chips, status lines                                              |
| `tag`                                          | A bold `--t-xs` word in an ink border. A PRD tag and a spec tag take their fill; a task ID and a SHA are `--raised`                                                                                                                                                                | Task IDs, `SPEC` and `PRD` in card headers, short SHAs                            |
| `gate`                                         | `GATE` in bold `--t-xs` `--blocked-ink`                                                                                                                                                                                                                                            | Task rows, the detail panel                                                       |
| `btn`                                          | A raised button: `--card`, an ink border and `--lift`; `--green` when `aria-pressed` or `aria-checked` is `true`                                                                                                                                                                   | The status line, the models switch, "Open in code view", the code view's way back |
| `seg`                                          | Buttons joined in one ink border; the pressed one is `--green`                                                                                                                                                                                                                     | The density control, the diff style control                                       |
| `chip`                                         | A small `--r-s` box with an `--edge` border on `--raised`. A model gives it that model's fill. What is planned has a dashed border. The current section's chip has an ink border, bold text and `--lift`. A gated chip has a `--blocked` border. A chip outside the chain is faded | Stack chips, the model chip in a task row, key list chips, legend swatches        |
| `row`                                          | A full-width button, filled `--tint` on hover and when it is the current one                                                                                                                                                                                                       | Task rows in a card, tree rows, search results                                    |
| `card`, `card-head`, `card-body`, `card-tasks` | An ink border, `--r-l` and `--lift-l`. The head is a solid `--spec` fill, or `--prd` for the card of strays, over an ink rule. The task list sits over an ink rule                                                                                                                 | Spec cards, a file's diff in the detail panel                                     |
| `stack`, `base-bar`                            | A box with an `--edge` border and its number under a rule; a stack that holds the current section has an ink border, `--card` and `--lift-l`. The bar is a 3px ink rule that stays at the bottom of the pane                                                                       | The stacks pane                                                                   |
| `divider`                                      | A `--hair` line, ink and 3px wide on hover, focus and drag, with a grip                                                                                                                                                                                                            | Between panes, the detail panel's edge                                            |
| `panel`                                        | `--card`, an ink border, `--r-l` and `--lift-l`; it slides in over `--d-move`                                                                                                                                                                                                      | The detail panel                                                                  |
| `meter`                                        | A 6px `--hair` bar with a `--done` fill                                                                                                                                                                                                                                            | The PRD pane's head                                                               |
| `wire`                                         | An SVG path with a 1.4px `--ink` stroke at 0.4 opacity; full when lit, dashed and faint when its end is off the pane                                                                                                                                                               | The curves                                                                        |
| `prose`                                        | `--prose` at `--t-prose`, with its code, tables and blocks as the mockup has them                                                                                                                                                                                                  | The PRD pane, a card's full section, session replies                              |

`marks.ts` holds the pieces that only show something, each a function of its data and `h`: `dotView(status, h)`, `tagView(kind, text, h)`, `gateView(h)` and `labelView(text, h)`.

`controls.ts` holds the pieces a person works:

- `switchView({ id, label, isChecked, onToggle }, h)` is `Switch.view` from `@foldkit/ui`, drawn as a `btn` with a small box that is ticked when on. It has `role="switch"` and `aria-checked`, and toggles on a click and on Space.
- `disclosureView({ id, isOpen, onToggle, toView }, h)` is `Disclosure.view` from `@foldkit/ui`. It gives a header button its `aria-expanded` and, while open, `aria-controls` naming its panel. The panel is rendered only while open, so `animatePanel` is not used.
- `segmentedView({ label, options, selected, onSelect }, h)` is a `role="group"` with that label and one native button for each option, with `aria-pressed`.

`@foldkit/ui` is pinned to the version of `foldkit` (see `spec.libraries`). Its `Switch` and `Disclosure` are views with no model of their own, so the state stays in the viewer's Model. Its `RadioGroup` keeps a Model and Messages of its own for what is one field here, so the segmented control does not use it, and its `Button` adds nothing to a native button.

The views that outlive the canvas move to these classes and lose their inline colours: the code view's bars and its way back, the tree's rows, the diff style control, the search box and its results, the search mark (`mark[data-search-match]`, filled `--prd`), and code blocks and diagrams, which also become `light-only`. The canvas's own views (`canvasView`, `nodeView` apart from the search mark, `edgesView`, `moveHandleView`, `stacksView`, `cursorsView`, `drawer.ts` and the toolbar in `view.ts`) keep their inline styles until they are deleted.

Tests: `design.test.ts` reads the stylesheets and the sources as text. Every colour token in `tokens.css` is a `light-dark()` pair of hex colours or a `color-mix()` of other tokens. In each palette `--ink` has a contrast of at least 4.5 to 1 on `--bg`, `--card`, `--raised`, `--green`, `--prd`, `--spec` and each model colour, and `--ink-soft`, `--muted` and `--blocked-ink` have it on `--bg` and `--card`. Every `var()` in `base.css` and `components.css` names a token that `tokens.css` defines, and neither file has a hex colour, an `rgb()` or an `hsl()`. No TypeScript file under `apps/viewer/src/` has a hex colour, but for the canvas's files, which the test lists by name. `ui.scene.test.ts` clicks a switch and presses Space on it and finds `aria-checked` and the Message it sent, clicks a segmented control's option and finds `aria-pressed` move to it, and opens a disclosure and finds `aria-expanded`, `aria-controls` and the panel.

### Reader {#spec.viewer.reader}

- Implements: `prd.viewer.reader`, `prd.viewer`
- Files: `apps/viewer/src/reader.ts`, `apps/viewer/src/view/readerView.ts`, `apps/viewer/src/view/prdPaneView.ts`, `apps/viewer/src/model.ts`, `apps/viewer/src/message.ts`, `apps/viewer/src/update.ts`, `apps/viewer/src/view/view.ts`, `apps/viewer/test/reader.test.ts`, `apps/viewer/test/reader.scene.test.ts`
- Depends on: `spec.contract.trace`, `spec.contract.events`, `spec.viewer.model-and-messages`, `spec.viewer.markdown-rendering`, `spec.viewer.design-system`

The reader is the plan screen: a top bar over three panes, the PRD, the spec and the stacks. The window does not scroll; each pane has its own vertical scroll. The Curves variant of the prototype in `.cairn/design/prd-curves.html` is the reference for layout and spacing. Colour, type, borders, shadows and motion come from `spec.viewer.design-system`, and so do the classes and controls a view is built from. Read both before writing a view.

`Screen` gains `Reader`. Until the canvas is removed (see `spec.viewer.canvas-removal`) the viewer still opens on the canvas, and the top bar has a "Plan" and "Canvas" pair of buttons (`ClickedScreen`) to move between the two, so the reader can be tried on the demo as it is built.

The model's `reader` holds only what a person has chosen. Each field arrives with the section that uses it:

```ts
Reader = {
  maybeAtTop: Option<PrdSectionId> // the section at the top of the PRD pane, once it is measured
  maybePinned: Option<PrdSectionId>
  density: "titles" | "summary" | "full" // spec.viewer.spec-cards
  opened: Record<SpecSectionId, boolean> // cards opened or closed apart from the density
  isShowingModels: boolean // spec.viewer.models
  widths: Widths // spec.viewer.panes
}
```

`reader.ts` is pure and holds everything the panes derive from the trace:

- `currentOf(reader, maybeSearched)`: the current section. The active search result's PRD section when there is one (see `spec.viewer.search-interaction`), else the pinned section, else the one at the top.
- `sectionAtTop(tops, line)`: `tops` is each PRD section's top edge in document order. The answer is the last section whose top is at or above `line`, or the first section when none is. The level 1 heading is the document's title, not a section a reader can be on, so it is left out of `tops`.
- `cardsOf(trace, prd)`: the spec sections in `chainOf(trace, prd).spec`, in document order, each with the tasks whose `specSections` name it, in manifest order. With them come the strays: the tasks in the chain that no card lists.
- `countsOf(trace, prd)`: how many spec sections are in the chain, how many tasks, and how many of those are `done` or `landed`. `planCountsOf(trace)` is the same count over every task.
- `coverageOf(status)`: the note for a section with status `deferred`, `context` or `unmapped`, and none for any other. `statusWordOf(status)` is the word shown for a status: `in progress` for `in_progress`, `not started` for `pending`, `waiting on a human` for `blocked_on_human`, and the status itself otherwise.
- `ranOf(task)`: see `spec.viewer.models`.

`readerView` is a CSS grid: the top bar, then the panes with a divider between each pair (see `spec.viewer.panes`). The top bar has the name "Cairn", the feature, the search control (`searchView`, unchanged), the models and reasoning switch and the presence text.

`prdPaneView` renders `trace.prd.markdown` through `renderMarkdown`, as the canvas does, with these hooks:

- Under each heading, a status line: a native button with `statusWordOf`, the spec count and `done/total tasks`, such as `in progress · 3 spec · 5/12 tasks`. It sends `ClickedStatusLine` with the section's ID, which pins the section, or unpins it when it is the pinned one. The pinned section's button has `aria-pressed="true"`. A section with a coverage note shows the note as text in place of the button.
- Beside each heading's title, its section ID as a small button. It sends `ClickedSectionId`, which runs a Command that writes the ID to the clipboard and then sends `CompletedCopySectionId`. The button reads "copied" until the next render after that.
- Over the document, the title and `planCountsOf` as "25 of 97 tasks done" with a meter.
- The current section's `section` element has `data-current`.

Tracking the section at the top: a Mount on the PRD pane (`TrackPrdScroll`) listens to the pane's `scroll` event and a `ResizeObserver` on its content. At most once per animation frame it reads the top of every `[data-section]` heading, calls `sectionAtTop` with a line 140px below the pane's top, and sends `ScrolledPrd` with the answer only when the answer changed. It sends once when it mounts. The update stores `maybeAtTop`; nothing else in the model changes on a scroll.

The spec pane's content is keyed by the current section, so a new section starts at the top of its cards. The stacks pane keeps its scroll.

Escape: a `keydown` subscription on the document sends `PressedEscape`. It goes back one step in the detail panel when the panel is open (see `spec.viewer.detail-panel`), and otherwise unpins. The search control handles its own Escape first and stops it there.

Tests: properties in `reader.test.ts` that `sectionAtTop` returns the last section at or above the line and never moves backwards as the line moves down; that `cardsOf` and its strays together list every task of the chain, and no stray is in a card; and that a count's done never passes its total. Scene tests on the demo trace open the reader, read the status line of `prd.viewer`, find a coverage note on a deferred section and none on a built one, pin a section by its status line and find it current, and unpin it with the same button and with Escape. A Mount does not run in a Scene, so the scroll is tested through `sectionAtTop` and through `ScrolledPrd`.

### Spec cards {#spec.viewer.spec-cards}

- Implements: `prd.viewer.spec-cards`
- Files: `apps/viewer/src/reader.ts`, `apps/viewer/src/view/specPaneView.ts`, `apps/viewer/src/markdown.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/spec-cards.scene.test.ts`, `apps/viewer/test/markdown.test.ts`
- Depends on: `spec.viewer.reader`

`specPaneView` draws `cardsOf(trace, current)`. Over the cards are a label, such as "Spec · 11 sections for Viewer", and the density control.

A card is an `article` with `data-spec` holding the spec section's ID:

- Header: a native button with the section's title and `done/total` of its tasks, and `aria-expanded`, which `disclosureView` gives it. The card is the `card` of `spec.viewer.design-system`: its header's fill is a solid colour, and it has an ink border and a hard offset shadow. No stripe runs down a card's side.
- Summary: `TraceSection.summary` as one paragraph. A section with no summary shows none.
- Tasks: one row per task, at every density. A row is a native button with `data-task-row` holding `<spec>:<task>`: a status dot, the ID, the title, `GATE` for a gated task, the model chip (see `spec.viewer.models`), and then the commit count, with "· session" when a commit has one, or the status word before there is a commit. It sends `ClickedTask`, which opens the task's detail. A task with a judgment mark shows it in its row; a section with one shows it in its header.
- After the cards, when there are strays, one more card headed "Tasks that name this section directly", whose header is not a button and whose rows have `data-task-row` of `_:<task>`.

A PRD section with a coverage note shows the note in place of the cards.

Density is one of `titles`, `summary` and `full`, `summary` at first. The control is `segmentedView` (see `spec.viewer.design-system`): a group of three native buttons labelled "Titles", "Summary" and "Full spec", each with `aria-pressed`, in a group labelled "How much of the spec to show". `ClickedDensity` sets it and empties `opened`. A card is open when `opened` holds it as open, or holds nothing for it and the density is `full`. `ClickedCardHeader` sets `opened` for that card to the opposite of what it shows now.

- `titles`: the header and the task rows.
- `summary`: the summary too.
- An open card shows its full section in place of the summary: a line with the section's ID, then the section's own markdown.

The full section is rendered by `renderSection(document, id, h, hooks)`, new in `markdown.ts`. It renders the nodes of the already parsed document from after the section's heading to the next heading of any level, through the same code as `renderMarkdown`: the key list as chips, prose, lists, tables, highlighted code and diagrams. A section's children are their own cards, so they are not repeated in their parent. The document is parsed once and shared with the PRD pane's search marks; a card that opens does not parse it again, and block offsets stay the document's own, so prose marks land where they do in a whole render.

Tests: Scene tests pin `prd.viewer` and find a card for each spec section that implements it, in the spec's order, with a task row inside one; step the control through its three settings and find the summaries and full sections come and go while the rows stay; open one card alone and find the others unchanged; and change the control and find that card reset. A fixture with a stray task finds the last card. Markdown tests check that `renderSection` renders a section's own body without its heading or its child sections, and that a section with only a key list renders its chips.

### Fuzzy matching {#spec.viewer.fuzzy-matching}

- Implements: `prd.viewer.fuzzy-search`
- Files: `apps/viewer/src/search.ts`, `apps/viewer/test/search.test.ts`
- Depends on: `spec.contract.trace`, `spec.viewer.model-and-messages`

Build a pure search index from the loaded Trace: one entry per PRD section, spec section or task, retaining its existing Node identity. Index section titles and IDs and task titles and branch names; no server endpoint, persisted index or new contract field is needed.

Trim the query and match case-insensitively. Support ordered subsequences for abbreviations and a single insertion, deletion, substitution or adjacent transposition for query tokens of at least four characters; shorter tokens require exact, prefix or subsequence matches. Every whitespace-separated query token must match within one indexed field. Rank exact field matches first, then prefixes, contiguous matches, typo matches and subsequences; within a match class prefer titles, then IDs, then branches, then prose. Break remaining ties by score, source order and stable node key.

Return one result per node with its best matching field, score and sorted, non-overlapping, half-open UTF-16 ranges in the original visible text. Case normalization must preserve a mapping back to source positions and never split a surrogate pair. An empty query returns no search results. The same trace and query always produce the same order.

Cache the index by searchable trace content and rebuild it only when that content changes. Query changes reuse the index; status-only refreshes do not trigger markdown parsing. Keep matching and result derivation pure and use installed Effect core APIs. No search dependency is selected or added by this plan.

Tests:

- Results have unique node identities, deterministic order and valid non-overlapping source ranges; normalized matches never split surrogate pairs.
- Exact titles outrank fuzzy titles; abbreviations and one-edit typos match; blank and unmatched queries, punctuation and mixed-case Unicode are covered.

### Search controls and chain highlighting {#spec.viewer.search-interaction}

- Implements: `prd.viewer.fuzzy-search`
- Files: `apps/viewer/src/model.ts`, `apps/viewer/src/message.ts`, `apps/viewer/src/init.ts`, `apps/viewer/src/update.ts`, `apps/viewer/src/highlight.ts`, `apps/viewer/src/view/view.ts`, `apps/viewer/src/view/canvasView.ts`, `apps/viewer/src/view/nodeView.ts`, `apps/viewer/src/view/stacksView.ts`, `apps/viewer/src/view/edgesView.ts`, `apps/viewer/src/markdown.ts`, `apps/viewer/src/search.ts`, `apps/viewer/src/reader.ts`, `apps/viewer/src/view/searchView.ts`, `apps/viewer/src/view/prdPaneView.ts`, `apps/viewer/src/view/specPaneView.ts`, `apps/viewer/src/view/stackChipsView.ts`, `apps/viewer/test/search.scene.test.ts`, `apps/viewer/test/search-reader.scene.test.ts`
- Depends on: `spec.viewer.fuzzy-matching`, `spec.viewer.curves`, `spec.viewer.detail-panel`

Add window-local query and active-result state to the Schema-defined Model, with fact-named messages for query edits, result navigation, result selection and clearing. The pure update function derives results and reconciles the active node after trace refresh: retain it if still matched, otherwise choose the first result or none. Query edits reset to the first result; empty and unmatched queries have no active chain.

Render a labelled toolbar search input, result count and ranked result list showing kind, title and matched field. Use accessible combobox/listbox semantics with an active descendant, ArrowUp/ArrowDown navigation bounded at the list ends, Enter to select, pointer selection, and Escape to clear. Handle these keys only in the search control; they must not reach the reader's own keys, such as Escape. Announce the count and no-results state without stealing focus.

Selecting a result brings it into view in the reader (see `spec.viewer.reader`). For a PRD section, the PRD pane scrolls to its heading. For a spec section or a task, the first PRD section of its chain, in document order, is the current section for as long as the result is active: `currentOf` puts it ahead of the pin, and it changes neither the pin nor the PRD pane's scroll. Its card, its row and its chip then scroll into view in their own panes, and a result in a spec section's prose shows that card open while it is active. A spec section that implements no PRD section, such as `spec.format`, has no card to go to: selecting it opens it in the detail panel, the one case where a result opens the panel. Keep keyboard focus in search. Preview its chain as a hover does. Apart from that case a result neither opens nor closes the detail panel. Only the active result contributes a search chain; never union separate result chains into a synthetic chain.

Mark direct text matches with semantic mark nodes and a separate node outline, in PRD headings and prose, spec card headers, summaries and full sections, task rows and chips; related chain members get chain highlighting but no text marks unless they independently match. Hover remains the top preview, above search. Draw a curve as part of a chain only when both endpoints belong to that same chain. Use text labels or outlines as well as colour to identify the active result.

Clearing search removes its marks, outline, results and temporary chain while preserving the pinned section, the detail panel, document content and task state. The current section goes back to the pin or to the section at the top. A no-results query shows a message without dimming the panes. Pinning a section and opening a task continue to work. Keep the existing markdown lazy boundaries effective when queries change.

Tests:

- Type an abbreviation or typo, navigate with arrows, select with Enter and pointer, and assert matching text, active result and connected-chain highlighting.
- Search, hover and a pinned section coexist; clearing and Escape preserve the pin and the detail panel; zero matches leave the panes usable; refreshed and removed results reconcile correctly.
- Select a spec section and a task whose PRD section is not the pinned one: its PRD section is current while the result is active and the pin comes back when the search is cleared; unrelated curves stay unlit. Select `spec.format`, which implements no PRD section, and find it open in the detail panel.

### Prose search and inline highlights {#spec.viewer.prose-search}

- Implements: `prd.viewer.fuzzy-search`
- Files: `apps/viewer/src/search.ts`, `apps/viewer/src/markdown.ts`, `apps/viewer/src/view/canvasView.ts`, `apps/viewer/test/search.test.ts`, `apps/viewer/test/search.scene.test.ts`, `apps/viewer/test/markdown.test.ts`
- Depends on: `spec.viewer.search-interaction`, `spec.viewer.markdown-rendering`

Extend the index to visible PRD and spec prose, owned by the nearest preceding section heading until the next heading of any level; nested sections own their text and do not duplicate it in their parent. Extract paragraphs, list items, table cells, link labels and inline code from the markdown AST. Exclude HTML/comments, heading ID attributes, link destinations, code fences and Mermaid content; diffs and session logs remain out of scope.

Keep a visible-text-to-AST-text-node offset map for each searchable prose block. Match within a paragraph, list paragraph or table cell, including across emphasis, links and inline code, but not across block or section boundaries. Reuse the fuzzy ranking and source ranges from fuzzy-matching; prose ranks below titles within a match class. Return one result per node, with its best match and a bounded context snippet from the matching block.

Render match ranges as semantic mark nodes in snippets and in document text leaves, splitting ranges across existing inline elements while preserving formatting, safe links, text selection and heading IDs. Do not rewrite source markdown, inject HTML or wrap DOM after rendering. Highlight the best matching field or prose block per result consistently with its snippet. For typo matches, mark the matched source word; for subsequences, mark matched characters.

Parse each changed document once and share its AST and position mapping between indexing and rendering. Query edits only rematch and render marks. Reconcile results and offsets when source content changes. Selecting a prose result brings the matched block into view, falling back to the owning section until block measurement is available; keep code highlighting and diagram mounts stable.

Tests:

- Highlighting preserves the original visible text and every range maps to text in its owning section.
- Find prose spanning bold text and a link, inspect the highlighted snippet and inline marks, select the matching block, and clear without losing formatting or pins.
- Nested sections, inline code, tables, escaped markdown and Unicode retain correct offsets; comments, code fences and diagram labels do not match; query changes reuse the parsed AST.

Completed build order: `t71` → `t72` → `t73`, built independently of API polling and commit-diff rendering. The matching layer, title/ID/branch search, and prose search with inline highlights are implemented and recorded as done in the manifest.

### Curves {#spec.viewer.curves}

- Implements: `prd.viewer`
- Files: `apps/viewer/src/wires.ts`, `apps/viewer/src/view/wiresView.ts`, `apps/viewer/src/view/readerView.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/wires.test.ts`, `apps/viewer/test/wires.scene.test.ts`
- Depends on: `spec.viewer.reader`, `spec.viewer.spec-cards`, `spec.viewer.stacks`

Curves join the three panes, for the current section only, so the reader starts with a handful of curves and never with all of them:

- one from the current PRD section's heading to the header of each of its spec cards;
- one from each task row in a card, a stray's row too, to that task's chip in the stacks pane.

`linksOf(cards)` is pure and returns those pairs as keys: `prd:<id>` to `spec:<id>`, and `row:<spec>:<task>` to `task:<id>`. Each element a curve can end on carries its key in `data-wire`.

`wiresOf(links, boxes, panes)` is pure. `boxes` is each key's measured rectangle and `panes` is the rectangle each pane clips to, all in window coordinates. For each link with both ends measured it returns a `Wire`: its two keys, its path and `isOffPane`.

- A curve leaves the middle of its source's right edge and arrives at the middle of its target's left edge. The PRD end is different: it leaves from the right edge of the PRD pane, level with the heading, so curves do not cross the prose.
- Each end's height is held inside its own pane, 8px in from the top and bottom. An end that had to be moved was scrolled out of view, and its curve is `isOffPane`. The PRD end does not count: the current section's heading is often above the pane.
- The path is a cubic bezier whose control points sit level with its ends, `max(20, half the horizontal distance)` in from each. The reader computes it itself; `getBezierPath` from `@xyflow/system` goes with the canvas.

Measuring: a Mount on the reader's body (`MeasureWires`) reads the rectangle of every `[data-wire]` element and of the three panes and sends `MeasuredWires`. It measures at most once per animation frame, and only sends when a rectangle changed. It measures when it mounts; on a `scroll` in any pane, heard in the capture phase on the body; on a window resize; when a `ResizeObserver` on each pane and on each pane's content fires, which covers a card opening and a pane being resized; and when the body's `data-wires` attribute changes. The view writes into that attribute what changes the layout without changing a size the observers see, which is the current section.

`wiresView` is one SVG over the reader body, fixed, with no pointer events and `aria-hidden`, holding a path per wire. A wire is mid grey; an `isOffPane` wire is dashed and fainter. The PRD body and each card are lazy views, so a measurement renders the SVG again and nothing else.

Hovering: a spec card's header, a task row and a chip send `HoveredNode` on pointer enter and on focus, and `LeftNode` on leave and on blur. While a node is hovered, the wires with both ends in `chainOf` of that node are drawn in ink and thicker, the rest fainter, and every card, row and chip outside the chain is dimmed. A row counts as its task.

Tests: properties in `wires.test.ts` that `linksOf` gives one link per card and one per row; that every wire's ends lie inside the rectangles of their panes; that a link with an end not measured gives no wire; and that a wire is `isOffPane` exactly when its spec, row or chip end was moved. Scene tests send `MeasuredWires` with rectangles for a pinned section and find one path per link, then hover a row and find its two wires lit and another card dimmed.

### Stacks {#spec.viewer.stacks}

- Implements: `prd.viewer.stacks`
- Files: `apps/viewer/src/stacks.ts`, `apps/viewer/src/view/stackChipsView.ts`, `apps/viewer/src/reader.ts`, `apps/viewer/test/stacks.test.ts`, `apps/viewer/test/stack-chips.scene.test.ts`
- Depends on: `spec.viewer.reader`

The stacks pane draws the picture the diagram in `spec.planning.stack-order` draws, from the same rules, and a test holds the two together.

`stacksOf(tasks)` is pure and replaces `stackLayoutOf`. It returns the stacks in number order:

```ts
Stack = {
  number: number // from 1, in TaskIdOrder of the roots
  root: TaskId
  area: Option<string> // "contract" for a root whose first spec section is spec.contract.trace
  level: number // from 1; level 1 is the bottom row
  cells: Record<TaskId, StackPosition> // column and row inside the box; row 1 is the bottom
}
```

- Membership: a root is a task whose `parent` is `null`, names no task, or would close a cycle. Every other task belongs to its parent's stack, so each task is in exactly one stack.
- Number and label: stacks are numbered from 1 in `TaskIdOrder` of their roots. The area is the second segment of the root's first spec section ID. The label is `Stack N · area`, or `Stack N` for a root with no spec section.
- Cells: a task's row is its depth, 1 for the root and one more than its parent's for every other task, so a chain has no gaps. Columns inside a box follow the old column rule: the first child by ID continues its parent's column, every other child starts a new one, and columns are numbered by the ID of their first task.
- Level: a stack waits on another when one of its tasks depends on a task in the other. Its level is 1 when it waits on nothing, otherwise one more than the highest level among the stacks it waits on. A dependency that names no task, or that would close a cycle between stacks, is ignored.

`stackChipsView` draws every stack, whatever the current section is:

- The pane is the levels stacked bottom to top, highest level at the top. Each level is a row of its stacks in number order, aligned to the bottom. Under the bottom row is a bar the width of the pane labelled with `trace.baseBranch`, held to the bottom of the pane with `position: sticky` so it stays in view. The bar is not a node: nothing hovers it and no curve runs to it, since every stack in the bottom row starts from it. The pane starts scrolled to the bottom, where the bar is.
- A stack is a box (`data-stack` holding its number) with its number in a corner, `labelOf(stack)` as its `title` and `aria-label`, and a CSS grid of its cells. A cell's `grid-row` counts down from the box's own top row, so each box is only as tall as its deepest chain.
- A task is a chip: a native button with `data-task` holding its ID and `data-wire` holding `task:<id>`, showing a status dot and the ID. Its `title` and `aria-label` give the ID, the title, the branch without its `<feature>/` prefix, the worktree (`main checkout` for `null`) and the status. A gated chip has a `--blocked` border (see `spec.viewer.design-system`). The model's colour and the reasoning mark are in `spec.viewer.models`. It sends `ClickedTask`.
- A chip whose task is in the current section's chain has `data-current`, an ink border and a hard shadow, and so does its box. Every other chip is at 45% opacity and still takes focus, hover and clicks.
- Over the diagram, held to the top of the pane: "N of M stacks hold this section · X of Y tasks done", from the stacks with a current chip and `planCountsOf`, and a legend for done, pending, in this section, a human gate and "read up from main".
- No curve is drawn inside the pane. A chip sits directly on its parent, and the detail panel names the other tasks a task depends on (see `spec.viewer.detail-panel`).

The canvas's task cards, with their branch, title, worktree and model band, and `stacksView` that draws them, go with the canvas (see `spec.viewer.canvas-removal`).

Tests: properties in `stacks.test.ts` that every task is in exactly one stack; a child shares its parent's stack and sits one row above it; no two tasks in a box share a cell; a stack's level is above every stack it waits on, cycles aside; numbers follow root IDs; and the input order does not change the result. One test reads the Mermaid block from `.cairn/spec.md` and checks that `stacksOf` on `.cairn/manifest.json` gives the same labels with the same tasks in each, so a manifest change that is not redrawn fails `pnpm check`. A Scene test on the demo trace finds the boxes and their labels, a child chip in the row above its parent in the same box, the base branch bar, a gated chip, and for a pinned section its chips marked current and the count over the diagram.

Considered and left out: `@dagrejs/dagre` with compound nodes, which is how Mermaid lays out the diagram. It needs every node's size before it runs and returns absolute positions, so the view would place every chip by hand and measure twice. The rule above is short enough to compute directly, and CSS sizes the boxes. Also left out: curves between chips for dependencies across stacks. The rows already say what waits on what.

### Models and reasoning {#spec.viewer.models}

- Implements: `prd.viewer.models`
- Files: `apps/viewer/src/reader.ts`, `apps/viewer/src/view/modelView.ts`, `apps/viewer/src/view/specPaneView.ts`, `apps/viewer/src/view/stackChipsView.ts`, `apps/viewer/src/view/readerView.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/reader.test.ts`, `apps/viewer/test/models.scene.test.ts`
- Depends on: `spec.contract.events`, `spec.viewer.spec-cards`, `spec.viewer.stacks`

`ranOf(task)` in `reader.ts` is pure and returns `{ model, reasoning, ran }`. When one of the task's `running` events carries both a `model` and a `reasoning`, it is the latest such event's pair with `ran: true`. Otherwise it is the manifest's `model` and `reasoning` with `ran: false`, whatever the task's status.

`modelView.ts` draws it in three sizes, each with `data-ran`:

- `modelChipView`, at the end of a task row and in the detail panel: `sonnet · medium` on the model's colour.
- On a stack chip: the chip's fill is the model's colour and a small mark follows the ID, `lo`, `med`, `hi`, `xhi` or `max`.
- In a spec card's header: one small square per task in its model's colour.

Colours are the design system's model tokens (see `spec.viewer.design-system`): `--m-opus`, `--m-sonnet` and `--m-haiku`, and `--m-other` for any other model, which is still named. A view sets `data-model` to the model's name and the stylesheet gives the fill; the text on it is ink. They are the hues of the spec's stack diagram, paler. What ran has a solid ink border. What is planned has a dashed one, so the two can be told apart without reading. The `title` says "Ran on sonnet, medium reasoning" or "Planned for sonnet, medium reasoning".

The switch is `switchView` (see `spec.viewer.design-system`) in the top bar, labelled "Models and reasoning", with `role="switch"` and `aria-checked`. `ClickedModelsSwitch` flips `isShowingModels`, which starts `true`. With it off the views render no chip, mark or square, a done stack chip is filled green and a pending one is white, and the legend's model entries are replaced by one for done.

Tests: properties that `ranOf` returns the manifest's pair and `ran: false` for a task with no `running` event that names a model, and the latest such event's pair and `ran: true` when there is one. Scene tests find `data-ran="true"` on a task the demo trace has a record for and `"false"` on a pending one, then turn the switch off and find no model chip, mark or square on the page, and on again.

### Panes {#spec.viewer.panes}

- Implements: `prd.viewer.panes`
- Files: `apps/viewer/src/panes.ts`, `apps/viewer/src/subscription/resize.ts`, `apps/viewer/src/view/dividerView.ts`, `apps/viewer/src/view/readerView.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/panes.test.ts`, `apps/viewer/test/panes.scene.test.ts`
- Depends on: `spec.viewer.reader`, `spec.viewer.curves`

`Widths` is `{ prd, spec, detail }` in pixels, at first 520, 440 and 600. They are what a person chose, not what the window has room for. The stacks pane has no width of its own: it takes what the PRD and the spec leave.

`resized(widths, pane, delta)` in `panes.ts` is pure. It adds `delta` to one pane and holds the result between that pane's limits: 300 to 1000 for the PRD, 260 to 1100 for the spec and 360 to 1400 for the detail panel.

Fitting a window is the layout's job, not the model's. The reader's grid gives the PRD a column from its least width up to its chosen width, the spec the same, and the stacks pane at least 240px, so a window too narrow for the chosen widths shows the PRD and the spec narrower, down to their least widths, before the stacks pane goes under 240px. A window narrower than all the least widths and the two dividers together, 952px, scrolls the reader sideways. The detail panel is never wider than the window. No width in the model changes when the window does.

A divider (`dividerView`) is an element with `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow`, `aria-valuemin` and `aria-valuemax` for its pane's width, `tabindex="0"` and a label such as "Resize the PRD pane". The curves pass over the two dividers between the panes, which are 76px wide to give them room.

- Pointer: a primary press sends `PressedDivider` with the pane, the pointer's ID and its x, and the model's `resize` becomes `Resizing` with those and the pane's width at the press. While it is `Resizing`, a subscription in `subscription/resize.ts` listens to the page's pointer events and sends `MovedResizePointer` and `ReleasedResizePointer`, as the canvas's drag subscription does. A move sets the width to the width at the press plus how far the pointer has moved since, through `resized`. A move or release from another pointer is ignored, and a move with no button held ends a resize whose release was missed. The detail panel's divider is on its left edge, so its `delta` is reversed.
- Keys: with a divider focused, the left and right arrow keys send `PressedArrowOnDivider` and move it 24px.
- The view writes the widths as CSS custom properties on the reader's grid, whose columns are `minmax(300px, <prd>)`, a divider, `minmax(260px, <spec>)`, a divider and `minmax(240px, 1fr)`. A width change resizes the panes, so the wires are measured again through their `ResizeObserver` (see `spec.viewer.curves`).
- Widths are model state and are not kept across reloads.

Tests: properties that `resized` never returns a width outside its pane's limits, changes no pane but the one named, and returns widths already inside their limits unchanged for a `delta` of zero. Scene tests focus a divider and press an arrow key and find `aria-valuenow` changed by 24; press, move and release and find the new width; and check that a move from another pointer changes nothing.

### Presence in the reader {#spec.viewer.presence}

- Implements: `prd.v2-multiplayer-on-cloudflare.presence`, `prd.viewer`
- Files: `packages/contract/src/index.ts`, `packages/core/src/room-machine.ts`, `packages/cli/src/presence.ts`, `apps/viewer/src/subscription/presence.ts`, `apps/viewer/src/view/prdPaneView.ts`, `apps/viewer/src/update.ts`, `packages/core/test/room-machine.test.ts`, `packages/cli/test/presence.test.ts`, `apps/viewer/test/presence.scene.test.ts`
- Depends on: `spec.viewer.reader`

On the canvas a cursor is a point in canvas coordinates, which every window shares. The reader has no shared coordinates: each window scrolls its panes on its own, wraps the PRD at its own width and shows the spec of its own current section. So presence says what a participant is reading, not where their pointer is.

- A participant carries `reading`, the PRD section that is current in their window, or nothing before their first section is known. The wire carries a missing value as `null`, as it does for the cursor. `cursor` stays beside it for the canvas, which keeps its pointers until it is removed; `cursor`, the `Cursor` schema and the `moved` event go with the canvas, behind its gate (see `spec.viewer.canvas-removal`).
- The viewer sends its current section when the socket opens and each time `currentOf` changes. A pin or an active search result counts, since it is what the person is looking at.
- The room machine gains a `read` event, with the participant's ID and the section. It sets that participant's `reading` and nothing else. An event for a participant not in the room is ignored, as a move is.
- `prdPaneView` shows each other participant's label as a chip beside the heading of the section they are reading. Two participants on one section show two chips. The top bar keeps "Here now: ...".

Tests: the room machine through its events: a `read` sets only that participant's section and leaves every cursor alone, and one from an unknown participant changes nothing. A Scene test with two participants finds the other's label beside the heading it is reading, and beside another heading after it sends one.

### Detail panel {#spec.viewer.detail-panel}

- Implements: `prd.viewer.task-detail`, `prd.viewer`, `prd.acceptance-criteria`
- Files: `apps/viewer/src/detail.ts`, `apps/viewer/src/view/detailView.ts`, `apps/viewer/src/drawer.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/detail.test.ts`, `apps/viewer/test/detail.scene.test.ts`
- Depends on: `spec.viewer.reader`, `spec.viewer.models`, `spec.viewer.panes`

The detail panel is fixed to the right edge of the reader, full height, with its own scroll and a divider on its left edge (see `spec.viewer.panes`). It lies over the panes and does not move them.

The model holds `detail`, a trail of nodes; an empty trail is a closed panel, and the last node is the one shown. `detail.ts` holds the trail's pure steps.

- `ClickedTask` from a task row or a chip starts a new trail on that task.
- A task or spec section opened from inside the panel, `ClickedDetailNode`, is added to the end of the trail.
- The trail is drawn across the panel's top as buttons, a task by its ID and a spec section by its title. `ClickedTrailStep` cuts the trail back to that step.
- `ClickedCloseDetail` empties it. `PressedEscape` removes the last step, which closes the panel at the first.
- When the panel opens or its last node changes, focus moves to the panel's heading.

A task shows, in this order:

1. Its ID, title, branch and `Stack N`.
2. Its status; `ranOf` as "ran on sonnet · medium" or "planned for sonnet · medium"; "on t52" for its parent or "from main" for none; and each other task it depends on, as a button that adds it to the trail.
3. The reasons for its gate, when it is gated.
4. Its code and its agent session (see `spec.viewer.detail-code`).
5. Commits, each a button with its subject and short SHA that sends `ClickedOpenCode` with that commit, and "Open in code view", which sends it with none.
6. Traces to: each of its PRD sections as a button that sends `ClickedTraceSection`, which scrolls the PRD pane to that heading; and each of its spec sections as a button that adds it to the trail.
7. The files the plan expects, its events timeline and its judgments, as the drawer shows them today.

A spec section shows its ID, its summary, its key chips, its tasks as rows that add to the trail, and its judgments. Each judgment shows its question, verdict, message and the probability or label and confidence behind it.

The path from a PRD section to a commit is two clicks: a task row of the current section, then a commit in the panel.

`drawer.ts` keeps the parts the panel reuses (the timeline, gate reasons and judgments) until the canvas goes, and then only they remain (see `spec.viewer.canvas-removal`).

Tests: properties in `detail.test.ts` that opening from outside always gives a trail of one, that cutting back to a step keeps exactly the steps up to it, and that going back from one step closes the panel. Scene tests click a task row and find the panel with the task's heading and focus on it; open a spec section from "Traces to" and find two steps in the trail, go back by the first step, and close with Escape pressed twice; find the parent and the other dependencies named on a task that has both; and click a row and then a commit and find the code view on that commit.

### Code view {#spec.viewer.code-view}

- Implements: `prd.code-view`
- Files: `apps/viewer/src/codeView.ts`, `apps/viewer/src/view/codeView.ts`, `apps/viewer/src/view/treeView.ts`
- Depends on: `spec.viewer.detail-panel`

The model's `screen` is `Reader`, or `Code` with the selected task, what is shown of it (`WholeTask`, or `OneCommit` with its SHA) and the selected file. The reader's state and the detail panel's trail stay in the model while the code view is open, so "Back to the plan" (`ClickedBackToPlan`) returns to the reader as it was, with its pin, its pane widths and the panel open on the same task. Until the canvas is removed `Canvas` is a third screen (see `spec.viewer.canvas-removal`), and the code view goes back to whichever of the two it was opened from. The PRD pane's scroll is not model state, so the tracking Mount scrolls the pane to the current section when it mounts again.

Two ways in, each sending `ClickedOpenCode` with a task and an optional commit:

- "Open in code view" on a task in the detail panel opens its whole diff.
- A commit in the detail panel opens that commit.

A task with no commits opens with a middle pane that says so.

The screen is three panes across the window, under a top bar with "Back to the plan", the task's ID and branch, then for the whole task its commit count and short `base..head`, or for one commit its subject and short SHA, and the diff style toggle:

- Tree, 280px wide, with its own scroll. Stacks in `stackLayoutOf` column order, each headed by the branch it starts from. Under each stack, its tasks from the bottom of the stack up, each with ID, title, status and gate marker; under each task, its commits, oldest first. The selected task's or commit's files show under it as a directory tree, where a directory with one child joins it (`src/view/`); a whole task's files are the union of its commits' files. `ClickedTreeTask` selects a task's whole diff, `ClickedTreeCommit` one commit and `ClickedTreeFile` a file. Every row is a button, so the tree can be walked with Tab, and the selected row has `aria-current`.
- Diff, the rest of the width: see `spec.viewer.diff-view`.
- Session, 420px wide, with its own scroll: see `spec.viewer.session-view`. For a whole task it shows the session of the task's latest commit.

Loading: selecting a whole task fetches `/api/diffs/:base/:head`, where `head` is its newest commit and `base` the first parent of its oldest; selecting one commit fetches `/api/commits/:sha` (see `spec.patch-routes`). Either sends `ReceivedPatch` with the route's path and the patch text or the error. When the selected commit has a session not yet loaded, it fetches `/api/sessions/:id` and sends `ReceivedSession` with the `Session`, decoded through its schema, or the error. The model keeps each patch and session it has received, keyed by route path and session ID, so going back to a task or commit draws it without a fetch. A failed fetch shows its error in its pane and is tried again the next time it is selected.

In the demo build there is no server: the tree works, the diff pane shows the patches the build shipped (see `spec.viewer.demo-data`), and the session pane says the demo has no sessions.

Tests: Scene tests open the code view from a commit in the detail panel and from "Open in code view", select a task, a commit and a file in the tree and check the selection and the route each requests, and go back to the plan and find the pinned section and the panel as they were.

### Diff view {#spec.viewer.diff-view}

- Implements: `prd.viewer`, `prd.code-view`
- Files: `apps/viewer/src/diff.ts`, `apps/viewer/src/view/diffView.ts`, `apps/viewer/package.json`
- Depends on: `spec.viewer.code-view`, `spec.patch-routes`

`ReceivedPatch` carries the patch text: `git show` output for one commit, `git diff` output for a whole task. `parsePatchFiles` from `@pierre/diffs` turns it into `ParsedPatch`: for a commit, the commit message as `patchMetadata`, then one `FileDiffMetadata` per file with its hunks; a whole task's patch has no message. Cairn's code reads that structure; it does not parse hunks itself.

The selected task or commit renders in the code view's middle pane through `@pierre/diffs`' vanilla `CodeView`, a virtualized list that owns its own DOM, inside one Foldkit `Mount`. Each file is one `diff` item with the ID `diff:<path>`, under a sticky header with its path. The mount creates the list, calls `setup` on its element and `setItems` with the commit's files, and calls `cleanUp()` on unmount. The element is keyed by the patch's route path, so another task or commit gets a new list.

Mount arguments are fixed when the element appears, so later model changes reach the list the way the viewport reaches the canvas mount: through attributes on the element, which a `MutationObserver` in the mount watches. A change to `data-diff-style` calls `setOptions`, `data-file` scrolls to that file's item with `scrollTo`, and `data-turn` is the highlighted turn (see `spec.viewer.attribution`).

Options:

- `diffStyle`: `unified`, with a toggle for `split` (`ClickedDiffStyle`). The toggle is model state.
- `lineDiffType`: `word-alt`, the default, which highlights changed words in a line.
- `hunkSeparators`: `line-info`, the default. A diff parsed from a patch has only the patch's lines, so expanding context needs `loadDiffFiles` and a route that returns both versions of a file. That waits until someone asks for it.
- Light and dark follow `themeType: "system"`.
- `preferredHighlighter`: `highlights`, with `theme: { light: "pierre-light", dark: "pierre-dark" }`.

Code in a diff is syntax-highlighted. With the Highlights backend a diff uses the same lexers and the same light palette as fenced code in the documents (`spec.viewer.markdown-rendering`). Each file's language is the one `@pierre/diffs` infers from its path; a language with no lexer is plain text and keeps its added and removed marks. Highlighting happens inside the mount, which owns that DOM, so it needs no Message. `diffOptionsOf(style)` in `diff.ts` is pure and gives the options the mount passes, so a unit test can check them.

The files touched by a human-gated path are listed first, in the list and in the tree, with the matching pattern as a label. Review notes from `cairn.db` can later use the same line annotations as the turn marks.

Snabbdom hooks do not fire in Scene tests, so a Scene sees the mount element and not the diff inside it. Scene tests check the mount element's key and attributes. Unit tests check the patch-to-files step against real `git show` and `git diff` output, and that `diffOptionsOf` names the Highlights backend and both themes.

### Session pane {#spec.viewer.session-view}

- Implements: `prd.code-view`
- Files: `apps/viewer/src/view/sessionView.ts`
- Depends on: `spec.contract.session`, `spec.viewer.code-view`, `spec.server`

The right pane draws the selected commit's session, named by its `Cairn-Session` trailer. A commit with no session says so. A session with `format: "unknown"` says Cairn cannot read that agent's log yet. The count of `skipped` lines shows at the bottom when it is not zero.

- At the top: the session ID, its notes and the redaction count per kind.
- A prompt or a reply renders through the markdown renderer (`spec.viewer.markdown-rendering`), which writes no raw HTML, so a session cannot inject markup. A label and a rule tell prompts from replies, not colour alone.
- A tool turn is one button line: its name, its `target`, and a mark when it failed or wrote edits. `ClickedTurn` opens it, showing its input and output as preformatted text cut at 200 lines with a button for the rest, and highlights its hunks (see `spec.viewer.attribution`).
- `[REDACTED:<kind>]` in any text renders as a chip naming the kind.
- Each turn's element has the ID `turn-<id>`. When the highlighted turn changes from the diff side, a command scrolls that element into view.

Tests: Scene tests over a fixture `Session` check that turns are listed in order, a failed tool call shows its mark, clicking a tool turn opens it, a redaction shows as a chip, and an unknown format and a commit with no session show their messages.

### Hunks and turns {#spec.viewer.attribution}

- Implements: `prd.code-view`
- Files: `apps/viewer/src/attribution.ts`
- Depends on: `spec.viewer.diff-view`, `spec.viewer.session-view`

`attributionOf(files, session)` is pure. It takes the commit's `FileDiffMetadata` files and its `Session`, and returns the turns that wrote each hunk and the hunks each turn wrote. A hunk is keyed by its file's path and its index in that file.

Per changed line of a hunk:

- An added line is traced to the last tool turn, in log order, with an edit to the same path whose `added` holds the same text. A removed line is traced the same way through `removed`.
- Lines are compared exactly, so a line a formatter rewrote is not traced to the edit that first wrote it. Blank lines are not traced and do not count.
- A hunk's turns are the distinct turns of its lines, in log order. A hunk is traced when every counted line is, partly traced when some are, and untraced when none are.

Taking the last edit gives a line to the turn whose text survived when a session edits it twice. The trace carries no commit times, so when a session writes a line, commits, and writes the same text again, the later turn gets it. That is rare enough to wait.

In the diff, each hunk carries a mark as a line annotation on its first changed line: a button per turn ("Turn 14 · Edit", numbered by the turn's place in the session), with "Partly traced" or "Not traced to a turn" where that applies. The mount draws the marks, so a mark's button sends its Message from the mount. `ClickedHunkMark` highlights that turn: the session pane opens it and scrolls to it, and the diff marks every hunk of that turn as active. `ClickedTurn` on a turn with edits does the same from the other side and scrolls the diff to its first hunk.

Tests: a property over generated files and edit sequences applies the edits to a file, diffs the result against the original with `parseDiffFromFile`, and checks that every added line is traced to the last edit that wrote it, and that lines added outside the session are untraced. An example runs a real commit of this repo against its session and finds every hunk traced. The marks live in the library's DOM, so a story sends `ClickedHunkMark` and a Scene finds the turn open and active in the session pane.

### Code in the detail panel {#spec.viewer.detail-code}

- Implements: `prd.viewer.task-detail`, `prd.acceptance-criteria`
- Files: `apps/viewer/src/view/detailView.ts`, `apps/viewer/src/view/sessionView.ts`, `apps/viewer/src/update.ts`, `apps/viewer/test/detail-code.scene.test.ts`
- Depends on: `spec.viewer.detail-panel`, `spec.viewer.diff-view`, `spec.viewer.session-view`

A task's detail shows the code it changed without leaving the plan.

Code. The task's whole stacked diff is drawn by the mount the code view uses (`patchView`, see `spec.viewer.diff-view`), keyed by the route path. `detailView` wraps it; `diffView.ts` is not changed here. When a task with commits becomes the last node of the trail, the update fetches `patchPathOf(task, WholeTask)` unless `patches` already holds it, and the reply comes back as `ReceivedPatch`. The panel and the code view share `patches`, so neither fetches what the other has loaded. The list scrolls itself, so it sits in a region 60% of the window's height, under a line with the commit count and the files changed. A failed fetch shows its error in that region and is tried again the next time the task is shown. A task with no commits says "No code yet. The task has not started."; a done task with none says no commit carries its `Cairn-Task` trailer.

Session. Under the code, the agent session of the task's latest commit: the first `PromptTurn`'s text, held to six lines, then up to twelve `ToolTurn`s, one line each with the tool's name and its target, then "... N more tool calls" when there are more, and "Open the session", which opens the code view on that commit. It is loaded as the session pane loads it (see `spec.viewer.session-view`), through `ReceivedSession`, and shares the sessions already loaded. A commit with no session says its code is shown alone. In the demo build it says the demo has no sessions.

Tests: Scene tests open a task with commits and find the diff mount keyed by the whole task's route, with that route requested once across two openings and not again after the code view has loaded it; find "No code yet" on a pending task; and, with a session fixture, find the prompt, twelve tool lines and the count of the rest, and the code view opened by "Open the session".

### Replacing the canvas {#spec.viewer.canvas-removal}

- Implements: `prd.viewer`
- Files: `apps/viewer/src/model.ts`, `apps/viewer/src/message.ts`, `apps/viewer/src/update.ts`, `apps/viewer/src/init.ts`, `apps/viewer/src/view/view.ts`, `apps/viewer/src/canvas.ts`, `apps/viewer/src/drag.ts`, `apps/viewer/src/layout.ts`, `apps/viewer/src/geometry.ts`, `apps/viewer/src/curves.ts`, `apps/viewer/src/highlight.ts`, `apps/viewer/src/drawer.ts`, `apps/viewer/src/diagram.ts`, `apps/viewer/src/subscription/drag.ts`, `apps/viewer/src/view/canvasView.ts`, `apps/viewer/src/view/nodeView.ts`, `apps/viewer/src/view/edgesView.ts`, `apps/viewer/src/view/moveHandleView.ts`, `apps/viewer/src/view/stacksView.ts`, `apps/viewer/src/view/cursorsView.ts`, `apps/viewer/src/subscription/presence.ts`, `packages/contract/src/index.ts`, `packages/core/src/room-machine.ts`, `packages/cli/src/presence.ts`, `apps/viewer/package.json`, `apps/viewer/test/`, `packages/core/test/room-machine.test.ts`, `packages/cli/test/presence.test.ts`
- Depends on: `spec.viewer.reader`, `spec.viewer.spec-cards`, `spec.viewer.stacks`, `spec.viewer.curves`, `spec.viewer.models`, `spec.viewer.panes`, `spec.viewer.detail-panel`, `spec.viewer.search-interaction`, `spec.viewer.presence`

<!-- human -->

Until this section is built the viewer opens on the canvas, and the reader is one click away. This section makes the reader the viewer. A human approves it first, because it takes away things people can do today: panning and zooming, moving the documents and the task cards, keeping several chains pinned in colours, Fit, Reset layout, Show all curves and pointer cursors. The owner compares the two screens on the demo before it lands.

- `Screen` is `Reader` or `Code`, and the viewer opens on `Reader`. The "Plan" and "Canvas" buttons and `ClickedScreen` are removed.
- The canvas, its views and what only they use are deleted: pan and zoom, dragging and its subscription, the measured layout and `MeasuredLayout`, `curvesOf`, the pins and their palette, the node, edge, move handle, cursor and stack card views, and the drawer shell. Their model fields and messages go with them. What the detail panel reuses from `drawer.ts` moves into `view/detailView.ts`.
- Pointer presence goes too: a participant's `cursor`, the `Cursor` schema and the room machine's `moved` event are removed from the contract, the room machine, the presence server and the viewer. `reading` stays (see `spec.viewer.presence`).
- `DrawDiagram` no longer measures a canvas layer. A diagram that changes a pane's height is seen by the wires' `ResizeObserver`.
- `stackLayoutOf` and `columnOf` stay only if the code view's tree still uses them.
- `@xyflow/system` is removed from `apps/viewer/package.json` once nothing imports it.
- `light-only` comes off the screen with the canvas, and `design.test.ts` no longer excuses any file: the canvas's views were the only ones with colours of their own (see `spec.viewer.design-system`).
- The code view's button reads "Back to the plan" and its message is `ClickedBackToPlan`.

Tests: a Scene test for a behaviour the reader keeps is moved to the reader, not deleted: loading and the error over the last good trace, the two clicks from a section to a commit, search, the code view and back, presence, and judgment markers. A test for a behaviour that is removed is deleted with it. `pnpm check` passes with no unused export left behind.

### Demo data {#spec.viewer.demo-data}

- Implements: `prd.viewer`, `prd.viewer.task-detail`
- Files: `apps/viewer/src/demo.ts`, `apps/viewer/src/demo-trace.json`, `scripts/demo-patches/demo-patches.ts`, `apps/viewer/package.json`, `apps/viewer/src/load.ts`, `apps/viewer/src/update.ts`, `apps/viewer/src/view/diffView.ts`, `.github/workflows/ci.yml`, `.gitignore`
- Depends on: `spec.contract.trace`, `spec.patch-routes`, `spec.viewer.diff-view`

The demo and the deployed site load a `Trace` built from this repo's own `.cairn/` by `cairn status --json`. This replaces the three hand-written rows in `demo.ts`. Until the CLI exists, the fixture is written by hand.

What ran. Until an orchestrator writes `model` and `reasoning` on its `running` events (see `spec.contract.events`), the demo trace's `running` events carry what the session records of the first builds say, for the tasks that have such an event: t6 sonnet low, t8 sonnet low, t9 sonnet medium, t10 sonnet medium, t13 sonnet low, t42 sonnet medium, t43 sonnet medium, t44 haiku low, t45 sonnet medium, t46 sonnet medium, t47 sonnet low, t48 sonnet medium, t49 sonnet medium, t50 sonnet high, t51 sonnet medium and t52 sonnet medium. Every other task shows the plan's choice as planned.

Code in the demo. The deployed demo has no server, so its build writes the patches the viewer would fetch as files at the same paths: `api/commits/<sha>` for each commit in the demo trace, and `api/diffs/<base>/<head>` for each task with commits, with the range `rangeOf` gives.

- `scripts/demo-patches/demo-patches.ts` is an Effect script. It reads `demo-trace.json`, runs `git show --patch` and `git diff --patch` with the arguments `spec.patch-routes` gives them, and writes the output under `apps/viewer/public/api/`, which is gitignored.
- It runs before the demo is built. The viewer's `build` script runs it first; if the Alchemy website resource builds with Vite itself, it runs there too. Read `Cloudflare.Website.Foldkit` in the installed Alchemy to see which.
- A commit git does not have is skipped and named in the output, and the script still succeeds. That is the case in a shallow clone, such as the `check` job's.
- The `deploy` job checks out the whole history (`fetch-depth: 0`), so the deployed demo has every patch. That edit is to `.github/workflows/ci.yml`, a gated path, so a human approves this task.
- In the demo build the viewer fetches these paths as it does under `cairn serve`: `withPatchRequested` in `update.ts` no longer skips the demo, and `diffView.ts` no longer says the diff needs `cairn serve`. The site answers a path it has no file for with its HTML page, so a reply whose `Content-Type` is `text/html` is a missing patch, and its pane says this build does not have that commit's code.
- No session is shipped. Session logs are not in the repository, and they are not redacted yet (see `spec.sessions.redaction`).

Tests: the script against a temporary repository with two commits writes one file per commit and one per range, and skips a SHA git does not have without failing. A Scene test in the demo build finds the diff mount requesting a commit's path, and a `text/html` reply shown as a missing patch.

## Testing {#spec.testing}

Each section below is one model and the code tested against it (see `prd.implementation-in-effect.model-based-testing`). The first adds the tools; the others each need the code they test.

### Model-based tests {#spec.testing.model-based}

- Implements: `prd.implementation-in-effect.model-based-testing`
- Files: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/core/package.json`, `packages/cli/package.json`, `apps/viewer/package.json`, `AGENTS.md`, `.agent_sources/xstate/index.md`

The catalog moves `xstate` to `6.0.0-beta.5`, the version `@xstate/test` needs, and adds `@xstate/test` `2.0.0-beta.3` and `fast-check` `4.11.0`. `@xstate/effect` `1.0.0-beta.3` accepts beta.5 as it is. `core`, `cli` and `viewer` take `@xstate/test` and `fast-check` as dev dependencies, and `viewer` takes `xstate` too, for the machines its tests write. After the bump, `node scripts/agent-sources/index-xstate-docs.ts` rewrites the xstate docs index, and the lookup table in `AGENTS.md` gains a row: model-based testing starts at `node_modules/xstate/docs/model-based-testing.md` and the `@xstate/test` README.

`@xstate/test` names `vitest ^3 || ^4` as a peer, and Cairn is on Vitest 5. Cairn does not use `@xstate/test/vitest`, and `propertyTest` runs under Vitest 5, so the peer warning is expected.

A model test:

- Lives in `<subject>.model.test.ts` beside the subject's other tests.
- Has a machine for its model, never the code under test. When the code under test runs that machine, as the presence server runs `roomMachine`, the test is of what the code adds around it, and the machine's own tests cover its transitions.
- Runs `propertyTest` inside `it.effect` through `Effect.promise`, with a fixed `seed` so a run repeats, and passes the `coverage` it returns to `assertTestCoverage` with `{ transitions: 1 }`.
- Takes its events from the model's `schemas.events` through `eventsFromSchemas` from `@xstate/test/effect-schema`. An `Option` is a `Declaration` node it cannot derive, so the test passes an `override` for it. An event the system under test cannot perform as generated gets its own generator in `events`.
- Opens a fresh system under test for each run in `sut.create`. `read` and `projectModel` return the same plain shape, so a failure names the field that differs.
- Commits a failure's `failure.fixture` to the test's `fixtures/` directory and replays it with `replayTest` and `expect: "pass"`. It does not pass `failures: true`: a check writes no files.

A model test has to be able to fail. Each task breaks its code once, watches the test fail with a shrunk sequence, and says in its pull request what it broke.

### Presence against the room machine {#spec.testing.presence-model}

- Implements: `prd.implementation-in-effect.model-based-testing`, `prd.acceptance-criteria`
- Files: `packages/cli/test/presence.model.test.ts`
- Depends on: `spec.testing.model-based`

The model is `roomMachine`. The server runs the same machine, so what is under test is what the server adds: the sockets, the broadcast to every participant and leaving when a socket closes. The system under test is the presence server as `presence.test.ts` starts it: `PresenceRoute` and `Room.layer` on a Node server on port 0, with real WebSocket clients.

- The server names participants `p1`, `p2`, …, so the test keeps its own names. The model's `joined` takes an ID from a pool of three, and the session maps each to the client it opened and the ID the server gave that client.
- `joined` opens a client with the participant's name and kind in its query. For an ID already in the room it closes the old client first; the machine replaces that participant at the end of the list, and the server does the same.
- `moved` writes the cursor as `CursorJson` from that participant's client. Cursors are generated as `presence.test.ts` generates them, on the unit square and through the JSON round trip.
- `left` closes that participant's client. A `moved` or `left` for an ID with no client does nothing, as the machine ignores it.
- `read` returns once every open client has received the room that followed the last event, or after two seconds with what each has. It returns each client's last room with the server's IDs mapped back. `projectModel` returns the machine's participants once for each open client.

The two agree when every participant sees the same room as the machine, in the same order. The test fails when a client misses a broadcast, a closed socket does not leave, or a cursor lands on the wrong participant.

### Reader interactions against models {#spec.testing.viewer-models}

- Implements: `prd.implementation-in-effect.model-based-testing`, `prd.viewer.reader`, `prd.viewer.panes`, `prd.viewer.task-detail`, `prd.acceptance-criteria`
- Files: `apps/viewer/test/reader.model.test.ts`, `apps/viewer/test/panes.model.test.ts`
- Depends on: `spec.testing.model-based`, `spec.viewer.reader`, `spec.viewer.panes`, `spec.viewer.detail-panel`

Two machines, written in the test files from `spec.viewer.detail-panel`, `spec.viewer.reader` and `spec.viewer.panes`, not from the viewer's code. The system under test is the viewer's `update`, started from `init` on the demo trace with the reader open. `send` turns a model event into the Message the click or key sends, and `read` picks the model's fields out of the Model. Commands are dropped. There is no Scene and no render loop.

The reader model has the states `closed` and `open`. Its context is the trail, as node IDs, and the pinned PRD section.

- `clickedTask`, with a task, starts a trail of one from either state.
- `openedInside`, with a task or a spec section, adds it to the end of the trail. It only happens in `open`.
- `clickedStep`, with an index into the trail, cuts the trail back to that step.
- `clickedClose` empties the trail.
- `pressedEscape` removes the last step, and from a trail of one goes to `closed`. In `closed` it unpins.
- `clickedStatusLine`, with a PRD section, pins it, or unpins it when it is the pinned one.

Payloads come from the demo trace's task, spec section and PRD section IDs. A step index comes from the current trail, through a case generator that reads the snapshot.

The panes model has the states `idle` and `resizing`. Its context is the widths and, while resizing, the pane, the pointer, its x at the press and the pane's width at the press.

- `pressedArrow`, with a pane and a direction, moves that pane by 24px within its limits, in either state.
- `pressedDivider`, with a pane, a pointer and an x, starts resizing that pane.
- `movedPointer`, with a pointer, an x and whether a button is held: from the pressed pointer with a button held it sets the width to the width at the press plus the pointer's travel, reversed for the detail panel, within limits. With no button held it ends the resize. Another pointer changes nothing.
- `releasedPointer`, with a pointer: the pressed pointer ends the resize; another changes nothing.

The limits are written out in the model, 300 to 1000 for the PRD, 260 to 1100 for the spec and 360 to 1400 for the detail panel, and the model does not import `resized`. Pointers come from a pool of two, so another pointer is generated as often as the pressed one.

The tests fail when Escape unpins while the panel is open, or a move from another pointer changes a width.

### Derivation against a model of its inputs {#spec.testing.derivation-model}

- Implements: `prd.implementation-in-effect.model-based-testing`, `prd.orchestrator-contract`, `prd.human-gates`
- Files: `packages/core/test/derive.model.test.ts`
- Depends on: `spec.testing.model-based`, `spec.status.derivation`

`derive` takes report lines and commits, not the task machine's events, and its work is the mapping between them, so its model is written over those inputs: a machine of one task's inputs, written from `prd.orchestrator-contract` and `prd.human-gates`, of what an orchestrator writes to `events.jsonl` and what git shows.

Its states are the task's statuses: `pending`, `running`, `blocked_on_human`, `done`, `failed` and `landed`. `derive` recomputes from scratch, so the model keeps facts, not a running status: its context is the reports so far, whether any commit has touched a gated path and whether the task has landed. After each event it replays its reports from the start under those facts, and goes to the status they give with the warnings they give. Nothing is carried over from the step before.

- `reported`, with a status and an actor that is a human or an agent, is a line the orchestrator wrote. A gated task reported `done` goes to `blocked_on_human`, and only a human's `done` takes it on to `done`. A report the lifecycle does not allow leaves the status and adds a warning.
- `committed`, with whether it touches a gated path such as a migration, is a commit with the task's trailers. A gated path gates the task for all its reports, those before the commit too.
- `merged` and `squashed` make the task's commits reachable from `baseBranch`, or put its trailer on a commit there. That stays true for every later event. A task whose replayed reports end in `done` lands; one that ends anywhere else keeps its status, with a warning for landing without approval.

The system under test is `derive` with a test `Git` Layer. `send` adds an event line, with a later `ts` than the one before, or a commit to what the session holds. `read` runs `derive` over all of it and returns the task's status and its number of warnings. Each `read` shuffles the event lines with a seeded generator first, since their order in the file must not matter. Until t21 adds the `Git` service, the test defines a stand-in with the reads derivation needs; t21 replaces it with that service's in-memory layer.

The test fails when an agent's `done` approves a gated task, or a landing skips the gate.

## Acceptance {#spec.acceptance}

- Implements: `prd.acceptance-criteria`

| PRD criterion                                                  | How it is checked                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Three or more stacked tasks on a RinkSide feature              | Dogfood run; `cairn status` output kept with the feature                                                                             |
| Trailers and resolvable sessions                               | `cairn status` warns on a commit without trailers or with a session missing from `cairn.db`                                          |
| A migrations task is gated and blocks children                 | Derivation property test: no child leaves `pending` before a human approves its gated parent                                         |
| Correct status and two clicks to commits                       | Rollup property tests; a Scene test clicks a section and then a commit                                                               |
| Lint catches orphaned and unmapped sections                    | Lint tests for `unknown-section` and `unmapped-section`                                                                              |
| An oversized draft is broken down before printing              | `refine` test: a scripted `too_large` answer splits a draft, and the plan output lists the split                                     |
| A model changes only when Jev is confident                     | `routeOf` property test and a `refine` test with a low-confidence `model` answer                                                     |
| A changed task's judgment shows stale                          | Trace test: edit a task and check `stale`                                                                                            |
| Planning with no API key writes a spec, stops, then a manifest | `cairn plan` test with the stub CLI on `PATH` and no key: spec written, no manifest after a no, a linted manifest after a yes        |
| Planning again adds and changes no existing task               | The `replanOf` properties and the temporary repository example in `spec.planning.again`                                              |
| The stack diagram matches the manifest                         | `stackDiagramOf` of this repo's manifest equals the diagram in this file; a lint test edits the diagram and finds `diagram-drift`    |
| Planning without `TYPESAFE_API_KEY` still writes               | `cairn plan` test with no key: manifest written, skip message printed                                                                |
| A task's stacked diff opens highlighted                        | Patch route tests; a Scene opens a task and finds its range requested and mounted; `diffOptionsOf` test                              |
| Hunks reach the turn that wrote them                           | `attributionOf` property test; a story sends `ClickedHunkMark` and a Scene finds the turn                                            |
| Fuzzy search finds and highlights text and its chain           | Matching properties and Scene tests for navigation, markdown spans, refresh, and preserving the pin on clear                         |
| Scrolling the PRD changes the cards and the lit stacks         | `sectionAtTop` properties; a Scene sends `ScrolledPrd` and finds the cards and current chips of that section; a pinned section holds |
| Models and reasoning show what ran or what is planned          | `ranOf` properties; a Scene finds `data-ran` on rows and chips and none of them with the switch off                                  |
| A task's code shows in the detail panel                        | A Scene clicks a task row and finds the diff mount keyed by the task's range, with the reader still under it                         |
| A broken broadcast or Escape fails a model-based test          | The presence and reader model tests, each broken once by its task, print the shortest failing event sequence                         |
