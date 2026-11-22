# Working in Cairn

Cairn turns a markdown PRD into a spec and a stack of branches for agents to
build. Read [VISION.md](VISION.md) before deciding what to build, and
[.cairn/prd.md](.cairn/prd.md) for what the tool has to do. Cairn is built
with Cairn: [.cairn/spec.md](.cairn/spec.md) is the technical spec, written by
hand in the format `cairn plan` will produce.

## Before building anything

Read <https://ratstack.sh/llms.txt>. It is the reference for this stack:
Cloudflare, Alchemy, Foldkit and Effect, with XState machines and Effect Schema.
Take the piece the task needs and leave the rest. Do not copy rat-stack.

Effect, XState 6 and `@xstate/effect` change quickly. Read the installed source
and docs under `node_modules` (`effect/AGENTS.md`, `xstate/docs`,
`@xstate/effect/README.md`) instead of trusting memory.

## How work gets checked

One command runs every check:

```sh
pnpm check
```

It runs these through Turborepo, which reruns only what a change affects:

| Check  | Command                     | What it covers                                                                                                                               |
| ------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Types  | `effect-tsgo tsc --noEmit`  | Strict TypeScript 7 plus the Effect language-service diagnostics, in every package and in the root scripts. An Effect warning fails the run. |
| Lint   | `oxlint`                    | Type-aware Oxlint, including the `@xstate/effect` rule against inline Effects in machines.                                                   |
| Format | `oxfmt --check`             | Formatting. `pnpm fix` rewrites files.                                                                                                       |
| Tests  | `vitest run`, `node --test` | Each package's tests, and the tests for the hook guard in `scripts/guard`.                                                                   |
| Build  | `vite build`                | The viewer bundles.                                                                                                                          |

A lefthook `pre-commit` hook runs `pnpm check` on every commit. A commit that
fails any check is refused. `pnpm install` installs the hook.

## Do not skip the hook

`scripts/guard/policy.ts` recognises commands that skip or disable the hook:
`--no-verify`, `git commit -n`, `LEFTHOOK=0`, `core.hooksPath`,
`lefthook uninstall` and writes under `.git/hooks`. Claude Code runs it before
every shell command through `.claude/settings.json` and refuses the command.

When a commit is refused, read the output, fix the cause and commit again. Do
not weaken a check, a lint rule or `lefthook.yml` to get a commit through; ask
the owner first.

The guard stops an agent running in Claude Code. From a plain terminal, git
still honours `--no-verify`. CI in `.github/workflows/ci.yml` runs
`pnpm check` on every pull request to catch that.

## Where things go

- `packages/contract`: the Effect Schemas every other package shares. Files,
  machines and the viewer use these types; do not redeclare them.
- `packages/core`: the machines. A lifecycle is an XState machine built with
  `setupEffect`, whose context and events are schemas from the contract.

- `apps/viewer`: the Foldkit viewer. A Schema-defined Model, fact-named
  Messages, one `update` and one `view`. Test it with a Scene from
  `foldkit/scene`: click what a person clicks and assert on what the view shows.
- `apps/site`: the Alchemy stack that hosts the demo on Cloudflare. It is
  declared in `alchemy.run.ts` and deploys the viewer. Nothing deploys on
  commit; `pnpm --filter @cairn/site run deploy` needs the owner's Cloudflare
  credentials, which never go in the repo.

- `packages/cli`: the process that runs on the user's machine. For now it is
  the presence server: a WebSocket at `/presence` that feeds the room machine
  in `core` and sends every participant the current room.

VISION.md lists the package still to come (`adapters`). Add it when the work
needs it.

## Running it

`pnpm dev` starts the presence server on port 4310 and the viewer on Vite's
port, which proxies `/presence` to the server. Open the viewer in two windows
to see two cursors. `?name=Ada` sets a name, and a client that connects with
`?kind=agent` is shown as an agent.

## Tests

- Prefer a property over an example. `it.prop` from `@effect/vitest` generates
  inputs from the contract schemas.
- Test a machine through its events and the status it reports, and include the
  events it must ignore.
- Effect code uses `it.effect`.
- A test has to be able to fail: break the behaviour and watch the test catch it.
