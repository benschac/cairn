# Spec Trace MVP

A local tool that traces a feature from PRD to spec to stacked diffs to commits to agent sessions, and renders that trace as a read-only canvas. Built to be shippable in one day and dogfooded on RinkSide.

## Goal

Given a markdown PRD in a repo, produce a spec and a stack manifest, let the existing orchestrator execute the stack, and show a live view of which PRD sections are done, in progress, blocked, or waiting on a human. Every commit links back to its PRD section and to the agent session that produced it.

## Non-goals for v1

- No rich editor (Tiptap etc). Users edit markdown in their own editor.
- No real-time multi-user collaboration (v2, see multiplayer).
- No agent-to-agent chat inbox. Coordination is orchestrator-assigned.
- No hosted service, auth, or multi-repo support.
- No replacement of the existing orchestrator. This tool wraps it.

## Repo layout

```text
.trace/
  prd.md            # source PRD, human-authored
  spec.md           # generated spec, editable
  manifest.json     # stack plan + links + status
  events.jsonl      # append-only status events from orchestrator
  trace.db          # SQLite: sessions keyed by ID, notes, annotations
```

## Section IDs

Every heading in `prd.md` and `spec.md` carries a stable ID using a trailing attribute:

```markdown
## Saved views {#prd.saved-views}

### Persist filter state {#spec.saved-views.persist}
```

Rules:

- IDs are lowercase, dot-namespaced, prefixed `prd.` or `spec.`.
- `trace ids` adds missing IDs in place and never rewrites existing ones.
- Renaming a heading keeps its ID. Deleting a heading with linked tasks is a lint error.

## Manifest schema

```json
{
  "version": 1,
  "feature": "saved-views",
  "baseBranch": "main",
  "tasks": [
    {
      "id": "t1",
      "title": "Add saved_views table",
      "prdSections": ["prd.saved-views"],
      "specSections": ["spec.saved-views.persist"],
      "branch": "saved-views/01-schema",
      "parent": null,
      "model": "opus",
      "reasoning": "high",
      "humanGate": { "required": true, "reasons": ["tag:human", "path:migrations/"] },
      "status": "pending",
      "commits": [],
      "sessions": []
    }
  ]
}
```

Status values: `pending`, `running`, `blocked_on_human`, `failed`, `done`, `landed`.

## CLI

- `trace init` creates `.trace/` and a PRD template.
- `trace ids` assigns missing section IDs in `prd.md` and `spec.md`.
- `trace plan` calls a model to generate `spec.md` from `prd.md`, then generates `manifest.json`: tasks, stack order, parent links, model and reasoning level per task, human gates. Prints the plan and waits for approval.
- `trace lint` checks that every task references real section IDs, every PRD section maps to at least one task, and gated tasks sit as low in the stack as their dependencies allow.
- `trace status` prints the manifest as a tree with status.
- `trace serve` starts the local viewer.

## Orchestrator contract

The existing orchestrator reads `manifest.json` and runs tasks. It must:

1. Append one line to `events.jsonl` per state change: `{"ts", "taskId", "status", "detail"}`.
2. Create each task's branch on top of its parent branch.
3. Add commit trailers to every commit:

   ```text
   Trace-Task: t1
   Trace-Section: spec.saved-views.persist
   Trace-Session: s_8f2k1q
   ```

4. Redact the session log, then store it in `.trace/trace.db` under its `Trace-Session` ID.
5. Attach later notes, reviews, and annotations to the session ID in `trace.db`, never to the commit. The trailer is an immutable pointer; the database holds everything that can change.
6. Stop and emit `blocked_on_human` for any task with `humanGate.required`, and do not start its children.

Trace derives manifest status from `events.jsonl` and git, so the orchestrator never edits `manifest.json` directly.

## Human gates

A task is gated if either is true:

- Tagged: any linked PRD or spec section contains `<!-- human -->`.
- Detected: the task's planned or actual diff touches configured high-trust paths.

Default high-trust patterns in `.trace/config.json`:

```json
{
  "humanPaths": [
    "**/migrations/**",
    "**/auth/**",
    "**/payments/**",
    "infra/**",
    "*.sql",
    ".github/workflows/**"
  ]
}
```

Detection runs twice: at plan time against declared files, and post-commit against the actual diff. A post-commit hit on an ungated task flips it to `blocked_on_human`.

Planner rule: gated tasks go at the bottom of the stack, so the human reviews them before dependent branches land.

## Redaction

Before writing session JSONL, strip values matching env var names from `.env*`, common token patterns (API keys, bearer tokens, private keys), and anything in a user-supplied deny list. Log redaction counts per file. Fail closed: if redaction errors, do not write the session.

## Viewer

Local web app served by `trace serve`, read-only, polling or file-watching `.trace/` and git.

Layout:

- Left column: rendered `prd.md`. Each section shows a status badge rolled up from its tasks.
- Middle column: rendered `spec.md` with the same badges.
- Right column: the stack as nodes ordered bottom to top, with branch name, model, status, and a human-gate marker.
- Curves: SVG bezier curves linking PRD section to spec section to task node. Hovering any node highlights its full chain.
- Task detail panel: commits with links to diffs, session files, events timeline, and gate reasons.

Suggested stack: Foldkit SPA for the viewer, a markdown renderer that preserves heading IDs, and a tiny Node server exposing `.trace/` files and `git log --format` with trailers, plus reads from `trace.db`.

## Implementation in Effect

The CLI and local server are written in Effect, so every side effect is a typed service that tests can swap out.

- Schemas: manifest, events, config, and commit trailers are Effect Schema definitions. Every file read from `.trace/` is decoded through them, and failures are typed errors naming the bad field.
- Services as Layers: `Git` (branches, log, trailers), `TraceStore` (`trace.db`), `Planner` (model calls), `Orchestrator` (adapter to the user's runner), `Redactor`, and `Clock`.
- Composition: one composition root per entrypoint (CLI, server). Live Layers in production; test Layers (fake git, in-memory SQLite, scripted planner) in tests.
- Tests: `@effect/vitest` with `it.effect` and `it.layer`. Status derivation, gate detection, and lint run against test Layers with no real repo.
- Viewer: Foldkit. Interaction logic (selection, chain highlighting, drawer state) lives in the pure update function and is unit tested without a render loop. Rendering only draws.

## Contract package

`@spectrace/contract` is the single source of truth for everything an orchestrator reads or writes, and it must work from plain JavaScript.

- Effect Schema definitions for manifest, events, config, and trailers.
- Generated JSON Schema files, so any language can validate `.trace/` files.
- Plain JS entry points: `parseManifest(json)`, `parseEvent(line)`, `formatTrailers(task)`. Each returns a result or throws an error naming the bad field. Callers need no Effect knowledge.
- Shipped `.d.ts` types, so JS users get editor autocomplete and checked JSDoc.
- A `version` field on every file, with migrations in the package, so old manifests keep loading.

Adapters for Claude subagents, Pi, and plain shell scripts import only this package.

## Acceptance criteria

- Running `trace init`, `trace plan`, and the orchestrator on a real RinkSide feature produces a manifest with at least three stacked tasks.
- Every commit on those branches has Trace trailers, including a `Trace-Session` ID that resolves to a redacted session in `trace.db`.
- A task touching a migrations path is gated and its children do not start until it is approved.
- The viewer shows correct status for every PRD section, and clicking a PRD section reaches its commits in two clicks or fewer.
- `trace lint` catches an orphaned section ID and an unmapped PRD section.

## One-day build order

1. Section ID parser and `trace ids` (1h).
2. Manifest schema, `trace plan` prompt, and `trace lint` (2h).
3. Orchestrator contract: events, trailers, session IDs in `trace.db`, redaction (2h).
4. Status derivation from events and git (1h).
5. Viewer: three columns, badges, curves, detail panel (3h).
6. Dogfood on one RinkSide feature and fix what breaks (1h).

## v2: diverging state

v2 lets humans and agents change the PRD and statuses at the same time, and keeps work correct when the PRD moves mid-stack. Each kind of state gets the strategy that fits it.

| State                  | Strategy                                 | Why                                                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| PRD and spec prose     | Loro CRDT                                | Human and agent edits land concurrently and must merge without conflicts |
| Section IDs            | Loro marks on the text                   | IDs must survive concurrent edits around them                            |
| Task status and leases | LWW register with a hybrid logical clock | One writer per task (the orchestrator), so a CRDT is overkill            |
| Events                 | Append-only log                          | Nothing to merge                                                         |

Yjs stays an option for the editor if Loro's bindings fall short. Strategies can coexist per field.

### Versioning and branching

- Every PRD change is a Loro version. The manifest records `prdVersion`, the version it was planned from.
- Draft PRD changes happen on a Loro fork and merge back when approved, mirroring how the stack works in git.

### Rebase flow

When the PRD head moves past `manifest.prdVersion`:

1. Diff the two versions by section ID: changed, added, removed.
2. Mark linked tasks `stale` (new status) and show their chains as stale in the viewer.
3. Re-plan tasks that have not started.
4. For landed tasks, create follow-up tasks instead of rewriting history.
5. Restack only the affected branches and their dependents. Untouched branches keep their commits.
6. Update `prdVersion` once the stack is consistent.

### v2 acceptance criteria

- A human editing a section while an agent writes its status loses neither change.
- Editing one PRD section mid-stack marks only that section's chain stale.
- A rebase restacks only the affected branches.

## v2: multiplayer on Cloudflare

A feature's PRD, spec, and stack live in a shared room. Humans and agents see each other's cursors and every change as it happens. Git and code stay on each machine; the room holds the document, statuses, and presence.

### Architecture

- One Durable Object per room (one feature). It holds the Loro document, applies updates, and fans them out over hibernatable WebSockets.
- Storage: Durable Object SQLite for updates and snapshots. R2 for version snapshots and opt-in redacted sessions.
- Single writer for LWW state: statuses and leases are written through the room's Durable Object, which serializes them.
- Local bridge: `trace connect` links a repo's `.trace/` to a room. It pushes events, commit SHAs, and session IDs, and pulls PRD and spec edits back to markdown on disk.
- Offline: the viewer still works on local files. Loro merges edits made while disconnected.
- Deploy: Worker, Durable Object namespace, R2 bucket, and the Foldkit site, all defined in Alchemy. Room tokens live in each room's storage, so no signing key is needed yet. Model keys never reach the server.

### Presence

Presence is ephemeral and never persisted. Each participant broadcasts:

```json
{
  "actorId": "agent:t2",
  "kind": "agent",
  "name": "sonnet · 02-api",
  "cursor": { "sectionId": "spec.persist.api", "anchor": "loro-cursor" },
  "focus": { "taskId": "t2", "file": "src/api/views.ts" },
  "state": "editing",
  "heartbeatAt": 1763766000
}
```

- Humans: a text caret and selection in the PRD and spec, plus a pointer on the canvas.
- Agents: a labeled caret on the section they work from, a pulse on their stack node, and the file they are in. Agent presence comes from orchestrator events, so agents need no browser.
- Heartbeats: every 5 s. Three missed marks the actor away. For an agent, its task goes `stalled` (new status) and its lease is released.

### Permissions

- Each room has one token: a plain string assigned when the room is created. Anyone with it can join.
- Clients declare whether they are a human or an agent. Gate approvals are only accepted from human clients and record who approved.
- This is trust-based and fine for v2. Signed, scoped tokens come later.

### Multiplayer acceptance criteria

- Two humans and one agent see each other's cursors and edits in under 250 ms p95 within one region.
- Killing an agent process marks it away and stalls its task within 15 s.
- A gate approval from an agent client is rejected.
- Clients that edit offline converge on reconnect with no lost edits, property tested with random edits and partitions.
- `alchemy deploy` brings up a working room from an empty Cloudflare account.

## Later

- Rich editing beyond markdown: embeds, comments, and inline diffs.
- An inbox view of agent activity across rooms.
- Drift detection that flags or proposes spec updates when code diverges.
- Cost per section and per model.
- Adapters for Vercel Board and other agent message boards.
