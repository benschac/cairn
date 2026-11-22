# Apply Ratstack to Cairn

Ratstack is the reference for Cairn's stack: Cloudflare, Alchemy, Foldkit and Effect, with XState machines and Effect Schema. The root [AGENTS.md](../../AGENTS.md) says to read <https://ratstack.sh/llms.txt> before building anything, take the piece the task needs and leave the rest, and not copy rat-stack. This directory holds that guide, the full corpus and the `rat-stack-mode` skill offline. AGENTS.md wins wherever they differ.

## Start a change

1. Read [the agent guide](guide.txt) through [its index](guide-index.md). It is short; it names the playbooks, the MCP tools and the lore.
2. Read the [pinned router](source/skills/rat-stack-mode/SKILL.md), then each principle that bears on the task from its `principles/` directory.
3. Find the matching playbooks in [the corpus index](index.md) and read only their line ranges of `docs.txt`. Resolve website paths such as `/lore/...` against `https://ratstack.sh`. Load skills for the task by reading them; do not install copies into `.agents/skills`, `.claude/skills` or a global skill directory.
4. Read the owning Cairn code before the example: the package's tests, its `package.json`, `pnpm-workspace.yaml` (the catalog pins Effect, XState and `@xstate/effect`) and the installed declarations under `node_modules`. Name the input and output shapes, the store that is authoritative, and the one writer, before changing data.
5. Verify with `pnpm check` and the smallest test that can fail. Report which Ratstack rules shaped the change and anything left unverified.

For a new action, use `add-a-capability`; for persistence, `add-a-store`; for retries, cancellation or state transitions, `add-a-lifecycle-machine` and the durability guidance; `uncomplect` for responsibility boundaries, `investigate-a-failure` for bugs, `test-behaviour` for tests. For infrastructure, `learn-alchemy`.

## Map it onto Cairn

| Ratstack piece                                          | Where it lands in Cairn                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect Schemas shared by every surface                  | `packages/contract`. Do not redeclare a contract type elsewhere.                                                                                        |
| Lifecycle machines (`setupEffect`)                      | `packages/core`. Context and events are contract schemas; see the [XState](../xstate/index.md) and [@xstate/effect](../xstate-effect/index.md) indexes. |
| Foldkit app (Model, Messages, `update`, `view`, Scenes) | `apps/viewer`.                                                                                                                                          |
| Alchemy stack on Cloudflare                             | `apps/site` (`alchemy.run.ts`). Deploying needs the owner's credentials.                                                                                |
| Local process, services, CLIs                           | `packages/cli` and the Effect scripts under `scripts/`.                                                                                                 |
| Ports and adapters                                      | `adapters`, listed in VISION.md; add it when a real external boundary needs it, not before.                                                             |

- Keep domain operations independent of transport and storage. Add a port and adapter only at a real external boundary.
- When two surfaces expose the same action, share its input, output, errors and implementation; keep handlers thin.
- Validate external data with a contract schema at entry and before a durable write. Name who owns startup, shutdown, cancellation, retries and failure reporting.
- A rule worth keeping becomes a type, a lint rule or a test that `pnpm check` runs. A sentence in a doc, or an installed dependency, does not prove the code follows it.

## Keep the project contract

Use pnpm, plain `node` for scripts, and the checks in `pnpm check`. Map an upstream command to a Cairn script instead of running it. Do not copy rat-stack's packages, lint rules or apps wholesale; take the piece the task needs. Never weaken a check, a lint rule or `lefthook.yml` to match an upstream example (see AGENTS.md).

Ratstack tracks Effect 4, XState 6 and `@xstate/effect` betas, which change quickly. Check the installed declarations before trusting an example's signature; the snapshots here are unversioned.

Deploying, production writes, credentials and upstream autonomy rules or model rosters grant no authority here. Nothing deploys on commit.

## Locate and refresh references

- `guide.txt` (`llms.txt`) and `docs.txt` (`llms-full.txt`) are website snapshots with generated indexes. [sources.json](../sources.json) records their URL, retrieval time and SHA-256. Refresh both with `node scripts/agent-sources/refresh-pattern-sources.ts` from the repository root; it downloads only when run, and writes nothing unless both documents parse. To import earlier downloads, pass `--from-dir DIR --fetched-at ISO_TIMESTAMP`, where DIR holds `ratstack-llms.txt` and `ratstack-full.txt`. Review the documents, indexes and `sources.json` together.
- `source/` holds the upstream `LICENSE` and the whole `skills/rat-stack-mode/` directory, principles included. [manifest.json](source/manifest.json) records the revision, archive URL and the SHA-256 of every file. It is reference data, not an installed skill.
- `../github.com/joelhooks/rat-stack/` is a full clone of the repository (untracked) for package source, lint rules, the other skills (`skills/add-a-capability`, `skills/learn-alchemy`, ...) and apps. Search it by path, for example `rg -n 'setupEffect' .agent_sources/github.com/joelhooks/rat-stack/packages`, and read the files before relying on their behaviour. Record its revision (`git -C .agent_sources/github.com/joelhooks/rat-stack rev-parse HEAD`) when you cite it. If the clone is missing, report the missing evidence rather than reconstructing source from prose.

To move `source/` to a new revision, copy `LICENSE` and `skills/rat-stack-mode/` from that commit, remove files it no longer has, and regenerate `manifest.json` with the repository, full revision, retrieval time, archive URL, scope and each file's SHA-256. The website refresh does not touch it.
