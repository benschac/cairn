# Launch readiness: self-hosted and managed prdddd

Audited 2026-11-25 at checkout `5b69891`. This records findings and a proposed
launch sequence; it does not change the accepted PRD, spec, manifest, pricing,
license or deployment. Cairn is the working name; the README names the release
product prdddd and its intended domain prdddd.com.

## Product outcome

A stranger can create or import a PRD, discuss it with collaborators, connect
their own agents and repository, follow implementation evidence, and share a
public view. A workspace owns multiple PRDs. Private work remains private.
The product can run in a user's own deployment or in the managed service.

Public PRDs must be useful before a spec, manifest, repository connection or
agent run exists. Someone collecting feedback on an idea should not need to
generate an implementation plan just to publish the idea. The existing trace
reader becomes the implementation view within this wider product.

## Verified implementation and gaps

| Area                    | Evidence in this checkout                                                                                                                                       | What remains                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry points        | `packages/cli/src/main.ts` exposes init, ids, link, lint, plan, status, serve and approve; confirmed with `pnpm cairn --help`.                                  | New-user distribution and instructions; connect, notes, MCP and other advertised future commands are not registered.                                                        |
| Planning                | `packages/cli/src/commands/plan.ts` generates spec/tasks, asks before proceeding and writing the manifest, supports dry runs and incremental planning.          | The judging checkpoint function at lines 210-221 is a seam with no judging execution. Keep human confirmation and model judging distinct.                                   |
| Viewer                  | Reader, search, stacks, task detail, diff/session rendering and typed deep links exist under `apps/viewer/src`.                                                 | Workspace navigation, empty states, import/create PRD, document discussion and sharing UI.                                                                                  |
| Production viewer       | `apps/viewer/src/load.ts:51-55` classifies every production build as the demo. Production skips live trace polling and patch/session requests.                  | Explicit demo/local/hosted mode selection. Test the built artifact against a customer fixture, not only development mode.                                                   |
| Local live data         | `/api/trace`, diff, commit and session routes exist in `packages/cli/src/api.ts`; development polls trace data with ETags.                                      | Resource-scoped hosted routes with authorization; this local server is not an authenticated team server.                                                                    |
| Multiple PRDs           | `packages/cli/src/workspace.ts` loads fixed `.cairn/prd.md`, `spec.md`, `manifest.json` paths. `packages/contract/src/trace.ts` represents one feature trace.   | Workspace and document identity around each trace; local mapping of multiple documents without silently reinterpreting old files.                                           |
| Links                   | `packages/contract/src/link.ts` models sections, passages, tasks, stacks, diffs, commits, sessions and note IDs.                                                | Workspace/document scope and revision addressing. IDs such as t1 are only unique within a PRD. Complete copy/history behavior.                                              |
| Discussion              | Session notes can render, but `apps/viewer/src/links.ts` reports that notes are not stored yet; `packages/cli/src/api.ts:137-141` supplies empty session notes. | Persistent threads/replies, authorship, anchors, resolution, permissions and notifications.                                                                                 |
| Revisions               | Contract `version` fields identify file formats; the manifest lacks a PRD content revision.                                                                     | Immutable content revisions, source revision on plans, readable history and explicit published revisions.                                                                   |
| Presence                | Local `/presence` and an in-process room machine exist. Participant kind is supplied by the client.                                                             | Authenticated humans/agents, scoped credentials, durable rooms, reconnect/resync and revocation. Presence is not authorization or execution.                                |
| Sessions                | Local SQLite store and first migration exist. It accepts logs described as already redacted.                                                                    | Complete redaction/ingestion and orchestrator integration before automatically sharing agent transcripts. Do not confuse a redaction count field with a redaction pipeline. |
| Hosted infrastructure   | `apps/site/alchemy.run.ts` declares the demo website and AI Gateway.                                                                                            | Worker API, Better Auth, membership/invites, D1, Durable Objects, R2 and outbound email for the team service.                                                               |
| Distribution            | CLI, core and contract packages are private version 0.0.0; CLI points at source. `serve.ts:26-28` finds assets through the monorepo layout.                     | Versioned portable artifact, included viewer assets, clean-install smoke test and release pipeline.                                                                         |
| Operations and commerce | CI checks code and deploys the demo. No application billing, customer portal or hosted operational runbook found.                                               | Billing/entitlements, backup/restore, export/deletion, limits, observability and support.                                                                                   |
| Launch surface          | README documents the product name and licensing but no quickstart. HTML/deploy still use Cairn/prdtrace.                                                        | Landing page, onboarding, docs, pricing, share previews and consistent public identity.                                                                                     |

## Existing plan versus the new launch

The manifest contains 187 tasks: 97 marked done, 2 landed, 88 pending.
`pnpm tasks` also identified 9 tasks with main-branch trailers whose manifest
status is still pending. Its remote fetch, GitHub and board reads failed in
this sandbox, so its claims/remote status are not a fresh remote inventory.
Completion percentages are not a launch readiness measure.

Relevant existing task groups include notes (`t126`, `t170`), redaction/session
ingestion (`t1`, `t3`, `t37`, `t38`), links (`t122`-`t125`), documentation
(`t161`-`t164`) and shared agent operations/MCP (`t174`-`t182`). Existing local
worktrees claim some planner work; do not overwrite it or create duplicate
tasks without a successful coordination refresh.

The PRD's v2 multiplayer section already proposes Durable Objects, Loro,
Better Auth and a local bridge. Its shared room token model explicitly defers
per-room membership and scoped tokens. That is insufficient for the proposed
hosted private-workspace product and must be superseded, not treated as the
launch security model. VISION.md's v1 exclusions also need a deliberate update.

## Proposed product and deployment boundaries

- Workspace owns members, invitations, repository connections and multiple PRDs.
- A PRD owns revisions, discussion, generated plans and implementation evidence.
- One per-PRD collaboration authority preserves the existing trace boundary.
- Agents have authenticated identities and delegated scopes; credentials cannot
  become human identities by changing a request field.
- Public publication is an explicit server-produced view. Publishing a PRD
  does not publish its code, agent sessions, internal discussion or revision history.
- Authorization answers what an actor may do. Commercial entitlements answer
  what capacity/features a hosted workspace purchased. Keep these separate.

Use one product codebase for managed and user-owned deployments. Recommend
supporting deployment to the user's own Cloudflare account first because it
can reuse the managed infrastructure. Describe it explicitly as Cloudflare
self-hosting. A provider-independent Docker/VPS distribution is another
runtime/storage target and should not be promised until verified.

Local single-user CLI use remains useful but is not equivalent to a self-hosted
team service. The latter needs the same membership and data-isolation behavior
as managed hosting, configurable domain/provider bindings, and operator docs.

## Proposed commercial shape, not committed pricing

| Offering    | Purpose                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted | Core PRD, private/public document and collaboration functionality in the user's deployment; operator supplies infrastructure and provider configuration. |
| Hosted free | A low-friction way to create and share public PRDs with explicit usage limits. Whether to include a small private allowance remains a product choice.    |
| Hosted paid | Private/team workspace capacity, increased limits, managed operation and support. Start with one simple workspace plan.                                  |

Do not count ephemeral agent sessions as human seats by default. Start with
users' local agents and existing model credentials; any provider charges remain
separate from the hosted subscription. Cloud-executed agents or included AI
credits introduce another cost and isolation boundary and can follow later.

See [hosted services research](hosted-services.md) for official sources and
integration uncertainties. Better Auth organization membership fits the
workspace model; Cairn still needs resource authorization. Stripe Checkout and
the customer portal are candidates for managed billing. Exact integration APIs
must be checked against the installed Alchemy version before implementation.

## Build sequence and exit criteria

### 1. Make the existing product usable from a release

Separate demo and real production modes; package CLI dependencies and viewer
assets; document prerequisites and a fresh-repository quickstart. Verify the
core planning path and make incomplete commands/features explicit.

Exit: install the release outside the Cairn checkout, initialize a fresh repo,
plan with a supported provider, serve the user's own PRD, follow a deep link,
restart and retain the project. Never silently fall back to Cairn's demo.

### 2. Build the shared PRD product

Add workspace/document schemas, sign-in, membership/invites, multiple PRDs,
create/import/export, persistent comments and document revisions. Support
public PRDs without generated implementation artifacts. Fixed workspace and
document roles are sufficient initially. Add the new shell around the reader.

Exit: two people can collaborate on their own PRD; another workspace cannot
discover or read it. A user can revoke access, including an existing socket,
and retain revision/comment history through restart. Basic browser editing or
revision upload must work without requiring every feedback participant to use git.

### 3. Connect execution and sharing

Add the authenticated local bridge, agent credentials, live status and
revision-bound planning/approvals. Establish one authoritative write path for
documents so local markdown and hosted revisions do not silently overwrite
each other. Begin with explicit sync/conflict handling; simultaneous offline
text merging can be a later milestone if necessary.

Add explicit public publication, stable URLs, useful social metadata and a
signed-in feedback path. Start with whole-document publication; selected-section
publication follows through a filtered representation, not access to raw private
document/CRDT state. Keep code and session permissions independent.

Exit: a local agent's work updates the correct hosted PRD; revoked credentials
stop working; a public link is readable signed out; private adjacent resources,
history, comments and session content remain inaccessible. Existing published
revisions do not change unexpectedly when private drafts change.

### 4. Operate and sell the service

Provision production resources and email; add one paid workspace plan, billing
management, durable webhook processing, limits and an explicit downgrade policy.
Exercise backups/restoration, export/deletion and abuse/rate limits. Publish the
managed service and own-Cloudflare deployment guide with the same release.

Exit: Stripe test-mode signup, renewal failure, cancellation and duplicate or
out-of-order webhook delivery produce the intended access; payment failure never
publishes or silently deletes private work. A fresh operator deploys in their
own account and restores a backup. Users complete onboarding without the owner.

### 5. Launch the demonstrated promise

Prepare a product explanation, example public PRD, screenshots/demo, pricing,
support path and service policies. Align prdddd branding/domain. Resolve the
README's active-signing description against CONTRIBUTING.md's explicit draft,
inactive CLA status; the existing licensing documents remain authoritative.

Recommend a small external pilot before the Product Hunt announcement. Launch
after strangers complete the journey unaided, with both self-hosting and paid
hosting available if those are the advertised promises. Do not wait for every
model-routing experiment, terminal view or advanced analytics task in the old
manifest. Do not market automated execution until its adapter path is proven.

## Validation performed for this audit

- Inspected owning CLI, viewer, contract, persistence, deploy and release sources;
  bounded independent audits covered viewer and release concerns.
- `pnpm cairn --help`: passed; confirmed eight registered commands.
- Existing init and scripted-plan tests: 20 passed. These do not prove model quality.
- Existing API tests: 11 passed after rerunning outside the sandbox, which
  initially denied loopback listening with EPERM.
- No live provider run, production deployment, payment or fresh-account
  self-host exercise was performed. Full `pnpm check` was not run for this
  documentation-only audit; it remains an implementation/release gate.

## Decisions to settle before implementation

These do not block the gap assessment: choose the supported self-host target;
decide whether hosted free includes private PRDs; define whether private means
all workspace members or selected members; choose public versus unlisted
publication and guest feedback rules; decide the initial paid limits and
downgrade behavior. Defaults above are proposals, not accepted requirements.
