# Hosted services research

Checked 2026-11-25 against primary documentation. This is a launch proposal, not an implementation report. Current `VISION.md` explicitly excludes hosting, accounts, teams and permissions from v1; adopting this proposal changes that scope. `apps/site/package.json` currently pins Alchemy and its Cloudflare package to `2.0.0-beta.87`; current documentation still needs validation against that installed version before implementation.

## Recommended minimal shape

Use Better Auth for identity and organization membership; treat an organization as a Cairn workspace containing multiple PRDs. Use a Cloudflare Worker and D1 for the managed service, provisioned by Alchemy. Keep billing an optional hosted adapter using Stripe Checkout and the customer portal. Define a Cairn authorization service and storage interface shared by hosted and self-hosted distributions. These are recommendations, not features supplied automatically by those vendors.

Prefer a workspace subscription initially over seat metering: one paying owner, multiple human collaborators, and separately authorized agents. This avoids deciding whether an agent session is a billable seat before actual usage establishes the pricing model. Sell operated hosting, availability, storage and support; do not make basic self-hosted collaboration depend on a Stripe account.

## Identity, tenancy and sharing

**Verified:** Better Auth's organization plugin manages memberships, invitations and roles, including custom permission resources. It exposes server permission checks; its default permissions cover organization administration, members and invitations. These primitives fit workspaces, but do not themselves define Cairn document sharing. [Organization documentation](https://better-auth.com/docs/plugins/organization)

**Recommended:** Give every PRD, revision, discussion and agent credential an explicit workspace owner. Check membership plus the requested action on the server for reads, writes and WebSocket joins. Treat public read access as an explicit document policy, separate from organization membership. Public visibility must not publish session logs, repository secrets or neighboring private documents. Keep write access authenticated. An agent credential should be revocable, workspace/document scoped and attributable to its issuing human; an agent presence label is not authorization.

**Unresolved:** Decide whether “private” means workspace members only or selected members, whether public means indexed or unlisted, and whether guests may comment. Those choices change schema and authorization tests. Organization roles alone are insufficient for per-document exceptions; avoid promising such exceptions until designed.

## D1 and Alchemy fit

**Verified:** Better Auth's 1.5 release documentation describes direct D1 binding support, using D1 batches rather than interactive transactions. Its general relational-adapter page also still lists a community Kysely D1 dialect. Validate the selected Better Auth release and migration path rather than mixing examples from different versions. [First-party release source](https://github.com/better-auth/better-auth/blob/main/docs/content/blogs/1-5.mdx), [adapter documentation](https://better-auth.com/docs/adapters/other-relational-databases)

**Verified:** Current Alchemy documentation supports declaring D1, migrations and Worker query bindings, with a native binding escape hatch for libraries such as Better Auth. This makes the infrastructure compatible in principle; it does not establish that Cairn's pinned release already exposes the same API. [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)

**Recommended:** Begin with one tenant-keyed database and indexed workspace/document queries. Before choosing transaction boundaries, prove invitation acceptance, membership changes, revision writes and webhook deduplication against D1. Keep concurrent collaboration ordering a separate design decision; do not assume an SQL database alone provides a room protocol.

## Billing and access

**Verified:** Better Auth offers a Stripe plugin with subscription lifecycle handling, signature verification, organization references and seat support. It is an integration candidate, not a reason to couple the whole domain to authentication tables. [Better Auth Stripe plugin](https://better-auth.com/docs/plugins/stripe)

**Verified:** Stripe subscriptions change asynchronously, including payment failures, cancellation and entitlement updates. Stripe documents `entitlements.active_entitlement_summary.updated` as a provisioning signal; applications still need to apply their access policy. [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)

**Verified:** Webhook delivery can repeat and arrive out of order. Verify signatures using the original request body, deduplicate events by ID, and reconcile current objects when needed. Do not infer ordering from event timestamps. [Webhook documentation](https://docs.stripe.com/webhooks)

**Verified:** Stripe's hosted customer portal supports payment details, invoices and subscription management, including cancellation. [Customer portal](https://docs.stripe.com/customer-management)

**Recommended:** Map one Stripe customer/subscription to a workspace; authorize checkout and portal creation against its billing-owner permission. Store a local billing projection and enforce entitlements on the server. A checkout success redirect must not grant service by itself. Make event processing durable and retryable, with reconciliation for missed events. Decide grace periods and downgrade behavior explicitly; preserve customer data and export access rather than deleting data when payment fails. Test duplicate/out-of-order events, owner changes, cancellation at period end and recovery after failed payment. Inspect the plugin's exact guarantees before adding duplicate webhook machinery.

## Cost boundary

**Verified:** Workers Free has daily request and per-invocation CPU limits. Paid adds an account minimum and usage charges; static asset requests are generally free, with the documented Workers Caching exception. A static demo's cost does not establish a hosted collaboration service's cost. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

**Verified:** D1 meters rows read/written and storage; scans count even when few rows are returned. Free read/write limits cause query failures until reset, and its storage limit blocks further growth. Paid overages are billed. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

**Verified:** SQLite-backed Durable Objects are available on Free and Paid; Free operations fail above limits. Duration is billable when an object remains active or cannot hibernate, so persistent room design affects cost. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

**Recommended:** Use free allowances for development and pilots; budget the paid managed service from measured traffic, database operations and collaboration duration. Include email, attachments, logs, backups, Stripe charges and any model calls separately. “Open source” does not imply free infrastructure or free model inference. Do not promise unlimited hosted usage before measuring these dimensions.

## What self-hosting must mean

**Verified:** Cloudflare publishes the `workerd` runtime as open source; Better Auth supports local SQLite drivers. These are useful building blocks, not proof that Cairn's entire Cloudflare-backed service runs unchanged on a VPS. [workerd](https://github.com/cloudflare/workerd), [Better Auth SQLite](https://better-auth.com/docs/adapters/sqlite)

**Recommended:** Distinguish two supported deployment promises: deployment to the user's own Cloudflare account, and a standalone server with persistent SQLite plus a local room implementation. The first can reuse infrastructure but still depends on Cloudflare. The second requires runtime/storage adapters and an end-to-end packaged deployment. Promise only the modes actually tested. Self-host operators own upgrades, TLS, backups, authentication configuration and recovery; managed subscribers pay to have those operated for them.

Before launch, demonstrate two users and an agent collaborating in separate workspaces, deny cross-workspace access, exercise public/private transitions, revoke agent access on an existing connection, restore a backup, and complete subscription/cancellation flows in Stripe test mode. None of those checks were run in this documentation-only research task.
