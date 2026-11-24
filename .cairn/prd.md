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

- `cairn init` creates `.cairn/` and a PRD template.
- `cairn ids` assigns missing section IDs in `prd.md` and `spec.md`.
- `cairn plan` calls a model to generate `spec.md` and `spec.json` from `prd.md`, then generates `manifest.json`: tasks, stack order, parent links, model and reasoning level per task, human gates. A decision model checks the breakdown at each step (see judging the plan). Prints the plan with what judging changed and reported, and waits for approval.
- `cairn lint` checks that every task references real section IDs, every PRD section maps to at least one task, and every task's parent follows from its dependencies, so nothing sits below a gated task except what it depends on.
- `cairn judge` judges the current spec and manifest again and writes `judgments.json`.
- `cairn status` prints the manifest as a tree with status.
- `cairn serve` starts the local viewer.

## Orchestrator contract {#prd.orchestrator-contract}

The existing orchestrator reads `manifest.json` and runs tasks. It must:

1. Append one line to `events.jsonl` per state change: `{"ts", "taskId", "status", "detail"}`. A `running` line also carries the `model` and `reasoning` level the task was started with, so the viewer can show what ran beside what the plan chose.
2. Start every task whose dependencies are `done` or `landed`, and whose dependencies on other stacks are `landed`. Run ready tasks in parallel, each in its `worktree`. Stacks are managed with Graphite: each task is one diff, created with `gt create` on top of its parent, or on `baseBranch` when it has no parent. Graphite owns branches, restacking and pull requests; neither Cairn nor the orchestrator rebases a branch by hand.
3. Add commit trailers to every commit:

   ```text
   Cairn-Task: t1
   Cairn-Section: spec.saved-views.persist
   Cairn-Session: s_8f2k1q
   ```

4. Redact the session log, then store it in `.cairn/cairn.db` under its `Cairn-Session` ID.
5. Attach later notes, reviews, and annotations to the session ID in `cairn.db`, never to the commit. The trailer is an immutable pointer; the database holds everything that can change.
6. Stop and emit `blocked_on_human` for any task with `humanGate.required`, and do not start its children.

Cairn derives manifest status from `events.jsonl` and git, so the orchestrator never edits `manifest.json` directly.

## Human gates {#prd.human-gates}

A task is gated if either is true:

- Tagged: any linked PRD or spec section contains `<!-- human -->`.
- Detected: the task's planned or actual diff touches configured high-trust paths.

Default high-trust patterns in `.cairn/config.json`:

```json
{
  "humanPaths": [
    "**/migrations/**",
    "**/auth/**",
    "**/payments/**",
    "infra/**",
    "*.sql",
    ".github/workflows/**"
  ]
}
```

Detection runs twice: at plan time against declared files, and post-commit against the actual diff. A post-commit hit on an ungated task flips it to `blocked_on_human`.

Planner rule: nothing sits below a gated task except what it depends on, so the human reviews it before dependent branches land, and unrelated work is never held up behind it.

## Judging the plan {#prd.judging-the-plan}

A plan can pass lint and still be wrong: a task too big for one agent session, a task given a stronger model than it needs, a spec section that drifts from the PRD, a stack that bundles two features. Lint checks structure. Judging uses a decision model at each step of breaking the PRD down, so the plan a human approves is already sized right and routed to the right models.

The decision model is TypeSafe's Jev, built for typed decisions with calibrated confidence rather than text. The language model writes; Jev decides. Every answer comes with probabilities and a confidence, and code, not the model, decides what an answer means, using thresholds in `.cairn/config.json`.

Checkpoints in `cairn plan`:

1. After the spec is written: is each section sized right? A section judged too large is broken down into smaller sections. Is it faithful to the PRD sections it implements, and could an agent build it without asking a question? Those are reported.
2. After tasks are drafted: is each task one reviewable diff? A task judged too large is broken down into smaller tasks, and the new tasks are judged again.
3. Once tasks are the right size: which model and reasoning level does each task need? Jev's choice replaces the planner's when Jev is confident.
4. The stack as a whole: does it build every PRD section, can each task be built and tested with only the tasks below it, and is it one feature? Those are reported.

Rules:

- A low-confidence answer never acts. It is reported as `unsure`, and the planner's draft stands.
- Breaking down is bounded: at most two rounds, so planning always ends.
- Judging never decides gates, IDs, branch names or order. Those stay deterministic.
- Judging shapes the draft before a human sees it. The plan output shows what was broken down and which models were changed, and why. The human still approves the plan.
- A spec section a human wrote or edited is never rewritten. Judging only reports on it.
- After the manifest is written, `cairn judge` reports on it again and changes nothing. `cairn judge --strict` exits non-zero on a flag, for CI.
- Jev's key comes from `TYPESAFE_API_KEY` and is never stored. Without a key, Cairn plans with the planner's drafts as they are and says that judging was skipped.
- Each judgment records a hash of what it judged. When the section or task changes, the judgment is stale, and `cairn judge` asks again only for what changed.
- The model version is pinned in config and recorded in `judgments.json`, so a decision can be traced to the model that made it.

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
- Inside a box, tasks read bottom to top, each directly above its parent, with no gaps. A fork puts the children side by side in the same box.
- A finished trunk folds. Starting at a box's root, the run of `done` or `landed` tasks up to the first fork or the first unfinished task becomes one segment at the bottom of the box, showing its first and last IDs, its area and its count, such as `t45–t52 · viewer · 8 done`. The columns above it stand on the segment as if each started from it. A run of one task stays a chip. Clicking the segment unfolds it into its chips, and clicking again folds it. Folding changes only what this viewer window shows, not the plan or other participants' views.
- Each column a fork starts is labelled at its foot with the part of the spec its first task builds: the last part of that task's first spec section, such as `fuzzy-matching`. A fork of a large stack reads as its own feature.
- The base branch (`main`) is a bar under everything, and it stays in view while the pane scrolls. The bottom row holds the stacks that start from it now. A stack that waits for other stacks sits one row above the highest of them. Reading up the page is reading forward in build order, and the stacks in one row can be built at the same time.
- A task is a chip: a status dot and its ID, with a red border for a human gate. Its title, branch, worktree and status show on hover. Clicking it opens the task detail.
- The tasks of the current section stand out, and their stacks with them. A folded segment holding one of them stands out too. Every other task is dimmed but can still be read and clicked.
- Above the diagram: how many stacks hold the current section's tasks, how many of the plan's tasks are done, and a legend.

Done when the viewer, opened on this repo, shows the same stacks with the same tasks as the spec's diagram, and a test fails when the two disagree; Stack 24's finished trunk, t45 to t52, shows as one segment with the stacks, fuzzy search, code view and polling forks labelled above it, and unfolds into the same chips as the diagram.

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
- What it traces to: its PRD sections, which scroll the PRD to them, and its spec sections, which open in the panel. Then the files the plan expects it to touch, its events timeline and its judgments.
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

## Implementation in Effect {#prd.implementation-in-effect}

The CLI and local server are written in Effect, so every side effect is a typed service that tests can swap out.

- Schemas: manifest, events, config, and commit trailers are Effect Schema definitions. Every file read from `.cairn/` is decoded through them, and failures are typed errors naming the bad field.
- Services as Layers: `Git` (branches, log, trailers), `TraceStore` (`cairn.db`), `Planner` (model calls that write the spec and tasks), `Judge` (decision-model calls that judge them), `Orchestrator` (adapter to the user's runner), `Redactor`, and `Clock`.
- Models: two kinds, each behind an `effect/ai` service. A language model writes (`LanguageModel`, for `Planner`); a decision model judges (`DecisionModel`, for `Judge`). Swapping a provider changes one Layer. Each can take a base URL, so a user can route calls through a gateway such as Cloudflare AI Gateway; Cairn does not require one.
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
- The viewer shows correct status for every PRD section, and a PRD section's commits are two clicks or fewer from it.
- Scrolling the PRD changes the spec cards and the lit stacks to the section at the top of the pane, and a pinned section stays current while the PRD scrolls.
- With models and reasoning on, every task shows the model and reasoning it ran with, or the plan's choice marked as planned; with it off, none shows.
- Opening a task shows its code in the detail panel without leaving the plan.
- `cairn lint` catches an orphaned section ID and an unmapped PRD section.
- A drafted task judged too large is broken down before the plan is printed, and the plan output says so.
- A task's model is changed only when Jev is confident; otherwise the planner's choice stands and is reported as `unsure`.
- A judgment on a task that has since changed shows as stale.
- With no `TYPESAFE_API_KEY`, `cairn plan` still writes the manifest and says that judging was skipped.
- In the code view, a hunk an agent wrote with its edit tools reaches the tool call that wrote it in one click, and a hunk written another way says it is not traced.

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

| State                  | Strategy                                 | Why                                                                      |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| PRD and spec prose     | Loro CRDT                                | Human and agent edits land concurrently and must merge without conflicts |
| Section IDs            | Loro marks on the text                   | IDs must survive concurrent edits around them                            |
| Task status and leases | LWW register with a hybrid logical clock | One writer per task (the orchestrator), so a CRDT is overkill            |
| Events                 | Append-only log                          | Nothing to merge                                                         |

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

A feature's PRD, spec, and stack live in a shared room. Humans and agents see each other's cursors and every change as it happens. Git and code stay on each machine; the room holds the document, statuses, and presence.

### Architecture {#prd.v2-multiplayer-on-cloudflare.architecture}

- One Durable Object per room (one feature). It holds the Loro document, applies updates, and fans them out over hibernatable WebSockets.
- Storage: Durable Object SQLite for updates and snapshots. R2 for version snapshots and opt-in redacted sessions.
- Single writer for LWW state: statuses and leases are written through the room's Durable Object, which serializes them.
- Local bridge: `cairn connect` links a repo's `.cairn/` to a room. It pushes events, commit SHAs, and session IDs, and pulls PRD and spec edits back to markdown on disk.
- Offline: the viewer still works on local files. Loro merges edits made while disconnected.
- Deploy: Worker, Durable Object namespace, R2 bucket, and the Foldkit site, all defined in Alchemy. Room tokens live in each room's storage, so no signing key is needed yet. Model keys never reach the server.

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

### Permissions {#prd.v2-multiplayer-on-cloudflare.permissions}

- Each room has one token: a plain string assigned when the room is created. Anyone with it can join.
- Clients declare whether they are a human or an agent. Gate approvals are only accepted from human clients and record who approved.
- This is trust-based and fine for v2. Signed, scoped tokens come later.

### Multiplayer acceptance criteria {#prd.v2-multiplayer-on-cloudflare.multiplayer-acceptance-criteria}

- Two humans and one agent see each other's cursors and edits in under 250 ms p95 within one region.
- Killing an agent process marks it away and stalls its task within 15 s.
- A gate approval from an agent client is rejected.
- Clients that edit offline converge on reconnect with no lost edits, property tested with random edits and partitions.
- `alchemy deploy` brings up a working room from an empty Cloudflare account.

## Later {#prd.later}

- Rich editing beyond markdown: embeds, comments, and inline diffs.
- A map of the whole plan on one screen: every PRD section, spec section and stack at once, with every curve drawn. The prototype has it as its Map variant.
- An inbox view of agent activity across rooms.
- Drift detection that flags or proposes spec updates when code diverges.
- Cost per section and per model.
- Judging during a run: before a task starts, and on its diff after it is done.
- Adapters for Vercel Board and other agent message boards.
