# Cairn MVP {#prd.cairn-mvp}

A local tool that traces a feature from PRD to spec to stacked diffs to commits to agent sessions, and renders that trace as a read-only canvas. Built to be shippable in one day and dogfooded on RinkSide.

## Goal {#prd.goal}

Given a markdown PRD in a repo, produce a spec and a stack manifest, let the existing orchestrator execute the stack, and show a live view of which PRD sections are done, in progress, blocked, or waiting on a human. Every commit links back to its PRD section and to the agent session that produced it.

## Non-goals for v1 {#prd.non-goals-for-v1}

- No rich editor (Tiptap etc). Users edit markdown in their own editor.
- No real-time multi-user collaboration (v2, see multiplayer).
- No agent-to-agent chat inbox. Coordination is orchestrator-assigned.
- No hosted service, auth, or multi-repo support.
- No replacement of the existing orchestrator. This tool wraps it.

## Repo layout {#prd.repo-layout}

```text
.cairn/
  prd.md            # source PRD, human-authored
  spec.md           # generated spec, editable
  spec.json         # structured index of spec.md: keys, requirements and artifacts per section
  manifest.json     # stack plan + links + status
  events.jsonl      # append-only status events from orchestrator
  judgments.json    # decision-model verdicts on spec sections, tasks and the stack
  cairn.db          # SQLite: sessions keyed by ID, notes, annotations
```

## Section IDs {#prd.section-ids}

Every heading in `prd.md` and `spec.md` carries a stable ID using a trailing attribute:

```markdown
## Saved views {#prd.saved-views}

### Persist filter state {#spec.saved-views.persist}
```

Rules:

- IDs are lowercase, dot-namespaced, prefixed `prd.` or `spec.`.
- `cairn ids` adds missing IDs in place and never rewrites existing ones.
- Renaming a heading keeps its ID. Deleting a heading with linked tasks is a lint error.

### List items {#prd.section-ids.items}

A section often lists things that are built separately, such as the commands under CLI. A list item can carry an ID the way a heading does, so a spec section or a task names the one item it builds and not the whole section around it:

```markdown
## Saved views {#prd.saved-views}

- Save the current filters under a name. {#prd.saved-views.save}
- Share a saved view by link. {#prd.saved-views.share}
```

- An item's ID follows the rules above and is unique among the document's headings and items. It goes wherever a section ID goes: a spec section's `Implements`, `Defers` and `Context`, a task's `prdSections`, a `Cairn-Section` trailer and a link.
- Items are opt-in. Most items are prose, so `cairn ids` never gives an item an ID unasked. An item that ends in `{#}` asks for one, and `cairn ids` fills it in from the section's ID and the item's first words.
- An item sits under the heading it is in, and under the item it is nested in. A section's status rolls up from its items' tasks as well as its own.
- An item with an ID needs its own coverage. A spec section that implements the section does not cover the items in it, though one that defers the section or names it as context does. Once a section's items have IDs, `cairn lint` reports each one that no spec section names.
- An item's tasks are the tasks that build a spec section implementing it, and the tasks that name it.
- When a section's items have IDs, the planner names the items in `Implements` and `prdSections`, not the section that holds them.
- Deleting an item with linked tasks is a lint error, as deleting a heading is.

## Manifest schema {#prd.manifest-schema}

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
      "dependsOn": [],
      "worktree": null,
      "model": "opus",
      "reasoning": "high",
      "category": "schema",
      "humanGate": { "required": true, "reasons": ["tag:human", "path:migrations/"] },
      "status": "pending",
      "commits": [],
      "sessions": []
    }
  ]
}
```

Status values: `pending`, `running`, `blocked_on_human`, `failed`, `done`, `landed`.

The plan is a set of stacks that can be built at the same time, not one long stack. `dependsOn` lists the tasks a task needs. A task with no dependencies starts its own stack on `baseBranch`. A task whose dependencies all sit on one stack goes on top of the latest of them. A task that needs work from two stacks starts from `baseBranch` once that work has landed. Tasks on different stacks run in parallel, each with its own agent.

`worktree` says where a task is built. Tasks that run one after another share a checkout; only work that can run at the same time needs its own. A task takes over the worktree of a task it depends on when it can, and gets a new one otherwise. `null` is the repo's own checkout. Two tasks share a worktree only when one depends on the other, so tasks running at once never collide.

## CLI {#prd.cli}

- `cairn init` creates `.cairn/` and a PRD template. {#prd.cli.init}
- `cairn ids` assigns missing section IDs in `prd.md` and `spec.md`, and fills in a list item's empty `{#}`. {#prd.cli.ids}
- `cairn plan` turns `prd.md` into `spec.md` and `spec.json`, then into `manifest.json`: tasks, stack order, parent links, model and reasoning level per task, human gates. It first drafts the done-when statements the PRD lacks and asks about each (see done when), then stops for a review after the spec and again after the tasks (see planning from a PRD). A decision model checks the breakdown at each step (see judging the plan). {#prd.cli.plan}
- `cairn lint` checks that every task references real section IDs, every PRD section and every list item with an ID maps to at least one task, and every task's parent follows from its dependencies, so nothing sits below a gated task except what it depends on. It warns about done-when statements nobody confirmed or no test proves (see done when). {#prd.cli.lint}
- `cairn judge` judges the current spec and manifest again and writes `judgments.json`. {#prd.cli.judge}
- `cairn status` prints the manifest as a tree with status. {#prd.cli.status}
- `cairn stats` prints cost per verified task and the other outcome metrics per category and model (see cost per verified task). {#prd.cli.stats}
- `cairn serve` starts the local viewer. {#prd.cli.serve}
- `cairn link` prints a link into the viewer (see deep links). {#prd.cli.link}
- `cairn note` adds a note or a review to `cairn.db`, anchored by a link (see notes). {#prd.cli.note}

## Planning from a PRD {#prd.planning}

A person edits `prd.md` and runs `cairn plan`. Everything after that is the tool's work: the spec sections, the tasks, their order, gates and worktrees, the stack diagram and `spec.json`. Nobody writes a spec section, a manifest entry or a diagram by hand to keep the plan going, though anyone may edit what the tool wrote.

### Two reviews {#prd.planning.two-reviews}

`cairn plan` has two steps, and a person reviews after each.

1. Spec. It writes `spec.md`, prints the sections it wrote and asks whether to go on to tasks. Answering no leaves the spec on disk to read and edit.
2. Tasks. It drafts tasks from the spec as it is on disk, prints the stack with what judging changed and reported, and asks whether to write `manifest.json`.

- Before the first step it asks about done-when statements (see done when). That is a question per statement, not a third review, and skipping it never stops the plan.
- Running `cairn plan` again after editing the spec continues from the file. It does not write the spec again.
- `cairn plan --spec` stops after the first step without asking. `--yes` answers yes to both questions.

### Planning again {#prd.planning.again}

A PRD changes while its stack is being built. Running `cairn plan` on a plan that already has a spec and tasks adds to it and never rewrites what is there.

- A PRD section that no spec section covers gets new spec sections, written to fit the spec that exists.
- A spec section that no task builds gets new tasks. They take the next free IDs and may depend on tasks already in the manifest.
- A list item given an ID after its section was planned is mapped, not planned again: `cairn plan` adds it to the `Implements` of the spec sections that already build it, and writes a spec section only for an item that none of them builds.
- A task already in the manifest is never changed, renumbered or reordered, whatever its status.
- Cairn records what each spec section was written from. When a PRD section changes afterwards, the spec sections that implement it are reported as out of date, and so are their tasks. Cairn rewrites an out-of-date spec section only when it wrote the section, nobody has edited it and no task builds it yet. Everything else is for a person to settle; changing a task that has started is v2's rebase flow.
- `cairn plan --respec` writes the whole spec again and plans from nothing. It is refused once any task has left `pending`.

### Diagrams {#prd.planning.diagrams}

A spec explains some things better with a picture, and the plan keeps its pictures true.

- The stack diagram in the spec is drawn by code from `manifest.json`, never by a model or by hand. Each write of the manifest draws it again, and `cairn lint` fails when the two disagree.
- The planner draws a Mermaid diagram in a spec section where one says more than prose: the states of a machine, the messages between two processes, the path data takes. The planner prompt says when a diagram earns its place.
- Every Mermaid block in the PRD and the spec has to draw. `cairn plan` sends a block that does not draw back to the planner once and then leaves it out with a warning; `cairn lint` reports one a person wrote.

### Who writes the plan {#prd.planning.writers}

Planning should cost a person nothing beyond what they already pay for.

- By default the planner runs the agent CLI on the person's machine, Claude Code or Codex, without tools. It uses that CLI's own sign-in, so planning runs on a subscription and Cairn needs no key.
- A person can give Cairn a provider and an API key instead: Anthropic, OpenAI, OpenRouter, or any endpoint that speaks the OpenAI API, which covers Google's models and open-weight models, hosted or local.
- The planner's small calls, indexing a section and splitting one, can name a cheaper model than the calls that write the spec and draft the tasks.
- A key is read from the environment and never stored. With no CLI found and no key set, `cairn plan` fails before it changes a file and says which setting to change.

### Comparing planners {#prd.planning.comparing}

- `cairn plan --dry-run` plans in memory and writes nothing. It prints the spec sections and the stack it would write, then one line of totals: sections, tasks, lint errors, flagged judgments and seconds taken.
- `--source`, `--provider` and `--model` replace the config's planner for one run, so the same PRD can be planned by two models and the totals compared.

## Done when {#prd.done-when}

A person and an agent can read the same PRD section and picture different things. A test does not settle that, because the agent writes the test from its own picture. What settles it is a sentence both can read, saying what a person would see when the section works, agreed before anything is built. Cairn calls that a done-when statement. It drafts the ones the PRD lacks, asks the person whether each is what they meant, and carries them to the spec's tests, the tasks and the agents that build them.

### Statements {#prd.done-when.statements}

A section's statements are the items of a list under a line that reads `Done when:`.

```markdown
Done when:

- Saving the current filters as "Mine" and reloading the page shows "Mine" with the same filters. {#prd.saved-views#v1}
- Draft: Opening a shared view's link in another browser shows the same tasks. {#prd.saved-views#v2}
- The saved views menu reads well at phone width. <!-- human --> {#prd.saved-views#v3}
```

- A statement says what a person does and what they then see, on a named example where one helps. It does not name a file, a function or a test.
- A statement's ID is the ID of its section or list item, then `#v` and a number. `cairn ids` gives a statement without one the next free number and never renumbers.
- A statement belongs to the section its list is in, or to the list item it is nested under.
- A statement that begins `Draft:` is one Cairn wrote and no person has confirmed. Any other statement is confirmed. Nothing else records the difference: the PRD is the record.
- A statement only a person can judge carries `<!-- human -->`. It gates the tasks that carry it, as the tag does anywhere in a section (see human gates), and no test is expected for it.

### Asking the person {#prd.done-when.asking}

`cairn plan` settles the statements before it writes the spec, so the spec is written against what the person agreed to.

- For each section, and each list item with an ID, that describes something to build and has no statement, the planner drafts one or more and writes them into `prd.md` as drafts. Drafts are the only text `cairn plan` adds to the PRD, and it changes no other line.
- It then shows each draft under its section's title and asks whether this is what the person meant. They accept it, which removes `Draft:`; rewrite it, which saves their words as confirmed; delete it; or skip it.
- Skipping never stops the plan. A skipped statement stays a draft, and `cairn plan` ends with a warning that counts the drafts it planned against.
- `--yes` skips every draft. It answers the two reviews for the person, but it does not agree to a statement on their behalf.
- Planning again asks only about drafts: the ones just written for sections that had no statement, and the ones skipped before. A confirmed statement is never asked about or rewritten.
- A person can confirm a draft without the tool by deleting the word `Draft:`.

### From statement to task {#prd.done-when.tracing}

- Each test a spec section names says which statements it proves, by ID. The planner writes a test for every statement its section implements that is not tagged for a person.
- A task carries the statements of the PRD sections and items it names. `spec.json` and the trace record them per task, with whether each is a draft and which tests prove it.
- The orchestrator puts a task's statements at the top of the agent's brief, with drafts marked as drafts, so the agent knows which ones nobody agreed to. `cairn status` and the viewer's task detail show the same list.
- At a human gate, the reviewer sees the task's statements as a checklist, with the ones tagged for a person first.
- A task is verified when the tests that prove its statements pass along with the rest of its checks (see cost per verified task). A statement tagged for a person is settled when the person approves the gate.
- `cairn lint` warns, and does not fail, on a draft, on a statement no test proves that is not tagged for a person, and on a task with no statement.
- Editing a confirmed statement after its spec section was written marks that section and its tasks out of date, as any change to the section does (see planning again).

Done when:

- Running `cairn plan` on a PRD with a section that has no statement writes drafts under that section and asks about each one before it writes the spec.
- Accepting one draft and skipping another leaves the first without `Draft:` and the second with it, and the plan finishes with a warning that counts one draft.
- The brief for the task that builds that section shows both statements, the skipped one marked as a draft, and `cairn lint` warns about it without failing.

## Orchestrator contract {#prd.orchestrator-contract}

The existing orchestrator reads `manifest.json` and runs tasks. It must:

1. Append one line to `events.jsonl` per state change: `{"ts", "taskId", "status", "detail"}`. A `running` line also carries the `model` and `reasoning` level the task was started with, so the viewer can show what ran beside what the plan chose. A `done` or `failed` line carries the attempt's `usage`: input, cached input, output and reasoning tokens, `cost` in US dollars or `null` when it is not known, and the billing `route`. `done` means the task's checks passed; a task can go from `failed` back to `running` for a retry or an escalation (see cost per verified task).
2. Start every task whose dependencies are `done` or `landed`, and whose dependencies on other stacks are `landed`. Run ready tasks in parallel, each in its `worktree`, in the order and with the holds that conflict-aware ordering sets. Stacks are managed with Graphite: each task is one diff, created with `gt create` on top of its parent, or on `baseBranch` when it has no parent. Graphite owns branches, restacking and pull requests; neither Cairn nor the orchestrator rebases a branch by hand.
3. Add commit trailers to every commit:

   ```text
   Cairn-Task: t1
   Cairn-Section: spec.saved-views.persist
   Cairn-Session: s_8f2k1q
   ```

4. Redact the session log, then store it in `.cairn/cairn.db` under its `Cairn-Session` ID.
5. Attach later notes, reviews, and annotations to the session ID in `cairn.db`, never to the commit, each with the link to what it is about (see notes). The trailer is an immutable pointer; the database holds everything that can change.
6. Stop and emit `blocked_on_human` for any task with `humanGate.required`, and do not start its children.

Cairn derives manifest status from `events.jsonl` and git, so the orchestrator never edits `manifest.json` directly.

## Human gates {#prd.human-gates}

A task is gated if either is true:

- Tagged: any linked PRD or spec section contains `<!-- human -->`.
- Detected: the task's planned or actual diff touches configured high-trust paths.

Default high-trust patterns, named for what is risky rather than for one ORM or language. `cairn init` writes them into `.cairn/config.json`, where a project edits them for its own stack:

```json
{
  "humanPaths": [
    "**/migrations/**",
    "**/migrate/**",
    "**/auth/**",
    "**/payments/**",
    "infra/**",
    ".github/workflows/**"
  ]
}
```

Detection runs twice: at plan time against declared files, and post-commit against the actual diff. A post-commit hit on an ungated task flips it to `blocked_on_human`.

Planner rule: nothing sits below a gated task except what it depends on, so the human reviews it before dependent branches land, and unrelated work is never held up behind it.

## Judging the plan {#prd.judging-the-plan}

A plan can pass lint and still be wrong: a task too big for one agent session, a task given a stronger model than it needs, a spec section that drifts from the PRD, a stack that bundles two features. Lint checks structure. Judging uses a decision model at each step of breaking the PRD down, so the plan a human approves is already sized right and routed to the right models.

The language model writes; a configurable decision model judges. TypeSafe's Jev is the initial provider; evaluate the [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) as another provider behind the same `Judge` service. OpenAI Decisions supports bounded choices, condition probabilities and rubric scores. Provider adapters preserve the meaning of each answer type; a choice score is not assumed to be a calibrated probability of task success. Code applies provider-specific thresholds in `.cairn/config.json`, and unsupported or insufficient confidence leaves the draft unchanged.

Checkpoints in `cairn plan`:

1. After the spec is written: is each section sized right? A section judged too large is broken down into smaller sections. Is it faithful to the PRD sections it implements, and could an agent build it without asking a question? Those are reported.
2. After tasks are drafted: is each task one reviewable diff? A task judged too large is broken down into smaller tasks, and the new tasks are judged again.
3. Once tasks are the right size: which model and reasoning level does each task need? The configured judge's choice replaces the planner's only when it meets the routing threshold and the provider has been validated for automatic routing; experimental providers report recommendations only.
4. The stack as a whole: does it build every PRD section, can each task be built and tested with only the tasks below it, and is it one feature? Those are reported.

Rules:

- A low-confidence answer never acts. It is reported as `unsure`, and the planner's draft stands.
- Breaking down is bounded: at most two rounds, so planning always ends.
- Judging never decides gates, IDs, branch names or order. Those stay deterministic.
- Judging shapes the draft before a human sees it. The plan output shows what was broken down and which models were changed, and why. The human still approves the plan.
- A spec section a human wrote or edited is never rewritten. Judging only reports on it.
- After the manifest is written, `cairn judge` reports on it again and changes nothing. `cairn judge --strict` exits non-zero on a flag, for CI.
- The selected judge's key comes from the environment: `TYPESAFE_API_KEY` for Jev or `OPENAI_API_KEY` for OpenAI. Cairn never stores keys. Without the selected provider's credentials, Cairn keeps the planner's drafts and reports that judging was skipped.
- Each judgment records a hash of what it judged. When the section or task changes, the judgment is stale, and `cairn judge` asks again only for what changed.
- The judge provider and model version are pinned in config and recorded in `judgments.json`, along with the routing policy and candidate catalog version, so a decision can be traced to its inputs.

### Choosing models for tasks {#prd.judging-the-plan.routing}

- Model recommendations are not limited to Sonnet, Haiku and Opus. A configurable catalog can include Anthropic, OpenAI, Google and other models, with concrete model IDs, supported reasoning settings, capability descriptions, execution routes and dated cost information.
- Only models the person's configured runner can execute are eligible. The person declares their available subscriptions, API access and credits, plus preferences such as using existing subscriptions first, a spending ceiling or faster completion. Unknown quota and unavailable prices remain unknown; subscription access is not treated as API credit.
- Judge each task using its spec sections, declared files, complexity, risk, required tools and verification criteria. Recommend the lowest expected total cost of an accepted result within the person's quality and time constraints, including likely retries and repair work, rather than the lowest token price alone.
- The plan shows the recommended model and supported reasoning level, the evidence and policy behind the recommendation, uncertainties, and an eligible alternative when useful. Separate generated explanations from the judge's typed answers. A person can override the recommendation before approving the plan; the orchestrator remains responsible for execution.
- Start with curated capability descriptions. Use recorded execution outcomes as evidence when available: verification failures, review findings, retries, repair work, elapsed time and actual cost. Existing manifest assignments are a baseline, not correct-answer labels, and confidence alone does not prove a model will finish a task correctly. Once a category has enough history, routing follows it (see cost per verified task).

### Comparing decision providers {#prd.judging-the-plan.comparing}

- Evaluate OpenAI Decisions against Jev and the planner's existing assignments on the same 20–30 representative tasks, using the same spec evidence, candidate catalog and policy. Include mechanical edits, ordinary features and sensitive logic.
- Keep experimental recommendations advisory and preserve the manifest. Record provider/model versions, inputs, typed answers, disagreements, latency, token usage and cost. Provider confidence thresholds must be evaluated separately rather than copied between providers.
- Use a configurable evaluation budget, initially capped at $5, with bounded requests and conservative cost estimates before each call. Stop when the next request could exceed the cap; missing pricing prevents starting the paid evaluation. Adding this requirement does not itself run an evaluation or spend credits.
- Compare a small set of recommended assignments through actual task execution and acceptance checks before enabling automatic routing. Judge quality by successful completion, review and repair effort, elapsed time and total cost; agreement with previous labels is not sufficient.

### Cloudflare AI Gateway {#prd.judging-the-plan.gateway}

- Cloudflare AI Gateway is the preferred route for API-based planner and judge calls, using configured endpoints and authentication. Use [Cloudflare AI Gateway](https://www.cloudflare.com/products/ai-gateway/) with the person's provider credentials so existing eligible provider credits can be used. Subscription-backed local CLI planning keeps the CLI's own sign-in. Direct provider API access remains an explicitly configured fallback; Cairn never silently bypasses the gateway.
- To use existing OpenAI API credits, authenticate with a key for the OpenAI project and organization holding those credits. Cloudflare can forward the provider key from request headers or use an explicitly configured [BYOK stored key](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/). Usage remains billed to the provider account, subject to its credit eligibility and expiry. Cairn stores neither provider nor gateway secrets in project files or logs.
- Cloudflare [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) uses a separate Cloudflare balance. It does not transfer OpenAI credits. The chosen billing route is explicit and must not silently fall back to another paid balance.
- Verify the actual Decisions endpoint, answer semantics and usage reporting through the gateway before claiming support; OpenAI-compatible chat support alone is insufficient. If the endpoint is unsupported, report it and let the person configure direct OpenAI access. Gateway routing must preserve the selected judge model, and request logging and retention must be explicitly configured for repository content.

## Cost per verified task {#prd.outcomes}

A cheap model that needs three attempts can cost more than a dear one that passes on the first. What a plan should keep low is the cost of a task that passes verification, not the price of a token. Cairn records what every attempt at a task cost and whether it passed, and routes later tasks on that record instead of on fixed assumptions about which model is best.

For example, on 100 feature tasks each:

|                         | Model A | Model B | Model C |
| ----------------------- | ------: | ------: | ------: |
| First attempt costs     |   $0.20 |   $0.30 |   $0.80 |
| First-pass verification |     55% |     90% |     95% |
| Tasks verified          |      92 |      98 |      99 |
| Total cost per task     |   $0.46 |   $0.34 |   $0.85 |
| Cost per verified task  |   $0.50 |   $0.35 |   $0.86 |

Model B costs half as much again as A per attempt and is the cheapest per verified task, so Cairn routes feature tasks to B. The figures are made up; they show the arithmetic, not any provider.

History stays in the repo's `cairn.db`. Nothing is sent to a Cairn service, and nothing is pooled across repos.

### Attempts {#prd.outcomes.attempts}

- An attempt is one agent session on one task, from its `running` event to the `done` or `failed` event that ends it. A task can have several.
- A task is verified when its checks pass on its branch: the tests its spec sections name and the repo's check command (`pnpm check` in this repo). `done` means verified; an agent saying it is finished is not enough. A change an attempt makes to a check, a lint rule or a test it did not write fails verification, as the hooks in this repo already enforce.
- A retry is a new attempt with the same model and reasoning level. An escalation is a new attempt with a stronger model or a higher reasoning level, or the task handed to a person. A repair after review is a new attempt on the same task. Review and conflict-resolution sessions on a task count toward its cost.
- Each attempt records the model ID and reasoning level it ran with, the harness that ran it (Claude Code, Codex, Pi) and its version, when it started and ended, its input, cached input, output and reasoning tokens, its cost, the billing route that paid for it, and its outcome. The orchestrator reports these (see Orchestrator contract).
- A failed attempt says why: `checks` (the work did not pass), `agent` (the agent stopped or gave up), `infra` (the runner, the provider or the network failed) or `upstream` (a dependency was wrong). Only `checks` and `agent` failures count against the model; `infra` and `upstream` attempts add their cost to the task and nothing to the model's failure rate.
- Cost comes from the provider's or the gateway's usage report, priced from the catalog's dated prices, and the report is kept as it came beside the normalised numbers. A missing number is unknown, never zero. An attempt run on a subscription records its tokens with cost `null` and route `subscription`; Cairn does not invent a price for it.
- Each task can set a limit on attempts and on cost in config, with defaults for the repo. A task that reaches its limit without verifying is `failed` for good and is counted as a terminal failure.
- Attempts are stored in `cairn.db` under their session IDs, beside the session log.

### Metrics {#prd.outcomes.metrics}

Each is reported per task and summed per model, reasoning level, harness and task category:

- Cost per verified task: the cost of every attempt, failed ones included, divided by the number of tasks that ended verified. A task that never verified adds its cost and no task.
- First-pass verification rate: the share of tasks whose first attempt verified.
- Time to completion: wall-clock time from a task's first `running` event to its verified `done`, less any time held at a human gate or behind a conflict hold.
- Retry rate and escalation rate: retries and escalations per task.
- Terminal failure rate: the share of tasks that reached their limit without verifying.
- Cost per attempt, and the share of attempts that failed verification.
- Cache utilization: cached input tokens over all input tokens.
- Reasoning tokens: total reasoning tokens per verified task, where the provider reports them.

A metric whose tasks include attempts with unknown cost says how many it left out; it never counts them as free. Every metric is shown with the number of tasks behind it.

### Task categories {#prd.outcomes.categories}

- Each task has a `category` in the manifest, chosen by the planner from a list in `.cairn/config.json`. The default list is `mechanical` (renames, moves, config), `feature`, `ui`, `test`, `schema`, `refactor`, `bugfix` and `docs`. A repo can add its own; the router reads the list and has none built in.
- `cairn lint` fails a task whose category is not in the list.
- History is kept per category, so a model that is cheap for mechanical edits and expensive for schema changes is routed to each on its own record.

### Routing from history {#prd.outcomes.routing}

- At the third checkpoint of judging the plan, Cairn ranks the eligible models, reasoning levels and harnesses in each task's category by cost per verified task, among those whose first-pass rate and time to completion meet the thresholds in `.cairn/config.json`. A more expensive model is not assumed to be better, nor a cheaper one to be cheaper.
- History counts only when a choice has at least five finished tasks in the category, a number set in config. Below that, the catalog and the judge choose as in choosing models for tasks, and the plan says the choice has no history.
- Recent tasks count, not all of them: by default the last 30 per model, reasoning level, harness and category. A new model ID starts with no history, so a new model version starts over.
- History ranks only eligible models and keeps the person's preferences, such as subscriptions first or a spending ceiling. The top-ranked choice is the recommendation; when the judge would choose differently, the plan shows both. The person approves the plan as before and can override any task's choice.
- Routing from history starts in shadow: the plan shows and records its recommendation but keeps the planner's or the judge's choice, and `cairn stats` compares what was recommended with what ran and how it did. It changes a task's model only once `routing.adaptive` is on in config. Turning it off returns to the planner's and the judge's choices.
- A share of tasks set in config, 0 by default, goes to the second-ranked eligible choice so that a model with little history can earn some. Only tasks with no human gate explore. The plan marks those tasks as exploring.
- Each recommendation records in `judgments.json` the candidates it ranked, their estimated cost and first-pass rate, the task counts behind them, the constraints that applied, and whether it explored, so a routing decision can be traced to the outcomes that made it.

### Reporting {#prd.outcomes.reporting}

- `cairn stats` prints the metrics per category, model, reasoning level and harness for this repo, with the number of tasks behind each, and the estimated cost of each routed task beside what it cost. `--category` and `--since` narrow it; `--json` prints it for scripts.
- The task detail in the viewer lists each attempt (model and reasoning, harness, outcome and failure reason, time, tokens and cost) and the routing decision that chose its model.

## Conflict-aware ordering {#prd.conflicts}

Tasks on different stacks run at the same time, and two that change the same code conflict when the second one restacks. Cairn predicts which tasks are likely to conflict and orders the work to avoid it: at plan time by shaping the stacks, and during a run through the orchestrator, which decides what starts, what waits and what each agent is told as the picture changes.

### Predicting a conflict {#prd.conflicts.predicting}

Every pair of tasks that can run at the same time gets a conflict score.

- The base is the files both tasks plan to change. Once a task is running, its actual diff and the file its agent is in (from presence) replace the plan's guess.
- A file that changes often in the repo's history weighs more. Files that usually change in the same commit count as shared, so a task in `model.ts` and another in `update.ts` still score.
- Files differ in how they conflict. A generated file, such as a lockfile or the demo trace, is rebuilt after a restack and scores nothing. A file tasks only add lines to, such as an index of exports, scores low. Both are path patterns in `.cairn/config.json`, like `humanPaths`.
- A score says why: the files and the reason each one counts, so a person can check it.

### At plan time {#prd.conflicts.planning}

- When two tasks in a new plan score high, the planner may put one on top of the other instead of running them side by side. The manifest records that ordering apart from `dependsOn`, with its reason, so the plan still says what each task needs and `cairn lint` can tell an ordering from a dependency.
- The plan output lists each high-scoring pair and what was done about it. A person can undo a stacking at the task review.
- A task already in the manifest is never moved (see planning again). For those, Cairn recommends the change, such as putting one stack on another or starting one task before another, and a person applies it.
- Judging flags a plan where many parallel tasks share one file: the better fix may be to split the file, not to reorder the work.

### While running {#prd.conflicts.running}

The orchestrator keeps the scores current from events, commits and presence, and acts on them.

- When several tasks are ready, it starts the one that scores lowest against what is running. It never leaves an agent idle only to avoid a risk.
- It can hold a ready task back while a high-scoring task runs, and starts it when that task lands. A held task stays `pending`; its event names the task it waits on.
- When two running tasks start to change the same lines, it tells both agents: the other task, the files, and which one goes first. The second restacks onto the first as soon as the first lands, not at the end.
- It never stops a running agent on its own. Stopping or reassigning running work is for a person.
- Every hold, reorder and message is an event, so the viewer shows it and the trace explains why work ran in the order it did.
- Messages to agents come from the orchestrator, not from other agents (see the non-goals). They reach agents through the room once it exists (see multiplayer), and through a message board adapter before then.

### Landing order {#prd.conflicts.landing}

- Of two conflicting stacks, the smaller or nearer-done one lands first, and `cairn status` shows the order.
- When a stack lands, every running or waiting stack that scores against it is told to restack at once.

### Learning from conflicts {#prd.conflicts.learning}

- Every conflict a restack actually hits is recorded with its files and the score the pair had.
- `cairn status` reports how often a high score conflicted and how often a low one did, so the weights can be checked against the repo.

## Redaction {#prd.redaction}

Before writing session JSONL, strip values matching env var names from `.env*`, common token patterns (API keys, bearer tokens, private keys), and anything in a user-supplied deny list. Log redaction counts per file. Fail closed: if redaction errors, do not write the session.

## Viewer {#prd.viewer}

Local web app served by `cairn serve`, read-only, polling or file-watching `.cairn/` and git.

The viewer is a reader. The PRD is a document a person reads from top to bottom. The spec and the stacks sit beside it and follow the section being read, so the reader can branch off from any section into what specifies it, what builds it and the code that was written for it. The Curves variant of the prototype in `.cairn/design/prd-curves.html` is the reference for how it looks and moves. Where the prototype and this document disagree, this document wins.

Layout, under a top bar:

- Left pane: rendered `prd.md`, read as a document. Each section shows its status rolled up from its tasks (see Reading the plan).
- Middle pane: the spec sections that implement the section being read, as cards with their tasks inside (see Spec cards).
- Right pane: the stacks, drawn over the base branch the way the spec draws its own stack diagram (see Stacks).
- Curves: SVG bezier curves linking the PRD section to its spec cards, and each task in a card to the same task in the stacks. Hovering any node highlights its full chain.
- Task detail panel: the task's code, its commits (each opens the code view), its agent session, events timeline, gate reasons, and judgments (see Task detail).
- Judgment markers: a spec card or task with a `flag` or `unsure` judgment shows a marker. Stale judgments are shown as stale.
- Top bar: the feature's name, search (see Fuzzy search), the models and reasoning switch (see Models and reasoning), and who else is here.

The look is the prototype's paper look: ink borders, hard offset shadows and solid colour fills on headers. No gradients, and no accent stripe down the side of a card. It comes in a light and a dark palette and follows the system's setting, with no switch.

The reader replaces the canvas that could be panned, zoomed and rearranged. There is no pan or zoom, no dragging a document or a task card, no Fit and no Reset layout. Each pane scrolls on its own, and the panes can be made wider or narrower (see Panes).

Suggested stack: Foldkit SPA for the viewer, a markdown renderer that preserves heading IDs, and a tiny Node server exposing `.cairn/` files and `git log --format` with trailers, plus reads from `cairn.db`.

### Reading the plan {#prd.viewer.reader}

- The PRD pane shows the whole document as prose, with its headings, lists, tables, code and diagrams. At its top are the feature's title and how many of its tasks are done.
- Under each heading is one status line: the section's status, how many spec sections implement it and how many of its tasks are done, such as `in progress · 3 spec · 5/12 tasks`. A section that no spec section implements says why instead: the spec defers it, the spec treats it as context that needs no code, or nothing maps to it, which `cairn lint` reports.
- Each heading shows its section ID. Clicking the ID copies it.
- The section at the top of the PRD pane is the current section. The spec pane and the stacks pane always show the current section's chain, so scrolling the PRD walks the plan.
- Clicking a status line pins that section: it stays current while the PRD scrolls. Clicking it again, or pressing Escape with no panel open, unpins it. One section is pinned at a time.
- Nothing in the viewer edits a file.

Done when scrolling the PRD on this repo changes the spec cards and the lit stacks to the section at the top of the pane, and a pinned section stays current while the PRD scrolls.

### List items {#prd.viewer.items}

A list item with an ID (see section IDs) reads as a small section inside its section.

- The item ends with its annotation: a status dot, how many spec sections implement it and how many of its tasks are done, such as `1 spec · 2/7 tasks`. An item that nothing maps to says so in its place. The item's ID shows on hover and copies on click.
- The heading's status line still counts the whole section, its items with it.
- Hovering an annotation lights the item's chain: the spec cards that implement it, their task rows and its tasks in the stacks, with a curve from the item to each card. Clicking it pins the item, which stays current like a pinned section: the spec pane shows only its cards and the stacks light only its tasks. Clicking it again, or Escape, unpins it.
- From the other side, a spec card's `Implements` chips name items as well as sections, and clicking one scrolls the PRD to the item and marks it. Hovering a task row or chip marks the items it builds, and the task detail lists them with what it traces to.

Done when the CLI section of this repo's PRD shows each command with its own status and task count, pinning `cairn lint` leaves lit only the cards that implement it and their tasks, and opening one of those tasks marks the `cairn lint` item.

### Spec cards {#prd.viewer.spec-cards}

The spec pane shows one card for each spec section that implements the current PRD section, in the spec's order.

- A card's header has the spec section's title and how many of its tasks are done. Under it is a one-sentence summary of the section, taken from `spec.json`.
- The tasks that build a spec section are rows inside its card, not separate nodes. A row shows the task's status, ID and title, `GATE` for a human gate, and its commit count or, before it has any, its status. A task that names the PRD section but none of these spec sections is listed in a last card, so every task of the section is on the pane.
- One control sets how much of every card shows: titles only, the summary, or the full spec section. The full section is the section's markdown rendered the way the PRD is: prose, lists, tables, code and diagrams, with its key list (`Implements`, `Files`, `Depends on`) as chips.
- Clicking a card's header opens or closes that card alone, whatever the control says. Changing the control sets every card to it.
- Clicking a task row opens the task detail.

Done when the Viewer section of this repo's PRD shows a card for each spec section that implements it with its tasks inside, and the control switches all of them between titles, summaries and full sections.

### Stacks {#prd.viewer.stacks}

The stacks pane is the plan's stack diagram, live and whole. Every stack is always on the pane, so a person sees where the current section's work sits in the plan, where `main` is and what is done. Anyone who knows the diagram in the spec should find the same picture in the viewer: the same boxes, the same tasks in each, read the same way. Work that is finished folds out of the way, so the forks still to build or review stand out from the history they were built on.

- One box per stack, numbered as the spec's diagram numbers it. A stack is a task that starts from the base branch and every task built on it through parent branches. Stacks are numbered in the order of their first task. A box's label, `Stack N · <area>`, shows on hover; the area is the part of the spec its first task builds.
- Inside a box, tasks read bottom to top, each above its parent, with a solid arrow from the parent up to it. A fork puts the children side by side in the same box, with an arrow to each, and the task they share sits centred beneath them. Chips are spaced so every arrow can be read. These arrows always show.
- A finished trunk folds. Starting at a box's root, the run of `done` or `landed` tasks up to the first fork or the first unfinished task becomes one segment at the bottom of the box, showing its first and last IDs, its area and its count, such as `t45–t52 · viewer · 8 done`. The columns above it stand on the segment as if each started from it. A run of one task stays a chip. Clicking the segment unfolds it into its chips, and clicking again folds it. Folding changes only what this viewer window shows, not the plan or other participants' views. An arrow to or from a folded task ends on its segment.
- Each column a fork starts is labelled at its foot with the part of the spec its first task builds: the last part of that task's first spec section, such as `fuzzy-matching`. A fork of a large stack reads as its own feature. The labels and the layout come from the manifest and the spec alone; no task ID is written into either.
- The base branch (`main`) is a bar under everything, and it stays in view while the pane scrolls. The bottom row holds the stacks that start from it now. A stack that waits for other stacks sits one row above the highest of them. Reading up the page is reading forward in build order, and the stacks in one row can be built at the same time.
- A task is a chip: a status dot and its ID, with a red border for a human gate. Its title, branch, worktree and status show on hover. Clicking it opens the task detail.
- A task's dependencies on other stacks are dashed arrows, from each task it needs to it. They show only for the task that is hovered, focused from the keyboard or open in the detail panel: the arrows into it and out of it, with the tasks at their other ends lit. With no task in focus, no dashed arrow is drawn, so the diagram never becomes a web of lines.
- The tasks of the current section stand out, and their stacks with them. A folded segment holding one of them, or the selected task, stands out too. Every other task is dimmed but can still be read and clicked.
- Above the diagram: how many stacks hold the current section's tasks, how many of the plan's tasks are done, and a legend.

Done when the viewer, opened on this repo, shows the same stacks with the same tasks and the same parent arrows as the spec's diagram, and a test fails when the two disagree. Stack 24's finished trunk, t45 to t52, shows as one segment of eight, centred under arrows to the stacks fork (t69 → t70), the fuzzy search fork (t71 → t72 → t73) and the code view fork (t75 → t53 → t54), each labelled, with t54's own fork to t67 and t81 drawn the same way; it unfolds into the same chips as the diagram. Polling, t68, is its own stack: hovering t52 draws a dashed arrow from it to t68, and hovering t68 with the trunk folded draws the same arrow from the segment. In Stack 13, t19 → t20 splits into the lint chain t25 → t26 → t27 → t66 and t111.

### Models and reasoning {#prd.viewer.models}

A person should be able to see which model did what. Each task has the model and reasoning level the plan chose for it and, once it has run, the ones it ran with.

- A switch in the top bar, on at first, shows or hides models and reasoning everywhere at once.
- With it on, each task row in a spec card ends with `model · reasoning`; each chip in the stacks takes its model's colour (purple opus, blue sonnet, yellow haiku) and a short reasoning mark (`lo`, `med`, `hi`, `xhi`); each spec card's header has one swatch per task in its model's colour; and the legend names the colours.
- What ran is drawn solid. What is only planned is drawn with a dashed outline. The task detail says `ran on sonnet · medium` or `planned for sonnet · medium`.
- What ran comes from the task's `running` event (see Orchestrator contract). A task with no such record shows the plan's choice as planned, even when it is done.
- With it off, a chip shows status alone: a done task is filled green.
- A model Cairn has no colour for is grey and still named.

### Panes {#prd.viewer.panes}

- A divider sits between the PRD and the spec, between the spec and the stacks, and on the edge of the task detail panel. Dragging one makes the pane beside it wider or narrower. The stacks pane takes the width that is left.
- A divider can be focused and moved with the left and right arrow keys.
- Each pane has a least and a greatest width, so none can be dragged shut or over the others.
- Curves stay attached to their ends while a pane is resized or scrolled. A curve whose end is scrolled out of its pane runs to that pane's top or bottom edge and is drawn faded.
- Widths last until the window is reloaded.

### Task detail {#prd.viewer.task-detail}

Clicking a task, in a spec card or in the stacks, opens its detail in a panel over the right of the window. The panes stay as they were underneath it.

- At the top: the task's ID, title, branch and stack; its status; the model and reasoning it ran on or is planned for; its parent task, or `from main`, and the other tasks it depends on; and the reasons for its gate.
- Its code, without leaving the panel: the task's whole stacked diff, each file under its path, syntax-highlighted as in the code view. A task with no commits says it has no code yet.
- Its commits, each with its subject and short SHA. Clicking one opens the code view on it. "Open in code view" opens the whole task there.
- The agent session of its latest commit: the first prompt and the tool calls, one line each, with a link to the whole session in the code view. A commit with no session says so.
- What it traces to: its PRD sections and list items, which scroll the PRD to them, and its spec sections, which open in the panel. Then the files the plan expects it to touch, its events timeline and its judgments.
- Opening a spec section or another task from the panel adds a step to a trail at its top, and each step goes back to what it names. Escape goes back one step, and closes the panel at the first.

The demo site has no server, so it ships the patches of the commits in its trace and shows code the same way. It ships no sessions.

### Fuzzy search {#prd.viewer.fuzzy-search}

Search the current feature locally across PRD and spec section titles and IDs, task titles and branch names, then extend it to PRD and spec prose. Search is private to the current viewer window and does not change the documents, task status, pins or other participants' views.

- A toolbar search box shows ranked results with their kind, title and matched field or prose snippet. Matching ignores case, supports abbreviated queries and small typos, and ranks exact matches above fuzzy matches and titles above prose.
- Highlight the matching characters or words in results and in the panes. Distinguish a direct text match from a section or task highlighted only because it belongs to the selected result's chain.
- Arrow keys move through results; Enter selects a result, brings it into view and previews its PRD → spec → task chain. Pointer selection does the same. Selecting a PRD section scrolls the PRD to it. Selecting a spec section or a task makes the first PRD section it traces to the current section until the search is cleared, and scrolls its card, row or chip into view. A spec section that implements no PRD section has no card, so it opens in the detail panel. Clicking a status line still pins, and clicking a task still opens its detail.
- Clearing the query or pressing Escape removes search highlights and results while preserving the pinned section and the detail panel. An empty query restores the ordinary view; a query with no matches says so and leaves the panes usable.
- Prose highlights preserve markdown formatting, links and text selection. Code fences, diagram labels, diffs and session logs are outside this search scope.
- Recompute results when the trace changes; a removed result must not leave a stale highlight. Searching must not reparse both documents on each keystroke.

Ship this in three diffs: matching titles/IDs/branches; search controls, navigation and chain highlighting; then prose snippets and inline highlights. The full feature is complete only after all three.

### Command menu {#prd.viewer.command-menu}

The fastest way around the viewer is the search it already has. The command menu puts that search, and the viewer's own controls, one keystroke away, the way [⌘K](https://github.com/dip/cmdk) does. ⌘K is a React component and the viewer is Foldkit, so the menu rebuilds its behaviour rather than using the package. It ranks with the fuzzy search above, so the menu and the toolbar box never disagree.

- ⌘K on macOS, Ctrl+K elsewhere, opens the menu from anywhere in the viewer and closes it again. So do `/` outside a text field and a click on the toolbar search box, which becomes the menu's trigger. The menu is a dialog over the centre of the window with the query at its top and the results below. It is private to this viewer window.
- With an empty query, the menu lists the commands and the tasks of the current section. As the query is typed, results are grouped under headings in a fixed order: PRD, Spec, Tasks, then Commands. A group with no matches is hidden. Each result shows its kind, its title, the matched text marked and, for a task, its status dot and ID.
- Commands are the controls the viewer already has: models and reasoning on or off, how much of each card shows, folding or unfolding every finished trunk, opening the code view for the current task, and copying a link to what is in view. A command with a keyboard shortcut shows it on the right. A command that does not apply to what is in view is not listed.
- Some results open a page of their own, as ⌘K's nested items do: `Search tasks…`, `Search the PRD…` and `Search the spec…` narrow the menu to one kind and show it as a badge before the query. Backspace in an empty query, or Escape, goes back one page.
- Up and Down move through the results and wrap at the ends. Moving the pointer over a result selects it. The selected result previews its PRD → spec → task chain in the panes behind the menu, as fuzzy search does. Enter, or a click, runs it: a search result closes the menu and does what selecting it in fuzzy search does, and a command closes the menu and runs.
- Escape on the first page closes the menu without changing the panes, and focus returns to where it was. A second Escape after a search result clears the search, as it does today. The detail panel closes on Escape only when the menu is closed.
- The list grows and shrinks with its results, and the menu opens and closes with a short fade and scale; with reduced motion they change at once. A query with no matches says so.
- The menu is an accessible combobox: the query is a combobox, the results a listbox of options, the selected one its active descendant, and focus stays in the dialog while it is open.

Done when, on this repo, ⌘K then `fuzy matchng` and Enter brings the Fuzzy matching spec section and its chain into view; ⌘K, `Search tasks…`, then `t52` and Enter opens t52's stack lit, with its folded segment standing out; Backspace in an empty query returns to the first page; and Escape closes the menu with the panes, pin and detail panel as they were.

### Notes {#prd.viewer.notes}

Agents leave notes on the plan and the code: a review finding on a line, a question about a spec section, a remark on a task. The viewer shows them where they are about. In v1 it only shows them; people write notes in the room (see notes in the room).

- A note has a kind (`note` or `review`), an author, a body in markdown, whether it is open or resolved, and an anchor: the deep link to what it is about, such as a PRD passage, a spec section, a task, a commit or a line of a diff.
- Agents and the orchestrator write notes with `cairn note`, which stores them in `cairn.db` (see the orchestrator contract). The second-model review of each pull request writes its findings as review notes on the lines they are about.
- A note shows as a marker where it is anchored: beside the passage or the spec section, on the line in the diff, on the task's row and chip with a count of open notes. The task detail lists the task's notes, and each note opens its link.
- A note whose anchor no longer resolves shows in the task detail, or under its section, with the step that is missing (see deep links).
- A resolved note is hidden until a person asks to see resolved notes.

## Code view {#prd.code-view}

The reader shows where the work stands. The code view shows the work itself: the code each task changed, beside the agent conversation that changed it. It is read-only, like the rest of the viewer.

It opens from a task or a commit in the detail panel and fills the window. "Back to the plan" returns to the reader as it was left, with its current section, its pin, its pane widths and the detail panel.

Layout:

- Left: the stacks as a tree. Each stack lists its tasks from the bottom up, with status and gate marker; each task lists its commits; the selected task or commit lists the files it changed as a directory tree. Selecting a task shows its whole diff, selecting a commit shows that commit alone, and selecting a file scrolls the diff to it.
- Middle: the selected task's diff: everything its branch adds on top of its parent, the stacked diff as it is reviewed in its pull request. Selecting one of its commits narrows the diff to that commit. Every file is in one scroll. Files on gated paths come first, labelled with the pattern that gated them.
- Right: the agent session that made the selected commit, or the task's latest commit when the whole task is shown, found through its `Cairn-Session` trailer. Prompts, replies and tool calls in order, each tool call on one line (its name and its file or command) until opened. Redactions show where they were made.

A task's diff runs from the parent of its first commit to its last commit, so it reads the same before and after the branch lands and is deleted.

Code in a diff is syntax-highlighted by its file's language, in the same colours as code blocks in the documents, in both the unified and the split view. A file in a language Cairn cannot highlight shows as plain text, with its added and removed lines still marked.

Code and conversation link both ways:

- Each hunk is marked with the turn that wrote it. Clicking the mark scrolls the session to that tool call and opens it.
- Clicking an edit in the session marks the hunks it wrote and scrolls the diff to the first.
- A hunk is matched to the session's file edits by file and by the lines it adds or removes. A line written another way, by a shell command, a formatter or a code generator, matches no edit; its hunk says it is not traced to a turn, and the session is still shown.
- A commit with no session, or with a session Cairn cannot read, shows its diff alone and says why.

Cairn reads Claude Code session logs first. Other agents' logs come with their adapters.

## Deep links {#prd.deep-links}

Everything the viewer shows has a link, and links compose, so a person can send someone to an exact point: this passage of the PRD, then the spec section that implements it, then the line of the stacked diff that builds it.

### What has a link {#prd.deep-links.targets}

- A PRD or spec section, or a PRD list item with an ID, by its ID.
- A passage: text selected in the PRD or the spec. Its link is the section ID and the quoted text, so it survives edits elsewhere in the document.
- A note or review in `cairn.db` (see the orchestrator contract), which opens where it is attached.
- A task, a stack, and a folded segment of finished tasks.
- A task's stacked diff, a commit's diff, a file in either, and a line or range of lines in that file, in the unified or the split view.
- A turn of an agent session.

### Composing links {#prd.deep-links.composing}

- A link is a list of steps, read left to right. Opening it does what a person would do clicking each step in turn: the PRD scrolls to the passage and pins its section, the spec section opens, the task detail opens with each step on its trail, and the code view opens on the line.
- The address bar always holds the link to what is on screen, so copying the address copies the link. Each step is a browser history entry: Back goes back one step, like Escape in the detail panel.
- Every step has "Copy link", which copies the whole path up to it. Each thing in the viewer can also be copied alone.
- A link to a line in a task's diff records the commit it was copied at, so it opens on the same code after more commits land.
- A link carries what was opened, not how the window looked: pane widths, the models switch, the cards' detail and a search stay with each viewer.
- A link is a path, the same on `cairn serve` and on the demo site, so it opens in either on the same plan.
- Links are the viewer's Foldkit routes. One definition both reads a link and writes it, so a link the viewer copies always opens on the same steps, and every ID in it is decoded through its contract schema.
- Opening a link in a new window loads everything its steps need, the same as clicking through them: the patches for a diff and the session for a turn.

### Links that no longer resolve {#prd.deep-links.missing}

- A link opens as far as it resolves and says which step is missing and why: the section was deleted, the passage was edited, the task is gone, or the file is not in that diff. It never opens a blank window.
- A passage that no longer matches opens its section and says the passage changed.

### Links from agents {#prd.deep-links.agents}

- `cairn link` prints the link to a section, a passage, a task, a commit, a file or a line, and composes them in the order given, such as `cairn link prd.code-view t74 --file packages/cli/src/api.ts --line 40`.
- Agents and the orchestrator put these links in pull requests, gate notices and board posts, so a person lands on the exact place a message is about.

## Documentation {#prd.docs}

Cairn has a docs site for the person setting it up in a repo and for the agents working there. It sits beside the demo on `prdtrace.com`.

This section is written ahead of its spec on purpose. It is the first section `cairn plan` plans on this repo (see planning again): nobody writes its spec sections or tasks by hand.

- It covers getting started (from `cairn init` to a landed stack), every CLI command, the files in `.cairn/`, and how planning, judging and gates work.
- The CLI reference is built from the command definitions in `packages/cli`, and the file formats from the schemas in `packages/contract`. A command or a field added there shows up in the docs without editing a page, and a page that names a command that no longer exists fails the build.
- A picture of the viewer is the viewer: a page shows a sample plan in the real reader and stacks, not a screenshot, so it never goes out of date.
- Pages are markdown. The site is a Foldkit app, prerendered to static pages, with search across every page, and is deployed by `apps/site` like the demo.

## Implementation in Effect {#prd.implementation-in-effect}

The CLI and local server are written in Effect, so every side effect is a typed service that tests can swap out.

- Schemas: manifest, events, config, and commit trailers are Effect Schema definitions. Every file read from `.cairn/` is decoded through them, and failures are typed errors naming the bad field.
- Services as Layers: `Git` (branches, log, trailers), `TraceStore` (`cairn.db`), `Planner` (model calls that write the spec and tasks), `Judge` (decision-model calls that judge them), `Orchestrator` (adapter to the user's runner), `Redactor`, and `Clock`.
- Models: two kinds, each behind an `effect/ai` service. A language model writes (`LanguageModel`, for `Planner`); a decision model judges (`DecisionModel`, for `Judge`). Swapping a provider changes one Layer. API-backed Layers accept gateway endpoints and authentication, with Cloudflare AI Gateway as the preferred route and direct provider access as an explicitly configured fallback (see Cloudflare AI Gateway requirements in `prd.judging-the-plan.gateway`).
- Composition: one composition root per entrypoint (CLI, server). Live Layers in production; test Layers (fake git, in-memory SQLite, scripted planner, scripted judge) in tests.
- Tests: `@effect/vitest` with `it.effect` and `it.layer`. Status derivation, gate detection, and lint run against test Layers with no real repo. Machines are also the models the code around them is tested against (see Model-based testing).
- Viewer: Foldkit. Interaction logic (selection, chain highlighting, drawer state) lives in the pure update function and is unit tested without a render loop. Rendering only draws.

### Model-based testing {#prd.implementation-in-effect.model-based-testing}

A machine says what a piece of Cairn must do, so it also tests the code that does it. `@xstate/test` generates sequences of events from the machine, sends each sequence to the machine and to the implementation, and fails when the two disagree. It shrinks a failure to the shortest sequence it finds.

- The model and the implementation are separate code. A machine checked against a table of itself proves nothing new. When the implementation runs the machine, as the presence server runs the room machine, the test checks what the implementation adds around it.
- Events come from the contract's schemas, as the inputs of the other property tests do.
- Every run asserts coverage: each transition of the model is taken, so a test cannot pass by never reaching a state.
- A failure is saved as a fixture, committed, and replayed as a regression test.
- A pure function, such as stack order or rollup, keeps its property tests. Only behaviour that responds to events gets a model.

What is tested against a model, in this order:

1. The presence server against the room machine. Real clients join, move and leave over the socket, and the room every participant receives matches the machine's participants.
2. The viewer's interactions against machines written for them: the task detail trail, pinning in the reader, and the dividers' keys. The implementation is the viewer's `update`, so the test needs no render loop.
3. Status derivation against a model of what the orchestrator writes and what git shows. Derivation's inputs are report lines and commits, not the task machine's events, and its work is the mapping between them, so its model is written over those inputs.

## Contract package {#prd.contract-package}

`@cairn/contract` is the single source of truth for everything an orchestrator reads or writes, and it must work from plain JavaScript.

- Effect Schema definitions for manifest, events, config, trailers, and judgments.
- Generated JSON Schema files, so any language can validate `.cairn/` files.
- Plain JS entry points: `parseManifest(json)`, `parseEvent(line)`, `formatTrailers(task)`. Each returns a result or throws an error naming the bad field. Callers need no Effect knowledge.
- Shipped `.d.ts` types, so JS users get editor autocomplete and checked JSDoc.
- A `version` field on every file, with migrations in the package, so old manifests keep loading.

Adapters for Claude subagents, Pi, and plain shell scripts import only this package.

## Acceptance criteria {#prd.acceptance-criteria}

- Running `cairn init`, `cairn plan`, and the orchestrator on a real RinkSide feature produces a manifest with at least three stacked tasks.
- Every commit on those branches has Cairn trailers, including a `Cairn-Session` ID that resolves to a redacted session in `cairn.db`.
- A task touching a migrations path is gated and its children do not start until it is approved.
- Breaking the presence server's broadcast, or Escape in the task detail panel, fails a model-based test that prints the shortest event sequence that shows the break.
- Opening a task in the code view shows its whole stacked diff with syntax-highlighted code, and each of its commits can be shown alone.
- Fuzzy search finds abbreviated and mistyped titles and prose, marks the matched text, and brings the selected result and its chain into view; clearing it preserves the pinned section and the detail panel.
- ⌘K opens the command menu from anywhere in the viewer; its results match the toolbar search's, a nested page narrows them to one kind, and every result and command can be reached and run from the keyboard alone.
- The viewer shows correct status for every PRD section, and a PRD section's commits are two clicks or fewer from it.
- Scrolling the PRD changes the spec cards and the lit stacks to the section at the top of the pane, and a pinned section stays current while the PRD scrolls.
- In the stacks pane every parent link is a solid arrow, and a task's dependencies on other stacks show as dashed arrows only while it is hovered, focused or selected.
- With models and reasoning on, every task shows the model and reasoning it ran with, or the plan's choice marked as planned; with it off, none shows.
- Opening a task shows its code in the detail panel without leaving the plan.
- `cairn lint` catches an orphaned section ID and an unmapped PRD section.
- Each command in the CLI section of this repo's PRD shows its own status and task count in the viewer, and `cairn lint` reports a list item with an ID that no spec section names.
- With no API key set and Claude Code signed in, `cairn plan` on a new PRD writes a spec, stops for review, and after a yes writes a manifest that passes `cairn lint`.
- Adding a section to this repo's PRD and running `cairn plan` adds spec sections and tasks for it and changes no task that was already in the manifest.
- After `cairn plan`, the stack diagram in `spec.md` shows every task in the manifest, and editing the diagram by hand fails `cairn lint`.
- A drafted task judged too large is broken down before the plan is printed, and the plan output says so.
- A task's model is changed only when the configured judge is validated for automatic routing, meets its provider-specific threshold and selects an eligible model and reasoning setting; otherwise the planner's choice stands and the recommendation is advisory or reported as `unsure`.
- A judgment on a task that has since changed shows as stale.
- With no `TYPESAFE_API_KEY`, `cairn plan` still writes the manifest and says that judging was skipped.
- In the code view, a hunk an agent wrote with its edit tools reaches the tool call that wrote it in one click, and a hunk written another way says it is not traced.
- A link copied after opening a PRD passage, then a spec section, then a line of a task's stacked diff opens in a new window on the same passage, the same trail and the same line, and Back walks the trail one step at a time.
- A link to a passage still opens on it after an edit elsewhere in the PRD; after its passage is edited it opens on the section and says the passage changed.
- Writing a link for any list of steps and reading it back gives the same steps, property tested over generated steps.
- A review an agent writes with `cairn note` on a line of a task's diff shows on that line in the code view and in the task detail, and its link opens there.
- A command added to the CLI appears in the docs reference without a docs edit, and a docs page that names a removed command fails the build.
- The spec sections and tasks for the docs were written by `cairn plan`, not by hand.
- Two parallel tasks planned against the same source file score higher than two that share only a generated file, and the plan output names the file.
- With one task running and two ready, where only the first ready task shares files with the running one, the orchestrator starts the second.
- When two running tasks change the same file, both agents are told the other task and the file, and the viewer shows the message and the order chosen.
- Every conflict a restack hits is recorded with the score its pair had.
- A task that failed verification once and passed on its second attempt counts as one verified task carrying the cost of both attempts, and not as a first-pass success.
- With at least five finished tasks in a category for each of two eligible models, `cairn plan` recommends the one with the lower cost per verified task that meets the thresholds, and the plan output names the metrics and task counts it used; with fewer, it says the choice has no history.
- With `routing.adaptive` off, a recommendation from history is recorded and shown but changes no task's model.
- An attempt that failed for `infra` adds its cost to the task and does not lower its model's first-pass rate.
- An attempt run on a subscription appears in `cairn stats` with its tokens, is left out of cost, and the report says how many attempts it left out.

## One-day build order {#prd.one-day-build-order}

1. Section ID parser and `cairn ids` (1h).
2. Manifest schema, `cairn plan` prompt, and `cairn lint` (2h).
3. Judging: questions, verdicts, `cairn judge` (1h).
4. Orchestrator contract: events, trailers, session IDs in `cairn.db`, redaction (2h).
5. Status derivation from events and git (1h).
6. Viewer: three columns, badges, curves, detail panel, judgment markers (3h).
7. Fuzzy search follow-up: title/ID/branch matching, search navigation and chain highlighting, then prose search and inline marks (roughly 2–3 engineering days including verification; separate from the original one-day baseline).
8. Reader follow-up: the PRD pane and its current section, spec cards, the stacks as chips, curves between the panes, models and reasoning, resizable panes and code in the task detail, then removing the canvas (separate from the original one-day baseline).
9. Dogfood on one RinkSide feature and fix what breaks (1h).

## v2: diverging state {#prd.v2-diverging-state}

v2 lets humans and agents change the PRD and statuses at the same time, and keeps work correct when the PRD moves mid-stack. Each kind of state gets the strategy that fits it.

| State                                                | Strategy                              | Why                                                                                               |
| ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PRD and spec prose                                   | Loro CRDT                             | Human and agent edits land concurrently and must merge without conflicts                          |
| Section IDs                                          | Loro marks on the text                | IDs must survive concurrent edits around them                                                     |
| Events, task status, leases, notes and agent notices | Effect `EventLog`, one store per room | One writer per task, so status is a projection of ordered events, not a merge (see the event log) |
| Presence                                             | Ephemeral, on the presence socket     | Cursors and heartbeats are never persisted                                                        |

Yjs stays an option for the editor if Loro's bindings fall short. Strategies can coexist per field.

### Versioning and branching {#prd.v2-diverging-state.versioning-and-branching}

- Every PRD change is a Loro version. The manifest records `prdVersion`, the version it was planned from.
- Draft PRD changes happen on a Loro fork and merge back when approved, mirroring how the stack works in git.

### Rebase flow {#prd.v2-diverging-state.rebase-flow}

When the PRD head moves past `manifest.prdVersion`:

1. Diff the two versions by section ID: changed, added, removed.
2. Mark linked tasks `stale` (new status) and show their chains as stale in the viewer.
3. Re-plan tasks that have not started.
4. For landed tasks, create follow-up tasks instead of rewriting history.
5. Restack only the affected branches and their dependents. Untouched branches keep their commits.
6. Update `prdVersion` once the stack is consistent.

### v2 acceptance criteria {#prd.v2-diverging-state.v2-acceptance-criteria}

- A human editing a section while an agent writes its status loses neither change.
- Editing one PRD section mid-stack marks only that section's chain stale.
- A rebase restacks only the affected branches.

## v2: multiplayer on Cloudflare {#prd.v2-multiplayer-on-cloudflare}

A feature's PRD, spec, and stack live in a shared room. Humans and agents see each other's cursors and every change as it happens. Code and sessions stay in the team's git remote; the room holds the document, statuses, and presence, and fetches a diff or a session only to show it (see code and sessions in the room).

### Architecture {#prd.v2-multiplayer-on-cloudflare.architecture}

- One [Durable Object](https://developers.cloudflare.com/durable-objects/) per room (one feature). It holds the [Loro](https://loro.dev/) document and the room's event log, applies updates, and fans them out over [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- Storage: Durable Object SQLite for Loro updates and snapshots and for the event log's entries. [R2](https://developers.cloudflare.com/r2/) for version snapshots and files attached to notes. [D1](https://developers.cloudflare.com/d1/) for accounts (see accounts). None of them holds code or a session log (see code and sessions in the room).
- Statuses and leases are events written through the room's Durable Object, and its sequence orders them (see the event log).
- Local bridge: `cairn connect` links a repo's `.cairn/` to a room. It pushes events, commit SHAs, and session IDs, and pulls PRD and spec edits back to markdown on disk.
- Offline: the viewer still works on local files. Loro merges edits made while disconnected.
- Deploy: Worker, Durable Object namespace, R2 bucket, D1 database, email sending subdomain and the Foldkit site, all defined in [Alchemy](https://alchemy.run/). Room tokens live in each room's storage. Alchemy generates the session signing secret and keeps it across deploys. Model keys never reach the server.

### Event log {#prd.v2-multiplayer-on-cloudflare.event-log}

A room's events run on Effect's `EventLog` ([`effect/eventlog`](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/eventlog)).

- The events are the contract's schemas: task status changes, leases, gate approvals, conflict holds and the orchestrator's notices to agents. Task status, the viewer's trace and the conflict scores are handlers that project them.
- Each room is one store. Each human and each agent is its own identity, and the server checks every write against it: a gate approval from an agent is refused, and only the orchestrator writes notices to agents.
- The room runs the unencrypted server, so it can run handlers, enforce those rules and score conflicts. Its entries live in the Durable Object's SQLite.
- Every client keeps a local journal, IndexedDB in the viewer and SQLite in the CLI, so it works offline and sends what it wrote when it reconnects. The server's sequence orders a room's events; no client's clock decides.
- `.cairn/events.jsonl` stays the orchestrator's interface (see orchestrator contract). `cairn connect` writes each new line into the room's log, and `cairn serve` reads the same events without a room.
- `EventLog` is marked unstable. Cairn reaches it through one service of its own, so an Effect upgrade that changes it touches one module.
- Prose stays out of the log, because Loro merges text. Presence stays out, because it is never persisted.

A spike proves the fit before the room is built on it: one Durable Object running the event-log server on its own SQLite, with a browser client and a CLI client. If it misses the latency target or loses events when the Object hibernates, status and leases go back to registers the Durable Object writes, and the rest of v2 stands.

### Notes in the room {#prd.v2-multiplayer-on-cloudflare.notes}

In the room, people write notes too.

- A note is a row in the room's event log, so two people editing one note at once each keep the fields they changed.
- A note on a passage holds a Loro cursor, so it follows its text through concurrent edits. Other anchors are deep links, as in v1.
- A note's author is its writer's identity. An agent may resolve its own notes; only a human resolves a human's note.
- Files attached to a note, such as a screenshot, are stored in R2.
- `cairn connect` sends the notes in `cairn.db` to the room, and pulls the room's notes back.

### Presence {#prd.v2-multiplayer-on-cloudflare.presence}

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

- Humans: a text caret and selection in the PRD and spec, plus their name beside the PRD section they are reading.
- Agents: a labeled caret on the section they work from, a pulse on their stack node, and the file they are in. Agent presence comes from orchestrator events, so agents need no browser.
- Heartbeats: every 5 s. Three missed marks the actor away. For an agent, its task goes `stalled` (new status) and its lease is released.

### Accounts {#prd.v2-multiplayer-on-cloudflare.accounts}

A person signs in to a room, so the room knows who wrote what. Accounts exist only in the hosted room: `cairn serve` on a person's own machine has none, as in v1.

- Sign-in is [Better Auth](https://www.better-auth.com/), run in the room's Worker through [Alchemy's Better Auth integration](https://alchemy.run/better-auth/what-is-better-auth/). Its users, linked accounts, sessions and one-time tokens live in [D1](https://alchemy.run/better-auth/databases/cloudflare-d1/), so a deploy needs nothing outside Cloudflare but the two OAuth apps, and the GitHub App when the room shows code (see code and sessions in the room).
- Three ways in, none with a password: [GitHub](https://www.better-auth.com/docs/authentication/github), [Google](https://www.better-auth.com/docs/authentication/google), and a [magic link](https://www.better-auth.com/docs/plugins/magic-link) sent by email. A link works once and expires after five minutes.
- Magic links are sent with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), from a sending subdomain of the site's domain, through Alchemy's `Cloudflare.Email.Send` binding. Email Service is in beta; if it cannot send to any address, a transactional email provider takes its place behind the same service.
- One person is one user. A sign-in joins the user that already has its email when the provider has confirmed that email ([account linking](https://www.better-auth.com/docs/concepts/users-accounts)), so GitHub, Google and a magic link to the same address reach the same user. No provider is trusted to link an email it has not confirmed.
- A profile is the name, email and picture the first sign-in brings. There is no profile page. A person's cursor color comes from their user ID.
- `cairn connect` signs in once through the browser with [device authorization](https://www.better-auth.com/docs/plugins/device-authorization) and keeps the session on the person's machine.
- The OAuth client secrets are Alchemy config bindings. None is in the repo.

### Permissions {#prd.v2-multiplayer-on-cloudflare.permissions}

- Each room has one token: a plain string assigned when the room is created. A signed-in person with the token can join, and joining registers their event-log identity. Without a session the token is refused.
- The server decides whether a writer is a human or an agent; no client says so. A person's own session, in the browser or the CLI, writes as that human. Each agent `cairn connect` registers gets its own identity, of kind agent, that records the person it acts for. The contract's `Participant` carries the user ID behind it.
- Gate approvals are only accepted from a human identity and record the user who approved; the event log's server enforces it against the writer's identity.
- An agent on a person's machine could still use that person's CLI session. Cairn does not guard against that in v2. Signed, scoped tokens and per-room members come later.

### Code and sessions in the room {#prd.v2-multiplayer-on-cloudflare.code-and-sessions}

A team wants to see what each person's agents did: the diff of a task and the session that wrote it. Some of the people looking have no checkout, no git and no GitHub seat, only a browser. The room shows them both and keeps a copy of neither. Code and sessions live in the team's own git remote, and the room holds the pointers to them.

Where they live:

- A diff is never stored. It is computed from the task's commits, as in v1.
- Once a repo is connected to a room, `cairn session put` also pushes the redacted session to the git remote, under a ref of its own: `refs/cairn/sessions/<session ID>`. A clone or a fetch does not bring these refs down unless asked, so no checkout grows. `cairn.db` stays each machine's own store.
- A session that fails redaction is neither stored nor pushed, as in v1. `sessions.share: false` in `.cairn/config.json` keeps every log on the machine that made it; the room then shows that the session exists and that it was not shared.
- Redaction is best effort, and a pushed session can be read by everyone who can read the repo. A secret it missed is then shared with all of them. `cairn session put` prints the redaction counts before it pushes, as it does before it stores.
- `cairn session unshare <session ID>` deletes the session's ref from the remote, and the room then shows the session as not shared. It cannot take the log back from a clone that already fetched it, so it says that the secret still has to be rotated.
- `cairn connect` records the repo's remote in the room. The room holds each session's ID, task, commit and redaction counts, and never its log.

How the viewer gets them depends on where it runs:

- The local viewer, from `cairn serve`, reads the checkout and `cairn.db` as in v1. It fetches a teammate's session from the remote with the machine's own git credentials.
- The hosted viewer has no checkout to read. The room's Worker fetches the diff or the session from GitHub through a GitHub App the team installs on its organisation or on the one repo, with read access to contents and nothing else. The Worker passes what it fetched to the browser and writes it to no storage and no log.
- When a person opens a diff or a session in the hosted viewer and the App is not installed on that repo, the pane says why it is empty: this browser is not reading from a checkout, so the room needs the App to show code. It offers to install the App. A person who cannot install it on the organisation is sent to GitHub's request to an owner, and the pane says the request is waiting.
- The PRD, the spec, statuses, notes and presence need no App.
- A commit that has not been pushed shows as not pushed, with no diff.

Who sees them:

- By default, code and sessions are shown only to members whose GitHub account can read the repo, checked with GitHub when they open one. The room's token is a plain string, and a leaked token should not show anyone the code.
- The person who connected the repo can open code and sessions to every member of the room. That is how a person with no GitHub seat sees them.
- A member who may not see them still sees every status, and the pane says why the code is hidden.

What Cairn can read:

- The PRD, the spec, notes, statuses and events are stored in the room, so the hosted service can read them at rest. They are the only content of a team's that it holds. Cloudflare encrypts them at rest, and a team on the hosted service is offered a data processing agreement.
- Code and sessions pass through the room's Worker on the way to the browser, so the hosted room could read them in passing. It keeps neither. Uninstalling the App ends the room's access and leaves nothing of the repo behind.
- A team that accepts neither runs the room in its own Cloudflare account with `alchemy deploy`, with a GitHub App it registered itself. Cairn's hosted service then never sees the repo.
- The App's ID and private key are Alchemy config bindings, like the OAuth client secrets. None is in the repo.
- GitHub is the only git host the hosted viewer reads at first.

A spike proves the fit before this is built: from a Worker, the App reads a commit's patch and a 20 MB session under `refs/cairn/sessions/` through GitHub's API. If GitHub will not serve those refs, sessions go on one branch, `cairn/sessions`, that no stack is built on, and the rest stands.

Done when:

- A person who signs in to a room in a browser, on a machine with no checkout, opens a task and sees its diff and its agent session, once the App is installed on the repo.
- Before the App is installed, the same person reads the PRD and the spec and sees every status, and the diff pane says the App is not installed and offers to install it or to ask an owner.
- A session written on one person's machine opens in a teammate's local viewer.
- A member whose GitHub account cannot read the repo sees statuses and is told why the code is hidden, until the person who connected the repo opens code to every member.
- After the App is uninstalled, opening a diff in the hosted viewer shows the install prompt again.
- After `cairn session unshare` on a shared session, a teammate's viewer and the room both show it as not shared, and the command says to rotate any secret the log held.

### Multiplayer acceptance criteria {#prd.v2-multiplayer-on-cloudflare.multiplayer-acceptance-criteria}

- Two humans and one agent see each other's cursors and edits in under 250 ms p95 within one region.
- Killing an agent process marks it away and stalls its task within 15 s.
- A gate approval from an agent identity is rejected, whatever the client says it is.
- Clients that edit offline converge on reconnect with no lost edits, property tested with random edits and partitions.
- `alchemy deploy` brings up a working room from an empty Cloudflare account, given the GitHub and Google OAuth client credentials.
- GitHub, Google and a magic link to the same confirmed email sign in as one user.
- A magic link signs in once; a second use, or a use after five minutes, is refused.
- A client with the room's token but no session cannot join the room.
- The event-log spike: a Durable Object running the event-log server on its own SQLite syncs a browser client and a CLI client within the latency target, and an Object that hibernated wakes with no lost events.
- Two people editing one note at once each keep the fields they changed, and a note on a passage follows its text through concurrent edits.
- A client that writes events offline sends them on reconnect, and every client then derives the same task statuses.
- After a room has shown a diff and a session, its Durable Object, its R2 bucket and its D1 database hold no line of either.

## Later {#prd.later}

- Rich editing beyond markdown: embeds, comments, and inline diffs.
- A map of the whole plan on one screen: every PRD section, spec section and stack at once, with every curve drawn. The prototype has it as its Map variant.
- An inbox view of agent activity across rooms.
- Drift detection that flags or proposes spec updates when code diverges.
- Cost per PRD section, and the outcome metrics drawn in the viewer as well as printed by `cairn stats`: cost by model and category, trends over time and retry chains.
- Choosing a recovery during a run: after a failed attempt, pick a retry, a stronger model, another harness, more context or a smaller task from the failure reason and the attempts so far.
- Comparing models across tasks of different difficulty, and a regression rate: verified tasks whose work was later reverted or reopened.
- Routing across parallel stacks for the plan as a whole, such as spending more on the critical path.
- Judging during a run: before a task starts, and on its diff after it is done.
- Adapters for Vercel Board and other agent message boards.
- Notes across rooms, such as every open note for one person, indexed in D1.
- Code and sessions read from GitLab and other git hosts, and sessions encrypted on the machine that made them, for a team that wants a hosted room unable to read them even in passing.
- A SOC 2 report for the hosted service.
- [Effect Cluster](https://alchemy.run/cluster/what-is-effect-cluster/) for durable work that waits, such as room invitations by email and scheduled cleanup. On Cloudflare its [Durable Object pool](https://alchemy.run/cluster/cloudflare) makes each entity a Durable Object reached over RPC, with its state in memory, so the room itself stays a plain Durable Object with hibernatable WebSockets.
- Cairn's commands as MCP tools, so an agent session plans as a participant in the room instead of being run by `cairn plan`.
- Scoring planners against a reference plan, so a provider is chosen on measured quality and cost.
- State diagrams drawn from the machines themselves.
- A plan split across several PRD files, with one set of section IDs and one manifest.
- Several independent plans in one repo, for a monorepo that holds more than one product.
