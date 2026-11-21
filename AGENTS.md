# Working in Cairn

Cairn turns a markdown PRD into a spec and a stack of branches for agents to
build. Read [VISION.md](VISION.md) before deciding what to build.

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

VISION.md lists the packages still to come. Add one when the work needs it.

## Tests

- Prefer a property over an example. `it.prop` from `@effect/vitest` generates
  inputs from the contract schemas.
- Test a machine through its events and the status it reports, and include the
  events it must ignore.
- Effect code uses `it.effect`.
- A test has to be able to fail: break the behaviour and watch the test catch it.
