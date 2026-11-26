# Licensing plan and audit

This file records how Cairn is licensed, the audit behind it, how the
Contributor License Agreement (CLA) will be enforced, and what the maintainer
still has to decide or set up. It was prepared on 2026-11-25 and is not legal
advice. Items marked **Legal review** need a lawyer.

## The model

| Layer                    | Terms                                                                      | Status                                  |
| ------------------------ | -------------------------------------------------------------------------- | --------------------------------------- |
| Community edition        | `AGPL-3.0-only`, [LICENSE](LICENSE)                                        | In effect                               |
| Commercial license       | Negotiated case by case with the maintainer                                | Possible; nothing offered or priced yet |
| Enterprise functionality | May be proprietary later                                                   | Reserved; none exists                   |
| Contributions            | Accepted under the [CLA](CLA.md), which lets the maintainer relicense them | CLA drafted, pending legal review       |

The AGPL lets anyone use, change and sell Cairn. It does not forbid
competition. What it does is require anyone who distributes Cairn, or offers a
modified Cairn to users over a network, to give those users the source of
their version under the AGPL. A proprietary fork or a closed hosted service
built on Cairn's code is therefore not possible without a separate license.
No restriction beyond the AGPL is added anywhere in the repository.

**Names.** Cairn is the working name of the code in this repository. The
product will be released as prdddd, at prdddd.com. prdtrace.com hosts the
demo today and may later redirect to prdddd.com. The license and the CLA cover
the code under any of these names. The AGPL licenses copyright and patents,
not names, so "prdddd" and the domains stay the maintainer's.

**Cairn and what it produces.** The license covers Cairn's code. PRDs, specs,
manifests, branches and code that users write or generate with Cairn are
theirs, and the [README](README.md#license) says so. Two things would blur
that line, and neither happens today as far as this audit found:

- If Cairn copies its own files into a user's repository (templates, hooks,
  generated scaffolding), those copies are Cairn code under the AGPL. Before
  shipping such a feature, license those templates permissively or add an
  output exception (see [Open legal questions](#open-legal-questions)).
- If a user links Cairn's packages into their own program, that program is a
  combined work under the AGPL. Cairn's packages are `private` and not
  published, so nobody can do this yet; see [Package boundaries](#package-boundaries).

## Package boundaries

Every workspace package now declares `"license": "AGPL-3.0-only"`. No
exception has been applied. The table records which packages could later be
offered under Apache-2.0 so third-party integrations can depend on them
without taking on the AGPL; each needs the maintainer's approval first.

| Package           | Role                                                                                                                      | Recommendation                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@cairn/core`     | The machines: planning, linting, stacks, the room. The orchestration engine.                                              | AGPL-3.0-only                                                               |
| `@cairn/cli`      | The local process and the presence server.                                                                                | AGPL-3.0-only                                                               |
| `@cairn/viewer`   | The Effect UI viewer.                                                                                                     | AGPL-3.0-only                                                               |
| `@cairn/site`     | The Alchemy stack that deploys the demo to prdtrace.com.                                                                  | AGPL-3.0-only                                                               |
| `@cairn/contract` | The Effect Schemas every package shares: the PRD, spec, manifest and trace formats, and the presence protocol's messages. | **Apache-2.0 candidate**                                                    |
| `adapters`        | Planned in [VISION.md](VISION.md): the integration interfaces to agents and tools.                                        | **Apache-2.0 candidate** for its interface types; implementations stay AGPL |
| Public SDKs       | None exist yet.                                                                                                           | Apache-2.0 candidate when one is written                                    |

**Why `@cairn/contract`.** It is the one package an outside tool would import
to read or write Cairn's files or speak the presence protocol: an editor
plugin, a CI check, an agent harness. Its value is that other tools adopt the
formats; the engine that turns a PRD into a stack stays in `core` and `cli`.
Licensing it permissively gives a competitor schemas, not Cairn.

**Before splitting it:** review each module (it holds config, judgments,
task drafts, trailers and trace types besides the file formats) and move
anything engine-specific into `core`, add a
`packages/contract/LICENSE` with the Apache-2.0 text, set its `license`
field, and say in the README which packages are under which license. The
maintainer owns all of `contract`'s history (see
[Historical contributions](#historical-contributions)), so no one else needs
to agree.

## Dependency audit

From `pnpm licenses list -r` on 2026-11-25 (all workspace packages, including
development tools). Production dependencies show the same licenses.

| License           | Packages | Notes                                                                                                                                                            |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT               | 201      | Compatible.                                                                                                                                                      |
| Apache-2.0        | 27       | Compatible with AGPLv3 (one way: Apache code can be in an AGPL work). Includes Alchemy, workerd, sharp, TypeScript and `@pierre/*`. Alchemy ships a NOTICE file. |
| ISC               | 16       | Compatible.                                                                                                                                                      |
| BSD-3-Clause      | 3        | Compatible: `d3-ease`, `diff`, `source-map-js`.                                                                                                                  |
| BSD-2-Clause      | 1        | Compatible: `entities`.                                                                                                                                          |
| MIT OR Apache-2.0 | 2        | Compatible.                                                                                                                                                      |
| MPL-2.0           | 2        | `lightningcss`, a Vite build tool; not bundled into Cairn. Compatible in any case.                                                                               |
| LGPL-3.0-or-later | 1        | `@img/sharp-libvips`, pulled in by Alchemy's Cloudflare runtime for `@cairn/site` deploys only; not distributed with Cairn. Compatible.                          |

No dependency is GPL-only, AGPL, unlicensed or under a non-commercial or
field-of-use license. **Notice obligation:** `vite build` bundles the
viewer's dependencies into the files served from prdtrace.com, and MIT, BSD
and Apache-2.0 require their notices to travel with those copies. The build
does not collect them yet (see [Follow-up work](#follow-up-work)).

## Vendored and copied material

| Path                                                                             | What it is                                                               | License                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| `.agent_sources/ratstack/source/`                                                | rat-stack skill and principles, read by agents                           | MIT, Copyright (c) 2026 Joel Hooks |
| `.agent_sources/ratstack/source/skills/rat-stack-mode/`                          | Same, with a second notice                                               | MIT, Copyright (c) 2026 Lauren Tan |
| `.agent_sources/ratstack/guide.txt`, `docs.txt`                                  | Snapshots of ratstack.sh's `llms.txt` and `llms-full.txt`                | Not stated; see open questions     |
| `.agent_sources/effect/*`, `.agent_sources/xstate*`, `.agent_sources/*/index.md` | Indexes and checklists written for Cairn, pointing at installed packages | Cairn's own; AGPL                  |

The two rat-stack LICENSE files stay where they are, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) gives the notice for Effect UI
(`@effect/ui`, `@effect/ui-kit`; MIT, Copyright (c) 2023 Effectful Technologies Inc),
which the viewer bundles. No other source file in the repository carries a copyright
header or SPDX tag, and no fonts or images are committed. The design
prototypes in `.cairn/design/` and `apps/viewer/public/prototypes/` were
made for Cairn.

## Historical contributions

- All 328 commits on every branch are authored by the maintainer's account.
  Four were merged or squashed through the GitHub interface, which records
  GitHub as committer.
- All 157 pull requests were opened by the maintainer. The repository has one
  collaborator, the maintainer.
- 332 `Co-Authored-By` trailers name AI models (Claude Opus, Sonnet, Fable and
  Haiku, `noreply@anthropic.com`). No human co-author appears.

So no external contribution exists, and nobody else's permission is needed to
relicense the current code. The CLA is not retroactive: if someone else's
work is ever merged before they sign, get their written agreement before
relying on it to relicense. **Legal review:** AI-generated portions may have
thin or no copyright protection, which limits what the AGPL (or a commercial
license) can control in them; and the AI providers' terms on output ownership
should be confirmed for the plans used.

## CLA integration

### Evaluation

| Criterion                          | CLA Assistant (hosted app, cla-assistant.io)                                                                                                                                                   | CLA Assistant Lite (GitHub Action)                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Maintenance                        | Maintained by SAP: v2.13.2 released 2026-10-13, pushed 2026-11-05.                                                                                                                             | `contributor-assistant/github-action` is **archived**; last release 2024.     |
| GitHub permissions                 | App 128106: pull requests write, commit statuses write, gists write, emails read, metadata read, merge queues read. No contents access.                                                        | Needs `pull_request_target`, contents write and a token to a signatures repo. |
| Signature storage                  | SAP's Cosmos DB on Azure (Europe). CSV export from the dashboard.                                                                                                                              | A JSON file in a git repository.                                              |
| Individual and entity contributors | Individuals sign in the browser; custom fields capture capacity and entity. Entity agreements are handled outside the tool.                                                                    | Individuals only.                                                             |
| Versioning                         | The CLA is a Gist; each Gist revision is a version, and signatures record it. Changing the Gist asks everyone to sign again on their next PR.                                                  | Manual.                                                                       |
| Multiple contributors              | Checks the author (or committer) of every commit in the PR.                                                                                                                                    | Same.                                                                         |
| `Co-authored-by`                   | **Not checked**: its PR query reads only each commit's author and committer ([issue 1092](https://github.com/cla-assistant/cla-assistant/issues/1092)).                                        | Not checked.                                                                  |
| Forks                              | Works; it runs as an app on the base repository and never runs PR code.                                                                                                                        | Works only through `pull_request_target`.                                     |
| Branch protection, merge queue     | Reports `license/cla` as a commit status; supports `merge_group` (reinstall if the status never appears in a queue, [issue 1012](https://github.com/cla-assistant/cla-assistant/issues/1012)). | Partial.                                                                      |
| Cost and dependencies              | Free; depends on SAP running cla-assistant.io.                                                                                                                                                 | Free; runs in Actions.                                                        |

**Choice: the hosted CLA Assistant GitHub App.** It is the maintained option,
needs no workflow with secrets, and never executes contributor code. It meets
the requirements except for co-author detection and entity agreements, which
the procedures below cover. A custom bot is not justified. If SAP shuts the
service down, self-host the same code (Apache-2.0) or move to another tool;
the exported records keep their value.

### Signature records

Each CLA Assistant signature stores the GitHub user name and numeric id, the
Gist URL and the Gist revision accepted (an immutable hash of the agreement
text), the acceptance time, and the custom fields in
[.github/cla/metadata.json](.github/cla/metadata.json): name, email, capacity,
entity and the acceptance box, whose label names the agreement version.
Contributors cannot edit records; only the maintainer's dashboard can, and
signers can revoke their own. Names and emails stay in the service and the
exports, never in this public repository.

For durability, export the CSV for each agreement version after each batch of
signatures, and keep the exports, with the entity agreements, in private
storage the maintainer controls, append-only (never overwrite an old export).

### Agreement versions

- [CLA.md](CLA.md) is the source of the agreement and carries its version.
  The Gist holds the same text; its revision hash is what signers accept.
- To publish a version: change `CLA.md` and its version table in a commit,
  paste the exact text into the Gist (a new revision; never delete the Gist),
  update the version in `metadata.json` and in the Gist's `metadata` file,
  and export the old version's signatures first.
- Fixing a typo in the Gist also creates a revision and asks everyone to sign
  again, so batch changes.

## Enforcement

How the repository lands work matters here: the maintainer lands stacks with
`pnpm land`, which fast-forwards `main` with a push, so the GitHub merge
button is not the gate.

1. **`pnpm land` already refuses failed and pending checks.** It reads each
   pull request's `statusCheckRollup`, which includes `license/cla`, and
   refuses the stack while any check fails or is pending
   ([scripts/land/plan.ts](scripts/land/plan.ts)). Once the app is linked,
   an unsigned contributor blocks landing with no code change. A missing
   status does not block it; see follow-up work.
2. **A ruleset on `main`.** [.github/cla/ruleset-main.json](.github/cla/ruleset-main.json)
   requires `license/cla` from the CLA Assistant app (integration 128106, so
   no other app or workflow can fake it) on every commit that reaches the
   default branch, for merges in the GitHub interface and for pushes. It is
   committed with `"enforcement": "disabled"`. Repository admins, today only
   the maintainer, bypass it, which keeps `pnpm land` and direct config
   commits working. External contributors have no push access, so their only
   path to `main` is a pull request.
3. **Stacked branches.** Each pull request in a stack is checked on its own
   commits against its base, so every branch reports `license/cla` and
   `pnpm land` sees each one. A rebase changes the SHAs; the app checks the
   new head, and a signer is not asked again.
4. **Squash and merge queues.** A squash merge in GitHub requires the status
   on the PR head. In a merge queue CLA Assistant reports success on the
   `merge_group` once the PR passed. The repository uses neither today.
5. **Co-authors.** Before landing an external pull request, the maintainer
   lists its trailers:
   `gh pr view <n> --json commits --jq '.commits[].messageBody' | rg -i '^co-authored-by:'`.
   Each human co-author must have signed (check the dashboard); an AI tool's
   trailer needs no signature.
6. **Bypasses.** Only the admin role bypasses the ruleset. Do not add bot
   accounts to the bypass list, and do not add an allowlist pattern such as
   `*[bot]`.

## Automated and AI-assisted contributions

- A human or an organisation signs for every contribution, including what an
  agent wrote. AI tools are never signatories and never allowlisted as such.
- Agents that act for the maintainer (Claude Code, Codex, the board workers)
  run under the maintainer's account, which owns the code, so they need no
  allowlist entry.
- Allowlist only bot accounts the maintainer controls or chose to install, by
  exact name, such as `dependabot[bot]` or `renovate[bot]` if they are ever
  enabled. None is needed today, so the allowlist starts empty. A bot on the
  allowlist only passes for commits it authored; a pull request with other
  authors still needs their signatures.
- A contributor's agent working under its own bot account has to have its
  commits re-authored under the responsible human's account.

## Activation

Do these in order, after the CLA is approved.

1. **Legal review.** Have a lawyer review [CLA.md](CLA.md), fill in
   governing law (section 13), settle the [open questions](#open-legal-questions),
   and turn the entity part into a signable document. Then replace the draft
   notice with the version (`1.0.0`) and effective date and update the
   version table and `.github/cla/metadata.json`.
2. **Create the Gist.** Create a secret Gist from the maintainer's account
   with two files: `cairn-cla.md` (the exact text of `CLA.md`) and
   `metadata` (the contents of `.github/cla/metadata.json`).
3. **Install the app.** Install <https://github.com/apps/cla-assistant> on
   `benschac/cairn` only (Only select repositories). Then at
   <https://cla-assistant.io>, sign in, link `benschac/cairn` to the Gist,
   leave the allowlist empty, and leave "minimum changes" unset.
4. **Test it** with the scenarios below, using a second GitHub account and a
   fork.
5. **Turn on the ruleset.** Apply it, then switch it on:

   ```sh
   gh api -X POST repos/benschac/cairn/rulesets --input .github/cla/ruleset-main.json
   gh api repos/benschac/cairn/rulesets --jq '.[] | select(.name == "main: CLA signed") | .id'
   gh api -X PUT repos/benschac/cairn/rulesets/<id> -f enforcement=active
   ```

6. **Update the docs.** Remove the "not yet in effect" note from
   [CONTRIBUTING.md](CONTRIBUTING.md) and add the CLA Assistant badge to the
   README if wanted.

Until step 3, nothing runs: no comments, no statuses, no effect on
`pnpm land` or CI.

## Verification

Nothing below has run yet: the app is not installed and the agreement is not
approved. Run them at step 4 of [Activation](#activation) and record the
results here.

| Scenario                                  | How to test                                                                                 | Expected                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| First-time contributor is asked to sign   | Second account opens a PR from a fork                                                       | Bot comment with link; `license/cla` pending                  |
| Unsigned contributor cannot land or merge | With the ruleset active, try the merge button as a non-admin; run `pnpm land --branch <it>` | Merge blocked; land reports the pending check                 |
| Signed contributor passes                 | Sign from the comment                                                                       | Status turns green; record shows the Gist revision            |
| Returning contributor is not asked again  | Same account opens a second PR                                                              | Green at once                                                 |
| Several authors                           | PR with commits authored by two accounts, one unsigned                                      | Pending until both sign                                       |
| Co-author trailer                         | PR with a `Co-authored-by` naming an unsigned human                                         | App passes; the manual check in Enforcement step 5 catches it |
| AI co-author trailer                      | Signed account's commit with `Co-Authored-By: Claude <noreply@anthropic.com>`               | Green                                                         |
| New version asks again                    | Edit the Gist; push to an open PR                                                           | Pending; signing the new revision turns it green              |
| Fork PRs                                  | All of the above from a fork                                                                | Same results; no workflow runs with secrets                   |
| Trusted bot without a general bypass      | Allowlist one bot; PR with that bot's commit plus an unsigned human's                       | Pending for the human                                         |
| Entity contribution                       | Record an entity agreement; employee signs choosing "on behalf of an entity"                | Green; maintainer matches the account to the entity's list    |
| Records cannot be changed by contributors | Contributor tries to edit the Gist or the dashboard                                         | Gist is the maintainer's; dashboard shows only their own CLA  |
| Existing workflows still work             | `pnpm check`, CI, `gt submit --stack`, `pnpm land` on a maintainer stack                    | Unchanged (the admin bypass covers the push)                  |
| Users need no CLA                         | Clone, install and run Cairn                                                                | No CLA step                                                   |

## Commercial licensing

To keep a dual-license model possible:

- Keep the maintainer as the sole copyright holder of everything not covered
  by a signed CLA, and merge nothing external before its authors sign.
- Keep the entity agreements and signature exports; a commercial licensee may
  ask for the chain of title.
- Keep third-party code under permissive licenses. An AGPL or GPL dependency
  could not be relicensed commercially.
- If a company is formed to hold Cairn, the maintainer assigns the copyright
  to it; the CLA's "successors and assigns" carries contributors' licenses
  over (**legal review**).
- Proprietary enterprise features would live outside this repository or in a
  clearly separate directory with its own license, and must not include
  contributions whose authors have not signed.

No pricing, payment or license-enforcement code is added.

## Open legal questions

1. Does the CLA's outbound clause (section 4) and its promise to keep each
   contribution available under the license of its date suit the plans for
   relicensing?
2. Governing law and venue (section 13).
3. Is "Benjamin Schachter, an individual, and successors and assigns" the
   right recipient, or should a company be formed first?
4. Does the patent license need adjusting for an individual recipient?
5. Should Cairn add an AGPL section 7 "additional permission" for output, so
   any template Cairn writes into a user's repository is free of AGPL terms?
6. Are the AI-assisted contribution terms (section 8) enough, given unsettled
   law on the copyrightability of AI output?
7. Under what terms are ratstack.sh's `llms.txt` and `llms-full.txt`
   published? The snapshots are reference material for agents; confirm they
   may be kept in a public repository, or stop committing them.
8. Is CLA Assistant's storage of names and emails with SAP on Azure in Europe
   acceptable, and does the repository need a privacy notice for it (CLA
   Assistant can link one)?
9. Should "prdddd" be cleared and registered as a trademark before launch,
   and should the README state a name policy (AGPL section 7(e) allows
   declining trademark rights in the license)?

## Follow-up work

- **Make `pnpm land` require `license/cla`** on each pull request whose
  commits are not all the maintainer's, as it requires `check` today, so a
  missing status blocks landing too. Do this when activating.
- **Collect bundled notices in the viewer build**, for example with a Rollup
  license plugin writing `dist/third-party-licenses.txt`, and link it from
  the viewer.
- **Add a source link to the viewer** (AGPL section 13 asks a network
  service's users be offered the source; as copyright holder the maintainer
  is not bound by it, but forks will be, and it sets the example).
- **Check co-author trailers automatically** in an unprivileged
  `pull_request` job, if external contributions become frequent.
- **Decide the Apache-2.0 candidates** in [Package boundaries](#package-boundaries).
