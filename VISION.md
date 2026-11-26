# Cairn — Vision

## What it is

Cairn is a shared workspace for building from PRDs. People write and discuss
intent, turn it into a spec and a stack of branches for agents to build, and
share progress. Each PRD section traces to its commits and the agent session
that wrote them. A PRD is useful before it has code or a generated plan.

## Who it is for

Product managers, engineers and their collaborators, starting with engineers
running agent-heavy, stacked-diff workflows. RinkSide is the dogfood project.
The product launches as prdddd: hosted signup is the primary experience, with
open source and self-hosting available for people who want to operate it.

## What has to work first

Someone signs up, creates a workspace and PRDs, invites members or document
guests, discusses the work, follows agent progress and shares a public PRD or
keeps it private. Launch includes whole-document permissions, comments,
PRD-to-PRD links, basic revision history and restore, and paid workspace plans
with clear seat and document limits.

`cairn plan` remains the implementation path: one command turns a PRD into a
spec and a stack I'd approve, with every task linked to a PRD section and the
risky ones gated. The PRD's Hosted launch section defines the release gates.

## Presence, from the first step

Cairn is multiplayer. A participant can be a human or an agent. Launch includes
presence, durable discussion and live agent progress. Basic document saves
detect conflicts and preserve drafts. Simultaneous text editing and automatic
offline merging can follow without blocking useful collaboration.

## What it is not

- Not a rich block editor; basic markdown editing is enough for launch.
- Not an orchestrator.
- Not a task manager.
- No agent chat or cloud-hosted agent execution in v1.
- No section-level or revision-specific sharing in v1. Guests receive access
  to whole PRDs; comments inherit the document's visibility.
- No Google Docs-style visual history or simultaneous text editing in v1.
- Small features skip it.

## How I'll know it's working

- I start real RinkSide features from a PRD, not the terminal.
- Any PRD section reaches its diff and its session in two clicks or fewer.
- Migrations always stop for my approval.
- Someone else runs it on their own repo.
- Someone signs up without a checkout, shares their own PRD and gets feedback.
- A guest can read one invited PRD without seeing other private workspace data.
- I build a Cairn feature with Cairn: its own PRD, spec and stack go through `cairn plan`.

## Stack and deploy

The primary product is a hosted Cloudflare application, provisioned with
Alchemy. Effect supplies the core, policy services and CLI; Foldkit supplies the
workspace and reader. Shared D1 holds accounts, membership and the PRD directory;
each PRD's Durable Object owns its revisions, discussion and events, with R2 for
attachments and large snapshots. The current deployment is still the demo;
these hosted capabilities are the launch target.

The CLI and local viewer connect repositories and agents to the workspace and
remain useful independently. A supported self-hosted team deployment uses the
same product and permission model in the operator's own Cloudflare account.
Operating the managed service is a paid option; public/private capacity and
member seats are plan dimensions, separate from document authorization.

Model API keys come from the user's own environment and are never stored.
Redaction keeps them out of session logs.

Alchemy Domain (`@alchemy.run/domain`) is something we are very interested in:
it models a domain as commands, aggregates and events, and builds each piece as
its own layer. We intend to use it to assemble our infrastructure.

People using the managed service need no deployment or Cloudflare account.
Local previews and tunnels remain development options, not the hosted signup
experience or a substitute for authenticated team access.

## State machines

A task's lifecycle is the core machine: `pending`, `running`,
`blocked_on_human`, `done`, `landed`, and `stale` in v2. Gate approval, an
orchestrator run and the v2 rebase flow are machines too.

Machines use XState v6 beta with `@xstate/effect`. Machine context and events
are defined as Effect Schema, the same schemas the contract package exports. One
set of types covers files, machines and the viewer.

Schemas cross into XState as Standard Schema. `@xstate/effect` does that
conversion, so a machine takes the contract's Effect Schemas directly.

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
