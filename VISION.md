# Cairn — Vision

## What it is

Cairn turns a markdown PRD into a spec and a stack of branches for agents to build.
Each PRD section traces to its commits and the agent session that wrote them.

## Who it is for

Me first, on RinkSide. Then open source, mostly for product managers and
engineers, starting with engineers running agent-heavy, stacked-diff workflows.

## What has to work first

`cairn plan`: one command turns a PRD into a spec and a stack I'd approve, with
every task linked to a PRD section and the risky ones gated.

## What it is not

- Not an editor.
- Not an orchestrator.
- Not a task manager.
- No agent chat, no hosting, and no multiple users in v1.
- Small features skip it.

## How I'll know it's working

- I start real RinkSide features from a PRD, not the terminal.
- Any PRD section reaches its diff and its session in two clicks or fewer.
- Migrations always stop for my approval.
- Someone else runs it on their own repo.
- I build a Cairn feature with Cairn: its own PRD, spec and stack go through `cairn plan`.

## Stack and deploy

Cairn runs on your machine, so the main release is an npm package (the CLI plus
the local viewer), not a Cloudflare app. It is still a CAFE stack: Effect for
the core and CLI, Foldkit for the viewer. Cloudflare plus Alchemy only hosts the
docs and demo site for now, and a hosted team layer later if it ever happens.

Model API keys come from the user's own environment and are never stored.
Redaction keeps them out of session logs.

## State machines

A task's lifecycle is the core machine: `pending`, `running`,
`blocked_on_human`, `done`, `landed`, and `stale` in v2. Gate approval, an
orchestrator run and the v2 rebase flow are machines too.

Machines use XState v6 beta with `@xstate/effect`. Machine context and events
are defined as Effect Schema, the same schemas the contract package exports. One
set of types covers files, machines and the viewer.

## Verification and testing

- **TLA+** for the parts where concurrency can go wrong: no child task starts
  before its gated parent is approved, statuses always converge, and a rebase
  only touches the affected chain.
- **Property-based tests:** section IDs round-trip, `ids` is idempotent, and
  status derivation gives the same result whatever order events arrive in.
- **Model-based tests:** generated from the task machine.
- **Mutation testing:** on gate detection, status derivation and redaction,
  since those are the parts where a silent bug costs you.

## Repo and builds

A public open source monorepo, run with Turborepo:

- `contract`
- `core`
- `cli`
- `viewer`
- `adapters` (Claude subagents, Pi)
- `site`
