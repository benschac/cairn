# Cairn MVP {#prd.cairn-mvp}

A shared workspace for building from PRDs: write and discuss intent, turn it into a spec and stacked tasks, follow implementation, and share progress. Cairn is the working name; the product launches as prdddd. The hosted service is the primary signup experience, with an open-source, self-hostable option and a local CLI for repository and agent workflows.

## Goal {#prd.goal}

Given a markdown PRD in a repo, produce a spec and a stack manifest, let the existing orchestrator execute the stack, and show a live view of which PRD sections are done, in progress, blocked, or waiting on a human. Every commit links back to its PRD section and to the agent session that produced it.

A person can also sign up, create a workspace, write or import a PRD, invite collaborators, collect feedback and publish the document before connecting a repo or generating a spec. The PRD is useful on its own. The hosted launch scope below extends the original local MVP; accounts, whole-document sharing, comments and basic revisions are launch requirements, not deferred multiplayer features.

## Non-goals for v1 {#prd.non-goals-for-v1}

- No rich block editor, simultaneous collaborative text editing or automatic merging of offline text edits. Basic markdown editing and explicit save-conflict handling are enough for launch; live comments and agent progress are in scope.
- No section-level permissions, mixed public/private sections within one PRD, revision-specific guest review grants, or custom permission language. Access is granted to a whole PRD in v1.
- No Google Docs-style visual edit history, detailed per-character attribution or document branching UI. Durable revisions, a basic history list and restore are in scope.
- No agent-to-agent chat inbox. Coordination is orchestrator-assigned.
- No cloud-hosted agent execution or deployment of the software users build. Agents can run on their own machines and report into the hosted workspace. A workspace may hold PRDs connected to different repositories; one plan spanning several repositories is later work.
- No replacement of the existing orchestrator. This tool wraps it.

## Hosted launch {#prd.launch}

The launch promise is: create a workspace, bring your PRDs and collaborators, discuss the work, follow progress, and share what you choose. The normal path is visiting the hosted site and signing up; it requires no checkout, Cloudflare account or deployment. RinkSide remains a dogfood project, not a prerequisite for using the product.

### Workspaces and PRDs {#prd.launch.workspaces}

- Sign-up gives a person a personal workspace. They can create or join team workspaces and switch between them. A workspace owns its PRDs, membership, repository connections and subscription.
- A workspace holds multiple independent PRDs. People can create a PRD, import markdown, rename and edit it, find it in the workspace and export its markdown. A PRD without a spec, manifest, task or repository is a valid document with discussion and sharing available.
- Each PRD has a stable identity independent of its title, with its own sections, spec, tasks, comments, revisions and room. Local section/task names can repeat in other PRDs; routes and lookups include document and workspace context.
- The existing reader is the per-PRD view inside the workspace. Empty states explain how to add a first PRD and how to connect implementation when wanted. A customer's workspace never silently falls back to the bundled demo.
- Basic browser markdown editing is available at launch. A save names the revision it was based on; a stale save is refused with the current revision and the person's draft preserved, rather than overwriting another person's work.

### Members, guests and agents {#prd.launch.membership}

- Workspace members are regular collaborators. Invitations, acceptance, removal and simple owner/admin/member roles are available in the UI. Whole-PRD access distinguishes reading, commenting and editing; managing access and approving human gates require explicit authority.
- Guests are invited to named PRDs as viewers or commenters without becoming workspace members. A guest cannot browse other private PRDs or the workspace's private membership and activity merely because they have a document invitation.
- Private document access is explained by the sharing UI: which workspace members or invited people can read, comment or edit. An invitation is bound to its recipient and scope; knowing a private PRD's URL grants no access.
- Agents have separate identities attributable to a human, with scoped and revocable credentials. An agent's effective permissions cannot exceed its delegation or the delegating person's current access. Agent sessions are not automatically human seats, and agent credentials cannot approve human gates.
- Removing a membership, guest grant or agent delegation stops subsequent protected reads, writes and live updates, including on existing connections. Content already delivered cannot be recalled.

### Public and private PRDs {#prd.launch.sharing}

- A private PRD is available only to authorized members and invited guests. It is excluded from public discovery, search indexes and unauthenticated previews.
- A public PRD has a stable signed-out reading URL, can be indexed by search engines, appears in public discovery/search and has a useful title and social preview. Public means public, not an unlisted secret link.
- Sharing applies to the whole PRD. Comments inherit its visibility; anchoring a comment to a section does not create a section-level access rule. Public reading does not permit anonymous edits or comments: contributions require sign-in and the relevant grant.
- A person with sharing authority can change visibility. Before making a document public, the UI explains which current document content, discussion and associated planning views will become public. Code, agent transcripts and private repository access are separate permissions and are not enabled by publishing the PRD.
- Public access covers the current shared document and discussion, not an automatic release of every historical draft. Revision history remains available to authorized collaborators. Old comment anchors do not allow public readers to fetch a private revision; the UI makes clear that comment text itself becomes public.
- Changing a PRD to private stops new anonymous reads and removes it from Cairn's public discovery and caches. The UI explains that external copies and search-engine caches cannot be recalled immediately.
- Enforce visibility on the server for documents, comments, attachments, search, previews and live updates. Never deliver private data and rely on the browser to hide it.

### Comments and links {#prd.launch.discussion}

- Authorized people and agents can create comment threads, reply and resolve discussions on a PRD, a spec or an identified section/passage. Every thread and reply has a stable link and authenticated author. The room stores the discussion durably.
- An anchor records the document, section or passage and the revision it refers to. If the text changes or disappears, preserve the discussion and identify the changed anchor; show its original context only to someone authorized to read that revision. An agent may resolve its own notes, but resolving a human's note is a human operation.
- PRDs can link to other PRDs and their sections. A link does not grant access. Links and backlinks expose a target's private title, excerpt or activity only to someone allowed to read it; public pages and search do not reveal private neighboring documents.
- Live comment and task-status updates are in scope independently of simultaneous text editing. Reconnecting reloads authoritative state without losing committed comments or duplicating progress events.

### Revisions and history {#prd.launch.history}

- Every accepted PRD or spec edit creates a durable content revision with its author, time and predecessor. Content revisions are distinct from file-format schema versions. Plans and approvals record the input revisions they apply to, and comments retain their source revision. An edit or restore does not transfer an earlier approval to changed inputs.
- Authorized collaborators can list revisions and open an earlier version; restoring additionally requires document edit permission. Restore creates a new current revision and preserves intervening history; it never changes permissions, erases comments or silently resets task progress.
- If a document changes after planning, the viewer identifies the plan's source revision and that it is no longer current. Automatic replanning and restacking of an in-progress implementation after document changes remain the later diverging-state work. Existing user-invoked incremental and partial planning are unchanged.
- History and comments survive restart and deployment. Workspace activity feeds, detailed visual diffs and attribution, document forks, and revision-specific sharing are later enhancements rather than prerequisites for preserving versions now.

### Hosted plans and self-hosting {#prd.launch.plans}

- The managed service supports a free entry path and a paid workspace subscription, with checkout, billing management, cancellation and clear plan limits. The workspace is the billing unit; human member seats and allowed PRD counts are capacity dimensions.
- Plans can limit member seats, total PRDs and public/private PRDs independently. Exact prices, allowances, the free plan's private allowance and guest caps remain product choices to settle before sales. Guests and agents are distinct from member seats; inviting an occasional reviewer must not silently buy a full member seat.
- Enforce entitlements on the server and explain a reached limit before a paid or blocked action. Subscription changes never grant document access. Duplicate or delayed payment events must not grant duplicate capacity; downgrades and failed payments never publish or silently delete private work. Show the applicable grace/over-limit behavior and preserve export access.
- Self-hosting remains a supported option alongside the primary managed experience. The first supported team deployment can use the operator's own Cloudflare account with configurable domain, auth providers and storage, using the same application and permission model. It does not require a subscription to Cairn's managed service. Local CLI use alone is not the self-hosted team offering; a portable Docker/VPS deployment is not a launch promise.
- Provide signup and first-PRD guidance, a self-host deployment/upgrade guide, export and backup/restore instructions, and a support path. The managed launch must exercise restoring persisted documents, revisions and discussions before relying on them for customer work.

### Launch acceptance {#prd.launch.acceptance}

- A new user signs up without a checkout, creates a workspace and two PRDs, and reads, edits, exports and discusses either without generating a spec or manifest.
- A member accepts an invitation and collaborates; a guest comments on one invited PRD and cannot discover another private PRD. A user in another workspace cannot read either through APIs, links, search or live subscriptions.
- A public PRD opens signed out with share metadata and appears in public discovery. Making it private denies new anonymous access; neither state reveals an inaccessible linked PRD, private historical revision, repository code or agent transcript.
- Two people saving against the same base revision cannot overwrite each other's work silently. Earlier versions and their comment anchors remain readable by authorized collaborators; restoring creates a new revision and preserves task history.
- An authorized local agent reports progress into the correct PRD. Revoking its credential or a person's access stops subsequent protected operations and updates on an open connection; an agent cannot approve a human gate.
- A workspace can purchase and manage the paid plan. Seat and PRD limits are enforced under concurrent requests, duplicate payment events do not duplicate entitlements, and cancellation or payment failure does not expose or erase private data.
- A new operator follows the self-host guide in their own account and restores a backup containing PRDs, comments and revisions. The packaged/local viewer shows their data rather than the marketing demo.

These are the hosted release gates. The existing local planning requirements remain part of the product, while advanced routing experiments, terminal features and the explicitly later collaboration features do not all have to ship before this launch.

## Repo layout {#prd.repo-layout}

This is the local representation for one plan, used by the CLI and the hosted bridge. Hosted workspace/document identities and revision storage are separate; supporting multiple hosted PRDs does not require changing this local layout at launch.

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
- `cairn watch` shows the run live in the terminal (see terminal view). {#prd.cli.watch}
- `cairn mcp` starts a local MCP server for the current repo over stdio (see agent access). {#prd.cli.mcp}

## Agent access {#prd.agent-access}

An agent can use Cairn through the CLI or through MCP. The CLI remains a complete interface for people and agents with shell access. A short Markdown guide or skill explains the workflow, the review checkpoints and how to recover from errors. MCP adds discoverable tools with structured inputs and results for clients that support it; neither interface requires the other.

The first step is a local adapter over Cairn's commands, independent of hosted rooms or multiplayer. CLI commands and MCP tools call the same operations and use the schemas in `contract`, so validation, file writes, redaction and gate rules stay the same. The adapter does not construct shell commands or parse terminal output.

- Expose each available agent-usable command operation as a named tool with a description, input and output schemas, structured results and actionable errors. Add tool coverage as commands ship; do not advertise unimplemented commands. Commands that only launch the CLI or MCP transport are not tools themselves.
- Bind the server to one repo at startup. Tool calls cannot switch it to an arbitrary repo. Start with stdio, with protocol messages on stdout and logs on stderr; remote HTTP access and authentication are later work.
- Distinguish reads, local writes, model calls that incur cost and external writes in tool descriptions and metadata. Metadata describes the operation; the shared operation enforces its rules.
- Preserve planning's questions and two review checkpoints. A call that needs a decision returns what needs review and how to continue, rather than waiting on a terminal prompt. Continuation applies to the reviewed revision and refuses a stale decision. Do not silently enable `--yes` or treat calling a tool as approval.
- Human-only operations such as gate approval remain human-only and are not exposed as agent tools. The agent receives the blocked state and the human action needed to continue.
- Long-running work reports progress and supports cancellation. Starting the viewer returns its address without holding the tool call open; stopping the MCP server cleans up processes it owns. A cancelled or failed operation reports any changes already made.
- Include setup instructions for a local MCP client and the CLI workflow guide. Both explain the same operations and limits; users do not need an MCP client to use Cairn.

Done when:

- A local MCP client discovers the implemented tools, initializes a scratch repo, assigns IDs, plans through the review checkpoints, lints and reads status without invoking a shell itself.
- Equivalent CLI and MCP operations produce the same project state and validation failures on the same fixtures.
- A planning call pauses for review, resumes only against the reviewed revision and cannot approve a human gate.
- Logs do not corrupt the stdio protocol, and cancelling work or disconnecting leaves no owned process running or unreported partial write.

An agent planning as a participant in a shared room through remote MCP is a later extension of this interface, not a prerequisite for local MCP access. Authenticated local agents reporting progress through `cairn connect` are part of the hosted launch and do not require remote MCP.

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

### Planning a part {#prd.planning.part}

A PRD holds more than one feature, and a person usually wants one of them built next. `cairn plan` can plan one part of the PRD and leave the rest for a later run.

- `cairn plan <id>...` plans only the PRD sections named and the sections under them: spec sections for the ones nothing covers, then tasks for the spec sections that implement them. An ID is the one the viewer copies from a heading or a list item, so a person copies it and pastes it: `cairn plan prd.deep-links`. With no ID, `cairn plan` plans the whole PRD, as before.
- The planner still reads the whole PRD, spec and manifest, so a new task can depend on a task the manifest has and a spec section can name other sections as context. What it writes stays inside the part named.
- It plans exactly what is named. When the part needs something outside it that is not planned yet, the spec section says what it assumes, and the other part is left for its own run.
- Sections outside the part stay as they are. `cairn lint` still reports any that nothing covers: nothing is deferred to make a run smaller.
- Stale sections and tasks are reported across the whole plan, as on any run. The questions about done-when statements, and the spec sections planning again writes again, stay inside the part.
- An ID that no heading or list item in `prd.md` has is refused before anything is planned, and the refusal names it.

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

### Session cost estimates {#prd.outcomes.session-cost}

A person can see what a session would have cost at API prices and how much subscription allowance it used. These are separate estimates, not billed cost. A subscription attempt keeps cost `null` for the existing cost metrics.

- Start with Codex usage records explicitly linked to Cairn session IDs and tasks. Record actual model IDs and reasoning settings per call, including changes within a session. The planned model is not evidence of what ran; missing usage remains unknown.
- Calculate `API-equivalent cost` from each call's uncached input, cached input and output using dated model rates, with applicable cache-write, service-tier and context-length pricing. Reasoning tokens already included in output are not charged again; reasoning level is not another price multiplier. Keep the rate source, effective date, assumptions and usage coverage. Missing prices produce a partial estimate or an unknown value, never a guessed price. Identify excluded tool charges.
- Normalise cumulative snapshots before summing usage. Reimporting or resuming a session, or linking several commits to it, must not count usage again. Include linked subagent, retry, review and repair sessions once. Shared sessions need an explicit allocation before assigning their costs to individual tasks; unassigned usage remains unassigned.
- Store subscription allowance snapshots with their observation time, usage percentage, window, reset time and allowance identity. Show the provider-reported account allowance used and remaining. Do not assume a fixed weekly token cap or derive one from API prices. Keep separate allowance windows separate.
- Estimate a session's allowance consumption only when snapshots cover the same allowance and reset window and the change can be attributed to that session. Concurrent sessions, other devices and other products may share the account allowance. When they cannot be separated, show the account change as context and the session share as unknown. Explain rounding and missing snapshots; a reset must not produce negative consumption.
- Optionally show `Allocated subscription cost` when the person supplies their fee, currency, billing period and the share to allocate to Cairn. Distribute that budget among included sessions in proportion to their API-equivalent estimates for the period. State the method and coverage; an open period is provisional. Missing estimates or a zero denominator leave allocation unknown. This accounting allocation is neither a provider charge nor a measurement of allowance consumed, and does not enforce a spending cap.
- Keep usage and estimate provenance beside the session in `cairn.db`, subject to redaction. Account allowance and subscription fee details stay local and are excluded from public demos and shared exports by default.

Done when:

- Cached input and reasoning output yield a reproducible estimate with no double counting, even when the model changes mid-session. Missing rates leave a visible gap in coverage.
- Importing a session twice or linking two commits to it leaves the task total unchanged. A linked subagent contributes once.
- A subscription session displays an API-equivalent estimate while billed cost stays unknown. Concurrent activity that prevents attribution leaves its allowance share unknown, and a reset cannot create negative usage.
- A complete billing period's configured budget is allocated reproducibly; incomplete data or a zero denominator cannot produce a misleading dollar allocation.

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

## Relations {#prd.relations}

A plan is a graph, not a list. A task needs other tasks, builds spec sections and names PRD sections. A spec section implements PRD sections and list items. A test proves a statement. A person reading one PRD section wants to know what has to be built before it, what waits on it and what can start now, and an agent picking up a task wants the same. Cairn answers these questions from one index, so the viewer, the CLI and the orchestrator cannot give different answers to the same question.

### Kinds {#prd.relations.kinds}

A relation has a kind and two ends. An end is a task, a spec section, a PRD section, a list item, a statement or a test, named by its ID.

| Kind          | From         | To                  | Recorded in                                                    |
| ------------- | ------------ | ------------------- | -------------------------------------------------------------- |
| needs         | task         | task                | `dependsOn` in the manifest                                    |
| built on      | task         | task                | `parent` in the manifest                                       |
| ordered after | task         | task                | the manifest's conflict ordering (see conflict-aware ordering) |
| builds        | task         | spec section        | `specSections` in the manifest                                 |
| names         | task         | PRD section or item | `prdSections` in the manifest                                  |
| implements    | spec section | PRD section or item | `Implements` in the spec                                       |
| depends on    | spec section | spec section        | `Depends on` in the spec                                       |
| proves        | test         | statement           | the spec section's tests (see done when)                       |

- The kinds are declared once, in the contract. More will come, between tasks first. Adding one changes that declaration and the file that records it, not each place that reads relations.
- The files in `.cairn/` stay as they are: flat lists whose entries name each other by ID. No file stores the graph.

### Between sections {#prd.relations.sections}

Nobody writes down that one PRD section needs another. It follows from the tasks.

- A PRD section or list item needs another when one of its tasks needs a task of the other, and that task is not also one of its own.
- The link carries the pairs of tasks that make it, so a person can check why it is there.
- A section's links include its list items' links, as its status does.
- The answer is the direct links unless a person asks for more. Everything before a section, or everything after it, is given on request, in build order.

### The index {#prd.relations.index}

- `@cairn/core` builds the index from the manifest and `spec.json`, or from a trace, with one function that reads nothing else. It is built again when either changes and is never saved.
- For any ID and any kind it answers both ways: what this points at, and what points at it.
- For the kinds between tasks it also answers everything a task needs, directly or through other tasks, everything that needs it, and an order in which the tasks can be built.
- A pending task can start when every task it needs is `done` or `landed`. For any other pending task the index names the unfinished tasks it waits on, and for any task the unfinished tasks that wait on it.
- A relation whose other end does not exist is left out and reported by `cairn lint`. A cycle in what tasks need is a lint error that names the tasks in it.
- Every part of Cairn that asks one of these questions asks the index: `cairn lint`, `cairn status`, the stack layout, the orchestrator's choice of what to start, and the viewer. None of them works an answer out again from the files.

Done when:

- Making t71 depend on t73 in this repo's manifest fails `cairn lint` with an error that names t71, t72 and t73 as a cycle.
- A task whose only unfinished dependency is marked done shows as able to start in `cairn status` and in the viewer at the next read, with no other file changed.

## Redaction {#prd.redaction}

Before writing session JSONL, strip values matching env var names from `.env*`, common token patterns (API keys, bearer tokens, private keys), and anything in a user-supplied deny list. Log redaction counts per file. Fail closed: if redaction errors, do not write the session.

## Viewer {#prd.viewer}

The same per-PRD reader runs in the hosted workspace and locally through `cairn serve`. The local trace view polls or watches `.cairn/` and git. The hosted workspace adds document creation, basic markdown editing, discussion, history and sharing, as defined in Hosted launch. Reading a PRD does not require a spec or stack; their panes become available when those artifacts exist.

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

Suggested stack: Foldkit SPA for the viewer and a markdown renderer that preserves heading IDs. The local Node server exposes `.cairn/` files, `git log --format` with trailers and reads from `cairn.db`; the hosted Worker provides authenticated workspace and document operations. Demo, local and hosted data sources are selected explicitly, not inferred from whether the bundle is a production build.

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

### Cost on the graph {#prd.viewer.cost}

- In the task detail panel, below model and reasoning and before commits and code, show `Usage and cost` for the linked sessions (see session cost estimates): API-equivalent cost and attributable subscription allowance consumed. Expanding it lists sessions, actual models and reasoning, token categories, billed cost when known, optional allocated subscription cost, pricing sources and estimate coverage. Account-wide allowance is labelled separately. A task with no usage says `Usage unavailable`, not `$0`.
- A task row in a spec card shows a compact estimate beside its model and reasoning, such as `API est. $0.42`. Clicking it opens the task detail's cost breakdown. Selecting the task's chip in the stacks reaches the same details.
- A spec card's header shows the API-equivalent total for its distinct linked tasks, with partial coverage stated when usage or prices are missing. Its breakdown identifies contributing tasks and sessions. Shared sessions contribute only their assigned share; repeated references do not add cost. Cards can overlap, so adding their totals is not a feature total.
- Subscription percentages retain their labels. Only attributable usage contributes to a task or card's percentage, and only within the same allowance and reset window. Never repeat an account-wide percentage as though each task consumed it.
- At narrow widths, move cost to a second line before hiding the task title, model or status. Labels and details work by keyboard and pointer without relying on hover.

Done when:

- A person sees an estimate beside a task's model on a spec card, opens its breakdown in the right-hand panel, and reconciles it with the card header's total.
- A card with one priced task and one task lacking usage shows a partial total and coverage. Multiple references to the same session do not inflate the total.
- Keyboard navigation exposes the same cost details, and narrow panes keep cost labels and task titles readable.

### What depends on what {#prd.viewer.dependencies}

A person reading a section can check, without leaving the PRD, what it waits on and what waits on it. That tells them what has to be done, in what order, and what can be started today. Every answer comes from the index (see relations), the same one that draws the arrows in the stacks, so the two never disagree.

- A section's status line and a list item's annotation end with its links: how many sections it needs and how many need it, such as `needs 3 · needed by 1`. A section with unfinished tasks also says how many of them can start now, such as `2 ready`, or `waiting` when none can.
- Clicking the links opens a list under the heading. It does not pin the section. Clicking again, or Escape, closes it.
- `Needs` lists the sections and items this one needs, each with its status and the pairs of tasks that make the link, such as `t95 needs t94`. `Needed by` lists the ones that need it, the same way.
- `Next` lists this section's unfinished tasks in the order they can be built. The ones that can start now come first. Each of the others names the unfinished tasks it waits on.
- Clicking a section or an item in the list scrolls the PRD to it and marks it. Clicking a task opens the task detail. Hovering an entry lights its tasks in the stacks.
- The list shows direct links. A switch in it shows everything before the section and everything after it instead, in build order.
- The task detail lists the tasks that depend on the task beside the ones it depends on. For a pending task it says whether it can start and, when it cannot, which unfinished tasks it waits on.

Done when:

- On this repo, opening the links of the Fuzzy search section lists Task detail under `Needs` with `t95 needs t94`, and opening the links of Task detail lists Fuzzy search under `Needed by`.
- A section whose unfinished tasks all wait on another section's tasks says `waiting`, its `Next` list names those tasks, and it says `1 ready` once they are done.

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

People and agents leave notes on the document, plan and code: a question about a PRD or spec section, a review finding on a line, a remark on a task. The viewer shows them where they are about. Hosted v1 includes creating threads, replies and resolving discussions; a note does not need an agent session or an implementation task (see Comments and links and Notes in the room).

- A note has a kind (`note` or `review`), an author, a body in markdown, whether it is open or resolved, and an anchor: the deep link to what it is about, such as a PRD passage, a spec section, a task, a commit or a line of a diff.
- Agents and the orchestrator write notes with `cairn note`, which stores them in `cairn.db` (see the orchestrator contract). The second-model review of each pull request writes its findings as review notes on the lines they are about.
- A note shows as a marker where it is anchored: beside the passage or the spec section, on the line in the diff, on the task's row and chip with a count of open notes. The task detail lists the task's notes, and each note opens its link.
- A note whose anchor no longer resolves shows in the task detail, or under its section, with the step that is missing (see deep links).
- A resolved note is hidden until a person asks to see resolved notes.

## Code view {#prd.code-view}

The reader shows where the work stands. The code view shows the work itself: the code each task changed, beside the agent conversation that changed it. The code view is read-only; hosted document editing and discussion happen in the workspace.

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

## Terminal view {#prd.terminal}

`cairn watch` shows where the run stands without leaving the terminal. It is a second reader of the Trace the viewer reads, the one `cairn status --json` prints, and holds no state of its own. This terminal view is read-only: it starts, stops and retries nothing, because the orchestrator runs the tasks and Cairn does not. Closing it changes nothing about the run, and any number of terminals and browsers can watch the same repo at once.

It is for hierarchy and status, not for the viewer's curves or its code view. For those it prints the link `cairn link` would.

Layout:

- Top line: the feature's name, then counts of tasks by status (pending, running, blocked on a human, failed, done, landed), the cost so far where the events carry it, and the time since the first event.
- Left: the stacks as a tree, each task with its status and gate marker, in the order `cairn status` prints them. Tasks waiting on a human are also listed first, above the tree.
- Right: the selected task: its PRD and spec sections, branch and worktree, the model and reasoning level it ran with beside what the plan chose, its attempts with their usage and cost, its events in order, its gate reasons and its commits with their session IDs.
- Bottom line: the keys that apply to the selection.

A terminal too narrow for both panes shows the tree alone, and Enter opens the task in place of it.

### Keys {#prd.terminal.keys}

- Up and down, or `j` and `k`, move the selection. Enter opens the selected task and Escape returns to the tree.
- `/` filters the tree by task ID, title or section ID as it is typed. `f` cycles a status filter.
- `o` opens the selected task in the viewer, at its deep link, when `cairn serve` is running; otherwise it shows the link.
- `?` lists the keys. `q` leaves.

A key that does not apply to the selection is not shown and does nothing.

### One model, two views {#prd.terminal.shared}

- The terminal view is built the way the viewer is: a Schema-defined Model, fact-named Messages, one `update` and one `view`. Only `view` knows about the terminal.
- Counts, rollups, tree order and status derivation come from `core`, the same functions the viewer and `cairn status` use. Neither interface computes its own.
- It follows `.cairn/` and git the way the viewer's server does, as a Stream of Traces. A change redraws only what changed, and a burst of events is drawn once, not once per event.
- Memory does not grow with the length of the run: it holds the current Trace and the selected task's events, not a log of everything seen.
- After an interruption, such as a sleeping laptop or a rewritten `events.jsonl`, it reads the Trace again from the files. There is nothing to reconcile, because it kept nothing.

### Terminals {#prd.terminal.terminals}

- When stdout is not a terminal, `cairn watch` draws nothing, exits with an error and names `cairn status --json`. It never prompts.
- It honours `NO_COLOR`, uses colour only beside a symbol or a word that says the same thing, and falls back to ASCII symbols where the terminal does not report UTF-8.
- It redraws on resize.
- On `q`, on Ctrl-C and on a failure it restores the terminal: the main screen, the cursor and the input mode. Its fibers and file watchers live in one Scope that closes on every exit.
- A failure in the terminal view cannot touch the run, since it only reads.

### Rendering library {#prd.terminal.library}

A spike chooses the library before the view is built. The library must run on every Node version Cairn supports with no experimental flag, install from npm with no build step on macOS, Linux and Windows, need no UI framework, and render to memory so a test can assert on a frame.

[OpenTUI](https://opentui.com/docs/) is the first candidate, through its framework-independent core. As of November 2026 its documentation asks for Node 26.4 with `--experimental-ffi`, which fails the first requirement. If that still holds at the spike, the view is drawn with [Terminal Kit](https://github.com/cronvel/terminal-kit) or plain ANSI output behind the same `view`, and OpenTUI can replace it later without touching the Model or `update`.

Done when:

- `cairn watch` on this repo shows the same statuses and counts as `cairn status` and the viewer, and a line appended to `events.jsonl` changes the tree without a key press.
- Every key above is exercised by a test that sends the key to `update` and asserts on the rendered frame, including a key that must be ignored.
- A test renders the same Trace at a wide and a narrow size and gets the two layouts.
- A fixture of several hundred tasks and a burst of several thousand events keeps the selection moving and does not grow memory with the number of events.
- Leaving by `q`, by Ctrl-C and by a thrown defect each restores the terminal and leaves no watcher open.
- `cairn watch` piped to a file writes no escape sequence and exits non-zero.

## Deep links {#prd.deep-links}

Everything the viewer shows has a link, and links compose, so a person can send someone to an exact point: this passage of the PRD, then the spec section that implements it, then the line of the stacked diff that builds it.

Hosted links include the workspace and PRD identity; links to stored revisions and comments identify those resources too. A reference between PRDs does not imply a task dependency or grant access. Local links resolve within the current project, and the bridge maps them to the corresponding hosted document.

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
- A link's trace steps use the same syntax locally and in the hosted viewer. The enclosing project/document mapping determines which plan they address; a link to a customer's PRD never resolves to the demo merely because the section IDs match.
- Links are the viewer's Foldkit routes. One definition both reads a link and writes it, so a link the viewer copies always opens on the same steps, and every ID in it is decoded through its contract schema.
- Opening a link in a new window loads everything its steps need, the same as clicking through them: the patches for a diff and the session for a turn.

### Links that no longer resolve {#prd.deep-links.missing}

- Authorization is checked before resolving or describing a protected target. An unauthorized link shows a non-revealing unavailable state without private titles, excerpts or revision metadata.
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

The hosted release gates are in Launch acceptance. These criteria describe the existing local planning and trace capabilities and their follow-up work; they do not move explicitly deferred features into the hosted launch.

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
- A PRD section's links list the sections it needs and the sections that need it, each with the tasks that make the link, and its unfinished tasks in an order they can be built with the ones that can start now first.
- `cairn lint`, `cairn status` and the viewer give the same answer to what a task waits on, property tested over generated manifests, and a cycle in what tasks need fails `cairn lint` with its tasks named.

## Original local build order {#prd.one-day-build-order}

This is the historical local MVP sequence, not a duration estimate or release checklist for the hosted product. The hosted launch adds workspace/document identity, membership and access, discussion and revisions, sharing and live progress, then paid-plan operation and onboarding. Its acceptance criteria are above.

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

Launch already preserves content revisions, rejects stale saves and shows live agent progress. This later extension adds simultaneous text editing, automatic offline merging, document branching and automated handling of plans whose PRD moves mid-stack. Each kind of state gets the strategy that fits it.

| State                                                | Strategy                              | Why                                                                                               |
| ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PRD and spec prose                                   | Loro CRDT                             | Human and agent edits land concurrently and must merge without conflicts                          |
| Section IDs                                          | Loro marks on the text                | IDs must survive concurrent edits around them                                                     |
| Events, task status, leases, notes and agent notices | Effect `EventLog`, one store per room | One writer per task, so status is a projection of ordered events, not a merge (see the event log) |
| Presence                                             | Ephemeral, on the presence socket     | Cursors and heartbeats are never persisted                                                        |

Yjs stays an option for the editor if Loro's bindings fall short. Strategies can coexist per field.

### Versioning and branching {#prd.v2-diverging-state.versioning-and-branching}

- Launch content revision identities remain stable. The later Loro representation maps its versions to those revisions; the manifest's source revision identifies the PRD it was planned from rather than reusing the file-format version.
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
- Clients that edit text offline converge on reconnect with no lost edits, property tested with random edits and partitions; this is a later capability beyond launch save-conflict handling.
- Editing one PRD section mid-stack marks only that section's chain stale.
- A rebase restacks only the affected branches.

## Hosted collaboration on Cloudflare {#prd.v2-multiplayer-on-cloudflare}

A PRD and its associated spec and stack live in a shared room within a workspace. Launch includes authenticated membership, whole-PRD guest access, comments, accepted revisions and live agent progress. Simultaneous text editing and offline merges remain later work. Code and sessions stay in the team's git remote; the room holds document history, discussion, statuses and presence, and fetches an authorized diff or session only to show it (see Code and sessions in the room). Existing section IDs retain their `v2` names so links survive this scope change.

### Architecture {#prd.v2-multiplayer-on-cloudflare.architecture}

- A shared Worker application handles auth, workspace/document APIs and billing. Workspaces do not each require their own application deployment. The Foldkit frontend loads customer data from those APIs; serving the bundled demo alone is not the hosted service.
- One [Durable Object](https://developers.cloudflare.com/durable-objects/) per PRD room accepts revision-checked edits and ordered events, and sends authorized updates over [hibernatable WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). Later collaborative text editing can add [Loro](https://loro.dev/) without changing document ownership or access boundaries.
- Storage: each room's Durable Object SQLite owns document revisions, comments/replies, anchors and its event log. [R2](https://developers.cloudflare.com/r2/) holds large snapshots and files attached to notes, referenced by the room. Shared [D1](https://developers.cloudflare.com/d1/) holds accounts, workspace membership/invitations, the PRD directory, access grants and hosted billing metadata. These are distinct stores with explicit authority; none holds code or a session log (see Code and sessions in the room).
- Statuses and leases are events written through the room's Durable Object, and its sequence orders them (see the event log).
- Local bridge: `cairn connect` maps a repo's `.cairn/` to a specific workspace and PRD room. It sends authorized events, commit SHAs and session IDs and synchronizes document revisions with markdown. A conflicting local/hosted revision is reported with the local draft preserved; reconnecting does not silently replace either side.
- Offline: the local viewer still works on local files. Automatic offline text merging is a later extension; launch reconnects by fetching authoritative state and submitting changes against their expected revision.
- Deploy: Worker, Durable Object namespace, R2 bucket, D1 database, email delivery and the Foldkit site are defined in [Alchemy](https://alchemy.run/). Authentication secrets survive deployments; OAuth, billing and other service credentials remain server-side. Users' local model keys never reach the hosted server.

### Event log {#prd.v2-multiplayer-on-cloudflare.event-log}

A room durably orders its accepted events behind a Cairn Effect service. Effect's `EventLog` ([`effect/eventlog`](https://github.com/Effect-TS/effect/tree/main/packages/effect/src/eventlog)) is a candidate implementation subject to the spike below, not a prerequisite for launching comments and progress.

- The events are the contract's schemas: task status changes, leases, gate approvals, conflict holds and the orchestrator's notices to agents. Task status, the viewer's trace and the conflict scores are handlers that project them.
- Each room is one store. Each human and each agent is its own identity, and the server checks every write against it: a gate approval from an agent is refused, and only the orchestrator writes notices to agents.
- The room runs the unencrypted server, so it can run handlers, enforce those rules and score conflicts. Its entries live in the Durable Object's SQLite.
- Launch clients resynchronize committed state on reconnect and use stable event IDs so retrying does not duplicate an accepted operation. The server's sequence orders a room's events; no client's clock decides. Writable offline journals and automatic reconciliation are later extensions, and replayed writes must still pass current permissions.
- `.cairn/events.jsonl` stays the orchestrator's interface (see orchestrator contract). `cairn connect` writes each new line into the room's log, and `cairn serve` reads the same events without a room.
- `EventLog` is marked unstable. Cairn reaches it through one service of its own, so an Effect upgrade that changes it touches one module.
- Document bodies live in revision storage; events may reference their revision IDs. Presence is ephemeral rather than durable document history. Later Loro updates remain separate from task-status events.

A spike proves the fit before choosing that event-log implementation: one Durable Object running the event-log server on its own SQLite, with a browser client and a CLI client. If it misses the latency target or loses events when the Object hibernates, use a room-owned durable event store behind the same service. Comment durability, ordering, retry deduplication and reconnect behavior remain required whichever implementation is chosen.

### Notes in the room {#prd.v2-multiplayer-on-cloudflare.notes}

Launch rooms support the threads, replies and resolution described in Comments and links. Discussion can exist before a spec, task or agent session.

- Discussion operations are persisted by the room. Concurrent replies have distinct identities; a conflicting edit to one comment is refused without losing the draft. An event log alone does not merge concurrent comment fields.
- A passage anchor holds its section, quoted text and source revision; other anchors use deep links. Missing or changed text leaves the discussion accessible with an explanation. Following text through concurrent Loro edits is later work.
- A note's author is its writer's identity. An agent may resolve its own notes; only a human resolves a human's note.
- Files attached to a note, such as a screenshot, are stored in R2.
- `cairn connect` sends the notes in `cairn.db` to the room, and pulls the room's notes back.

### Presence {#prd.v2-multiplayer-on-cloudflare.presence}

Presence is ephemeral and never persisted. At launch it identifies participants, their reading/focus location and agent activity. The richer caret and Loro cursor example below belongs to the later simultaneous-editing extension:

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

- Humans: at launch, their name beside the PRD section they are reading. Text carets and selections shared during simultaneous editing are later work.
- Agents: a labeled caret on the section they work from, a pulse on their stack node, and the file they are in. Agent presence comes from orchestrator events, so agents need no browser.
- Heartbeats: every 5 s. Three missed marks the actor away. A lost presence connection does not itself authorize a second agent to execute the task; task and lease changes follow the authoritative execution policy.

### Accounts {#prd.v2-multiplayer-on-cloudflare.accounts}

A person signs in to the application and owns or joins workspaces. The room receives their authenticated identity and authorized document access. Public PRD reading requires no account; commenting, editing and private access do. The managed and self-hosted team applications use the same account model. Local single-user `cairn serve` remains independent of hosted sign-in.

- Sign-in is [Better Auth](https://www.better-auth.com/), run in the application's Worker through [Alchemy's Better Auth integration](https://alchemy.run/better-auth/what-is-better-auth/). Its users, linked accounts, sessions and one-time tokens live in [D1](https://alchemy.run/better-auth/databases/cloudflare-d1/). Its organization membership/invitation model maps to workspaces; whole-PRD guest grants and content permissions belong to Cairn's policy service. OAuth apps, email delivery, managed billing and optional GitHub App credentials are configured by the operator.
- Three ways in, none with a password: [GitHub](https://www.better-auth.com/docs/authentication/github), [Google](https://www.better-auth.com/docs/authentication/google), and a [magic link](https://www.better-auth.com/docs/plugins/magic-link) sent by email. A link works once and expires after five minutes.
- Magic links are sent with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), from a sending subdomain of the site's domain, through Alchemy's `Cloudflare.Email.Send` binding. Email Service is in beta; if it cannot send to any address, a transactional email provider takes its place behind the same service.
- One person is one user. A sign-in joins the user that already has its email when the provider has confirmed that email ([account linking](https://www.better-auth.com/docs/concepts/users-accounts)), so GitHub, Google and a magic link to the same address reach the same user. No provider is trusted to link an email it has not confirmed.
- A profile is the name, email and picture the first sign-in brings. There is no profile page. A person's cursor color comes from their user ID.
- `cairn connect` signs in once through the browser with [device authorization](https://www.better-auth.com/docs/plugins/device-authorization) and keeps the session on the person's machine.
- The OAuth client secrets are Alchemy config bindings. None is in the repo.

### Permissions {#prd.v2-multiplayer-on-cloudflare.permissions}

- A focused Effect policy service decides whether an authenticated human, delegated agent or anonymous public reader may perform an action on a workspace, PRD or related resource. Rules use simple roles, workspace membership and explicit whole-document grants, and deny access unless a rule permits it. A generic policy language or a separate SpiceDB deployment is not required for launch.
- The same rules govern HTTP requests, document operations, comment/history reads and writes, search and live subscriptions. A private room has no shared token that substitutes for membership. Subscription entitlements are separate from authorization.
- The server establishes whether a writer is a human or an agent; a client-supplied presence kind never determines authority. Each registered agent has a credential scoped to its assigned resources/actions and records the person it acts for. The local bridge keeps agent credentials separate from the human sign-in and does not expose human approval operations through agent tools.
- Gate approvals are accepted only from authorized human identities and record both the user and the reviewed inputs. Agent credentials cannot approve a gate even when the delegating user can. This does not claim to isolate a human's credentials from arbitrary software already able to read that person's machine.
- Membership and grant changes invalidate subsequent protected access across Worker and room operations, including established sockets. Authorization caches must not keep a revoked grant effective. Permission checks and protected writes have a defined ordering so a stale decision cannot authorize a later operation after revocation.

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
- The hosted viewer has no checkout to read. For a public GitHub repository, the room's Worker fetches diffs directly from GitHub's REST API without requiring an App installation, a GitHub sign-in or a personal access token from the reader. Cairn's document and code/session permissions still apply; anonymous PRD reading alone does not grant transcript access. Publicly available shared sessions use the same fetching path only when authorized for that audience.
- Public API requests are authenticated server-side by default. When a person has signed in with GitHub and Cairn has a valid OAuth access token, the Worker uses that token: the normal REST allowance is 5,000 requests per hour per user, shared with other requests made on that user's behalf. Signing in alone does not raise the limit; the API request must carry the token.
- For people signed in through Google or email, anonymous readers authorized for the public material, or anyone without a usable GitHub user token, the Worker fetches public data using Cairn's OAuth app client ID and client secret. The normal allowance is 5,000 requests per hour per OAuth app, shared across these users. This requires no GitHub App installation and grants no private repository access. OAuth app secrets and user access tokens stay server-side and never appear in browser responses or logs.
- For a private repository, showing code is optional. The team installs a GitHub App on its personal account or organisation and grants access to selected repositories, with read-only Contents permission and GitHub's required Metadata permission. Connecting one of those repositories to a room explicitly enables its code access; signing in with GitHub alone does not grant it.
- The Worker uses short-lived installation access tokens scoped to the connected repository. The App's private key and tokens never reach the browser. It passes fetched code and sessions to the browser and writes them to no storage and no log.
- When a person opens a private diff or session without the required installation or repository access, the pane explains what is missing and offers to install the App or update its repository selection. A person who cannot install it on the organisation is sent to GitHub's request to an owner; Cairn shows access as pending until GitHub grants it.
- Both paths respect GitHub's rate limits and retry guidance. An exhausted limit shows a temporary unavailable state and when to retry, rather than an empty diff or an installation requirement. Unauthenticated REST requests, if used as a fallback for public data, have only 60 requests per hour per originating IP; the hosted service does not depend on that allowance for normal use. These are GitHub's normal primary limits, not fixed guarantees: Enterprise allowances can differ, secondary limits still apply, and the Worker follows the response rate-limit and retry headers. See [GitHub's REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- Diffs use the recorded base and head commit IDs, with the same task and commit boundaries as the local code view. A missing commit or a truncated, oversized or unavailable patch is labelled explicitly; a partial diff is never presented as complete.
- The PRD, the spec, statuses, notes and presence need no App.
- A commit that has not been pushed shows as not pushed, with no diff.

Who sees them:

- Public repository code needs no per-member GitHub authorization, but Cairn still checks the requested resource's visibility. For private repositories, code and sessions are shown by default only to authorized collaborators whose GitHub account can read the repo, checked with GitHub when they open one.
- The person who connected the private repo, with authority to manage its sharing, can explicitly open code and sessions to the PRD's authorized collaborators, after being told which members and guests receive access even without repository access. Anonymous public readers are not included by that grant. This is how an invited person with no GitHub seat sees them.
- A member who may not see them still sees every status, and the pane says why the code is hidden.

What Cairn can read:

- PRDs, specs, revisions, notes, statuses and events are stored in the room, and attachments or large snapshots may be in R2, so the hosted service can read that content at rest. D1 holds account, workspace, access and billing metadata. Code and session logs remain excluded from those stores. Cloudflare encrypts stored data at rest, and a team on the hosted service is offered a data processing agreement.
- Code and sessions pass through the room's Worker on the way to the browser, so the hosted room could read them in passing. It keeps neither. Disconnecting a private repository, removing it from the installation, or uninstalling or suspending the App stops subsequent private code and session reads. Content already delivered to a browser cannot be taken back. Public repositories remain readable through the public API.
- A team that accepts neither runs the room in its own Cloudflare account with `alchemy deploy`, with a GitHub App it registered itself. Cairn's hosted service then never sees the repo.
- The App's ID and private key are Alchemy config bindings, like the OAuth client secrets. None is in the repo.
- GitHub is the only git host the hosted viewer reads at first.

A spike proves the fit before this is built: from a Worker, the App reads a commit's patch and a 20 MB session under `refs/cairn/sessions/` through GitHub's API. If GitHub will not serve those refs, sessions go on one branch, `cairn/sessions`, that no stack is built on, and the rest stands.

Done when:

- A signed-in room member with no checkout or GitHub account opens a task from a public repository and sees its diff without installing an App.
- Public diff requests use a valid GitHub user OAuth token when available, and otherwise the server's OAuth app credentials, including for Google and email sign-ins. Neither credential reaches the browser or logs; exhausted budgets show when to retry.
- A person who signs in to a room in a browser, on a machine with no checkout, opens a private task and sees its diff and shared agent session once the team enables access through the App and the person meets the room's code permissions.
- Before the App is installed for a private repository, the same person reads the PRD and the spec and sees every status, and the diff pane says the App is not installed and offers to install it or to ask an owner.
- A session written on one person's machine opens in a teammate's local viewer.
- A member whose GitHub account cannot read the private repo sees statuses and is told why the code is hidden, until the person who connected the repo opens code to every member.
- After the App is uninstalled or its repository access is removed, new private diff requests are denied with an explanation and a way to reconnect; public diffs still work without the App.
- A public repository becoming private stops unauthenticated code access and offers the private-repository connection flow without exposing previously fetched code to new readers.
- A rate-limited request or an incomplete GitHub patch shows its specific limitation and never appears as a complete, empty diff.
- After `cairn session unshare` on a shared session, a teammate's viewer and the room both show it as not shared, and the command says to rotate any secret the log held.

### Multiplayer acceptance criteria {#prd.v2-multiplayer-on-cloudflare.multiplayer-acceptance-criteria}

- Two humans and one agent see authorized committed comments, presence and task updates in under 250 ms p95 within one region; this does not require simultaneous prose editing.
- Killing an agent process marks it away within 15 s without granting another agent execution authority through presence alone.
- A gate approval from an agent identity is rejected, whatever the client says it is.
- A stale document save is refused with its draft preserved. Reconnecting clients load committed state, and retrying an accepted event does not duplicate it. Automatic offline text convergence belongs to the later diverging-state acceptance criteria.
- `alchemy deploy` brings up a working room from an empty Cloudflare account, given the GitHub and Google OAuth client credentials.
- GitHub, Google and a magic link to the same confirmed email sign in as one user.
- A magic link signs in once; a second use, or a use after five minutes, is refused.
- An anonymous reader can open a public PRD but not a private room. A guest can join only granted PRDs, and revoking access stops subsequent protected updates and writes on an existing connection.
- A room that hibernates wakes with no lost accepted revisions, comments or events. If the Effect EventLog candidate is used, the browser/CLI spike must prove this before adoption.
- Concurrent replies are both retained; conflicting edits to the same comment do not silently overwrite one another. A changed passage leaves the comment and its revision anchor intact.
- A client resubmitting events after a disconnect is checked against current permissions, and authorized clients derive the same committed task statuses.
- After a room has shown a diff and a session, its Durable Object, its R2 bucket and its D1 database hold no line of either.

## Later {#prd.later}

- Rich editing beyond basic markdown: embeds, simultaneous collaborative text editing and inline visual diffs. Comments, replies and resolution already belong to launch.
- Section-level and mixed-audience sharing, review invitations pinned to selected revisions, and live editing across different section permissions. Whole-PRD member and guest access ships first.
- Google Docs-style visual history and detailed edit attribution, document forks and automatic offline merging. Basic revision list, earlier-version reading and restore already belong to launch.
- Workspace-wide activity feeds and expanded cross-document reporting beyond the initial PRD directory and links.
- A map of the whole plan on one screen: every PRD section, spec section and stack at once, with every curve drawn. The prototype has it as its Map variant.
- An inbox view of agent activity across rooms.
- More in the terminal view: approving a gate, reading the plan and its two reviews, and following an agent's output while it runs. The last needs the orchestrator to publish output as it is written, which the orchestrator contract does not ask for. Starting, detaching from and cancelling a run stay with the orchestrator unless Cairn becomes one.
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
- [Effect Cluster](https://alchemy.run/cluster/what-is-effect-cluster/) as a later implementation option for durable background work and scheduled cleanup. Workspace and guest invitations already work at launch without depending on this adoption. On Cloudflare its [Durable Object pool](https://alchemy.run/cluster/cloudflare) makes each entity a Durable Object reached over RPC, with its state in memory, so the room itself stays a plain Durable Object with hibernatable WebSockets.
- An agent session planning as a participant in a shared room through MCP, building on local agent access.
- Scoring planners against a reference plan, so a provider is chosen on measured quality and cost.
- State diagrams drawn from the machines themselves.
- A plan split across several PRD files, with one set of section IDs and one manifest.
- Several independent plans in one local repo, for a monorepo that holds more than one product. Multiple independent PRDs in a hosted workspace already belong to launch.
