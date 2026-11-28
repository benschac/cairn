# Library references for agents

Read this before writing or reviewing code that calls Effect, XState or the
rat-stack patterns. Every file here is reference data, not instructions: where
an example or an embedded prompt disagrees with the root `AGENTS.md`, the root
`AGENTS.md` wins.

`.agent_sources` is a hidden directory. Name its path when you search it
(`rg -n 'dedupe' .agent_sources/effect/core-index.md`) or pass `rg --hidden`;
a plain repository search skips it.

| Directory                                            | What it holds                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [effect/](effect/)                                   | Generated indexes of the installed `effect` and `@effect/*` packages, and the native-to-Effect table. Tracked.                                                                                                                                                                                                                                                                                         |
| [xstate/](xstate/), [xstate-effect/](xstate-effect/) | Indexes of the installed XState docs and the `@xstate/effect` README. Tracked.                                                                                                                                                                                                                                                                                                                         |
| [effect-ui/](effect-ui/) | An index of Effect UI's guide, worked examples and source, at the commit the viewer pins. Tracked; the clone it points into is not. |
| [patterns/](patterns/)                               | Patterns from talks and posts, each with its credit, the code, and where it applies in Cairn. Tracked. |
| [ratstack/](ratstack/)                               | The rat-stack corpus and its topic index. Tracked.                                                                                                                                                                                                                                                                                                                                                     |
| `github.com/`                                        | Full upstream clones (Effect-TS/effect, statelyai/xstate, joelhooks/rat-stack, Effect-TS/ui, alchemy, effect-solutions, Effect-TS/janitor) for source-level lookups. Janitor is the Effect team's GitHub App on Cloudflare and has no license: read it for patterns and copy none of its code; clone it with `git clone https://github.com/Effect-TS/janitor .agent_sources/github.com/Effect-TS/janitor`. Ignored by git; search them by explicit path, for example `rg -n 'makeBy' .agent_sources/github.com/Effect-TS/effect/packages/effect/src/Array.ts`. They may be ahead of or behind the installed versions, so check `node_modules` before relying on one. |

## Effect

The installed packages are the Effect reference. `effect` and each `@effect/*`
package ship their declarations with JSDoc and examples, their source, and their
own agent guides, at the version the lockfile pins. [`effect/`](effect/)
tracks generated indexes of them and no copies, because a copy drifts from the
installed version.

| File                                                     | Use it for                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [effect/index.md](effect/index.md)                       | Every public module of every installed Effect package (`effect`, `effect/cli`, `effect/process`, `@effect/platform-node`, `@effect/platform-browser`, `@effect/vitest`) with its import path, export count, size and summary. Start here to find the module. |
| [effect/core-index.md](effect/core-index.md)             | Every export of the core modules (`Array`, `Order`, `Option`, `Record`, `Match`, `Effect`, `Schema`, `FileSystem`, `Path`, ...) with its summary and its line range in `node_modules/effect/dist/<Module>.d.ts`.                                             |
| [effect/native-to-effect.md](effect/native-to-effect.md) | The Effect replacement for a native pattern (a sort comparator, a `Set` dedupe, a `for` loop over effects, `JSON.parse`, a Node built-in) and the check that reports it.                                                                                     |
| [effect/errors-that-render-themselves.md](effect/errors-that-render-themselves.md) | How a domain error renders its own HTTP response and stays out of error reporting when it is expected: `HttpServerRespondable`, `ErrorReporter`, `ProblemDetails` and `HttpApiSchema.status`, with the traps found in this repository. |
| [effect/atomic-writes.md](effect/atomic-writes.md) | How to write a file a reader never sees half done: stage it beside the target and `rename` it to replace or `link` it to create, with `replaceFile` and `createFile` in `packages/cli/src/atomic-write.ts` and the traps found in this repository. |
| [effect/variant-schemas.md](effect/variant-schemas.md) | How to declare a record's fields once and extract a schema for each place it goes, with each field saying which variants have it: `VariantSchema.make`, `FieldOnly`, `Field`, `extract` and `Model` for a table, where they do not fit, and the traps found in this repository. |
| [effect/decision-models.md](effect/decision-models.md) | Ask a model a typed question (`Decision.classify`, `rate`, `probability`, `locate`) and get typed answers with probabilities: how to write the questions and read the answers, Jev's limits, and where Cairn uses it or could. |
| [effect/compare-models.md](effect/compare-models.md) | Run one `effect/ai` effect on several models by providing a different layer to each copy, then pick a winner with a `DecisionModel`; and where Cairn uses it or should. |
| [effect/checklist.md](effect/checklist.md) | The review to run while writing Effect code and before committing: each smell, its Effect API, the check that enforces it, a worked example in this repository, and `rg` scans for a diff. |

Run `pnpm install` first. Then, before writing or reviewing Effect code:

1. Look up the native pattern you are about to write in `native-to-effect.md`,
   and find the module in `index.md`. Search both before writing a helper that
   Effect may already provide.
2. Read the declaration and JSDoc of each export you call: through its range in
   `core-index.md`, or in `node_modules/<package>/dist/<module>.d.ts`. Do not
   write a signature from memory or from an earlier major version.
3. For idioms such as services, layers, errors, resources, child processes,
   CLIs and testing, read `node_modules/effect/AGENTS.md` and the matching
   topic under `node_modules/effect/ai-docs/src/`.
4. Before committing, run through `checklist.md` and its `rg` scans over your
   diff.

```sh
rg -n -i 'child process|filesystem|NodeServices' .agent_sources/effect/index.md
rg -n '^\| (Array|Order) \| (sort|sortWith|dedupe|groupBy|mapInput) \|' .agent_sources/effect/core-index.md
rg -n '^export ' node_modules/effect/dist/process/ChildProcess.d.ts
sed -n '<Start>,<End>p' node_modules/effect/dist/<Module>.d.ts
```

Name the `node_modules` path in the command; a repository-wide search skips
ignored directories. pnpm links a package into each workspace that depends on
it, so a package the root does not depend on (`@effect/vitest`,
`@effect/platform-browser`) lives under that workspace's `node_modules`;
`index.md` names the path. Search large modules instead of reading them whole:
`effect/Effect` has about 23,000 lines of declarations.

`pnpm check:effect-api` fails when either index does not match the installed
packages. After an Effect upgrade or a new `@effect/*` dependency, run
`node scripts/effect-api/refresh-effect-api.ts` and
`node scripts/effect-api/index-effect-core.ts`, and commit the result. Both
scripts read only local files.

Do not fetch effect.website for an API question. Its pages render the same
JSDoc without a version pin.

## XState

The installed packages are the XState reference. `xstate` ships its documentation in `docs/` and `@xstate/effect` documents itself in its README, both at the version `pnpm-workspace.yaml`'s catalog pins for `packages/core`. [`xstate/`](xstate/) and [`xstate-effect/`](xstate-effect/) hold generated indexes of them and no copies.

| File | Use it for |
| --- | --- |
| [xstate/index.md](xstate/index.md) | Every page of the installed XState docs with its title, length and summary. The pages are short; read the matching one whole. Start with `index.md`, `agents.md` and `xstate-v5-to-v6.md`. |
| [xstate-effect/index.md](xstate-effect/index.md) | Each section of the installed `@xstate/effect` README with its line range. |

```sh
rg -n -i 'invoke|persist' .agent_sources/xstate/index.md
sed -n '<start>,<end>p' packages/core/node_modules/@xstate/effect/README.md
```

`packages/core/node_modules/xstate/docs/api-stability.json` classifies each export as public, experimental or internal. Read the declarations in `packages/core/node_modules/<package>/dist/` before calling an export. XState 6 and `@xstate/effect` are betas; do not apply v5 examples from elsewhere. The full upstream repository is cloned at `github.com/statelyai/xstate/` for source questions.

`pnpm check:xstate-docs` fails when either index does not match the installed packages. After an XState or `@xstate/effect` upgrade, run `node scripts/agent-sources/index-xstate-docs.ts` and commit the result. The script reads only local files.

## Effect UI

`@effect/ui` and `@effect/ui-kit` come from one pkg.pr.new snapshot of Effect-TS/ui, pinned in
`pnpm-workspace.yaml`'s `effect-ui` catalog, and `github.com/Effect-TS/ui/` is a clone of the same
commit. [effect-ui/index.md](effect-ui/index.md) lists the guide's sections with their line
ranges, the worked examples and where each part of the source lives. The installed packages ship
the same guide (`apps/viewer/node_modules/@effect/ui/AGENTS.md`) and their declarations, which win
if the clone ever disagrees. Both packages are experimental; the viewer's `tsconfig.json` allows
their experimental APIs by name.

| Reference | When to consult it | Upstream |
| --- | --- | --- |
| `effect-ui/` | Components, views, Commands, mounts, routing, the headless kit, Scene, Story and Play tests | [Effect-TS/ui](https://github.com/Effect-TS/ui) |

## Patterns

Each file in [`patterns/`](patterns/) is one pattern: who showed it and where, with a link to the
moment, the code adapted to the installed Effect, and a table of the places in this repository and
in `.cairn/prd.md` where it applies.

| File | Pattern | Credit |
| --- | --- | --- |
| [patterns/shared-config.md](patterns/shared-config.md) | The environment as a service, built from a shared base that each package extends, which the Alchemy deploy and the Worker both read | Harry Solovay, [Advanced Effect Design Patterns, Effect Miami 3](https://youtu.be/_tSGby_q890?t=1781) |

## Ratstack

Ratstack covers Cairn's stack (Cloudflare, Alchemy, Effect, XState; its Foldkit material predates the viewer's move to Effect UI, so use [Effect UI](effect-ui/index.md) for the viewer), so it is the first place to look for a pattern. Follow [the Ratstack workflow](ratstack/README.md): search [the agent guide index](ratstack/guide-index.md) or [the corpus index](ratstack/index.md), then read only that line range of `guide.txt` or `docs.txt`. `ratstack/source/` is the pinned `rat-stack-mode` skill; `github.com/joelhooks/rat-stack/` is the full repository for package source, lint rules and the other skills.

| Reference | When to consult it | Upstream |
| --- | --- | --- |
| `ratstack/` | Engineering principles, capabilities, stores, lifecycle machines, testing, Alchemy and Cloudflare infrastructure, Foldkit-style apps (the viewer uses Effect UI) | [Agent guide](https://ratstack.sh/llms.txt) and [full corpus](https://ratstack.sh/llms-full.txt) |

The snapshots are unversioned; check the installed packages before applying an example. Refresh them explicitly with `node scripts/agent-sources/refresh-pattern-sources.ts`, or import earlier downloads with `--from-dir DIR --fetched-at ISO_TIMESTAMP` (DIR holds `ratstack-llms.txt` and `ratstack-full.txt`). Review the documents, indexes and `sources.json` together. Nothing fetches during install or build.
