# `cairn plan`: speed and scale

Findings from a working session on 2026-11-26 and from a review of that session's conclusions on
2026-11-27. It started as "the plan command is very slow" and ended at "how does planning hold when
the PRD and spec no longer fit in one model call". This file records what was measured, what was
built, what was tried and dropped, and what is still open, so the next session does not have to find
it again.

Every number is from this repository on those two days, and most are from one run each. "Run-to-run
spread" below shows how much one run can differ from the next.

The review ran six independent reviewers over the session, then gave each conclusion to a skeptic
who tried to refute it from the code and the saved data. It made no model calls. "Checked" in this
file means a second reviewer reproduced the figure. "One reviewer" and "not measured" mean what they
say. "What the review corrected" near the end lists the statements in the first version of this file
that were wrong.

## Where it stands

- **The speed work is not on `main`.** With the first seven pull requests of the stack a dry run of
  one plan went from 21 minutes to about 6. `main` still plans the old way, and the stack no longer
  merges: #218 conflicts with `main` since 29 other pull requests landed late on 2026-11-26.
- **The measured times are floors.** Every timed run had judging switched off. With the whole stack,
  the first real plan reads about 140 sections once, which makes it about 9 to 11 minutes, and
  every dry run before it repeats that read.
- **Size is not solved.** Each big planner call reads the whole PRD and the whole spec: 252.6K
  tokens for the sections call and 273.5K for the tasks call. The model's window is 1M tokens, so
  the tasks call fits about 3.7 times its size on Nov 26, and about 3.4 times, by character count,
  after what landed that night. PRD plus spec grew 7.7 times in four days.
- **The reply is the nearer limit.** A reply holds 128,000 tokens, thinking included. A first plan
  writes the whole spec in one reply. By arithmetic that was never run, a PRD above roughly 35K to
  60K characters, depending on effort, fills the reply long before the window. Cairn checks for
  neither limit.
- **No design survived review, and every way found to send less is a constant factor.** The safest
  cut found is 6% of a call. None saves more than a few seconds a run.
- **A direction is chosen but not built:** write from a slice, check the result against everything,
  and keep a receipt of what was read. The slices tried so far cannot be ranked yet: one pair of
  whole-document runs at the same settings differs about as much as the slices differ from them in
  the dependencies, files and identifiers they name, though not in how they cut the sections.
- **The plan files have faults that do not depend on size.** 24 done-when statements cannot be
  cited, 9 spec sections and 6 PRD sections say things about the code that are no longer true, and
  19 landed tasks are still marked pending. See "Found in the plan files".

## Speed

### Before and after

The same plan each time: `prd.viewer.effect-ui` added to the existing spec, as a dry run in a scratch
clone, with the `claude` CLI as the planner.

| Run                                     | Total   | Statements | Spec sections | Index            | Tasks | Result                |
| --------------------------------------- | ------- | ---------- | ------------- | ---------------- | ----- | --------------------- |
| Start                                   | 1,271 s | 19 s       | 241 s         | 53 calls, 753 s  | 256 s | 10 sections, 16 tasks |
| With #218 to #222                       | 444 s   | 11 s       | 209 s         | 52 calls, 139 s  | 81 s  | 9 sections, 18 tasks  |
| Spec draft at medium (#236, #237)       | 380 s   | 12 s       | 119 s         | 51 calls, ~122 s | 115 s | 8 sections, 20 tasks  |
| Both big calls at low, index up to date | 109 s   | 11 s       | 56 s          | 6 calls, 16 s    | 22 s  | 6 sections, 6 tasks   |

The first three rows include index calls for sections that were already on `main`, which repeat in
every dry run until a real plan records their hashes. The last row had those hashes filled in by a
script first, so it is what a run costs once that one-time read is done. On the same footing the
medium run would be about 275 seconds. The medium row was run at #237, before #248.

### What these rows leave out

- **Judging.** All four runs printed "Judging skipped": the judge keys had been deleted from the
  clone's config. With the committed config and the gateway token set, a plan also judges every new
  section and every drafted task (31 requests for the medium run, four at a time, up to two rounds)
  and splits each draft judged too large. A split sends the whole spec, about 205K tokens, to split
  a draft whose own sections are 1K to 4K characters. None of it has been timed, and no
  `judgments.json` has ever been committed. To plan in a clone with judging on, keep the `judge`
  block and export `CAIRN_AI_GATEWAY_TOKEN`.
- **The one-time read.** With #248, every section whose index entry has no `indexedFrom` hash is
  read once: 136 of 180 sections at the stack's base and 142 of 188 on `main` now. At eight calls at
  once that is 4 to 6 minutes, so the first real plan is about 9 to 11 minutes. A dry run writes
  nothing, so at the top of the stack every dry run repeats the read until a real plan has run. It
  has never been run: the last row's hashes were written by a script.
- **The writes.** A dry run returns before the manifest write, the diagram redraw, the second index
  pass and the judgments file.
- **Repeats.** Each row is one run. The tasks call at the default effort took between 77 and 256
  seconds over five runs, and the sections call at medium took 119 and 162 seconds. So the
  direction of each change holds and its size does not: 175 of the 827 seconds between the first two
  rows are the tasks call, which those pull requests change only through safe mode (in the first run
  it waited 112 seconds for its first frame, at 493K tokens).
- **Cairn's own work.** The gaps between calls are about 3 seconds. The reported total minus the
  calls is 4.5 to 4.9 seconds in three runs and 13.5 in the medium run. It will not stay small:
  parsing `spec.md` once takes 0.19 seconds today, 1.3 at four times the size and 6.9 at ten times.

### What made the difference

- **Index calls were repeated on every run.** 43 of the 53 were for sections on `main` whose text no
  longer matched the hash recorded when Cairn wrote them. Most were never edited by a person: the
  repository's formatter re-pads tables and rewrites code fences in `spec.md` at commit time, after
  the hash is recorded. That is shown for 14 of the 43 and possible for up to 36. A person edited
  11: the 7 that matched at first and 4 of the 36. #221 records the hash each entry was read from
  (`indexedFrom`), so each is read once. In a dry run nothing is written, so they repeat until one
  real plan runs. Each later plan adds 0 to 2 re-reads for its own reformatted sections.
- **Small calls go to a smaller model.** `planner.small` is wired (#218) and set to Sonnet here
  (#219). Three real index calls each: default 29 to 48 s, Sonnet 16 to 25 s, Haiku 21 to 74 s.
  Sonnet's index prose was about 20% shorter than the default model's on the same prompts (42 of 44
  pairs). The two were never compared for quality.
- **Eight index calls at once** instead of four (#220).
- **Safe mode** (#222) stops each `claude` call loading the owner's Claude Code context. That is
  224,000 fewer tokens on a call that asks for structured output (the tasks call went from 497.0K to
  273.5K) and 24,000 fewer on the text call that writes sections (276.7K to 252.6K). The floor per
  call went from 10 s to 6 s.
- **Effort** (#236) was the largest measured change after the index fixes, on one run per level.
  See below.

### Where the time goes

Time follows output tokens far more than prompt size.

- **About 10 ms per output token, thinking or text.** Thinking runs at about 100 tokens a second,
  spec markdown at about 120 and the tasks JSON at about 153.
- **The spec call at medium** (one replay) wrote 15,906 output tokens: 7,316 of thinking and 8,590
  of spec text. That was 12 seconds before the reply started, 73 thinking and 72 writing. Thinking
  is most of the output only at high effort (22,174 of 31,455 tokens). At low it is 705 of 5,045.
  Other spec calls at medium were 35 to 45% thinking, and at high or the default 55 to 73%.
- **At this repository's settings** the two big calls are about half thinking: 128 of 257 seconds,
  with 106 writing and 23 waiting to start. That takes the unset tasks level as high and is one
  replay per call. Of a whole run with the index up to date, writing is about 40% and thinking 37%.
- **Prompt size costs a little.** Sent alone, a call waits about 2 seconds plus about 2 seconds per
  100K uncached input tokens for its first frame: 2.6 to 3.2 s at 52K and 6.0 to 8.6 s at 253K to
  273K, over nine calls in three real runs. That is 16 to 19 seconds of a run, of which about 11
  scale with prompt size. Halving both big prompts would save about 5 seconds.
- **The earlier replay with 224,000 fewer input tokens was no faster** because it wrote 2,254 more
  output tokens. Its first frame did arrive 7 seconds sooner. It also read 99.7% of its input from
  the prompt cache, so it measured caching as much as size.
- **Above about 470K tokens the wait stops being a rate.** Seven calls of 472K to 497K waited
  between 8.6 and 130 seconds. Those calls carried the owner's Claude Code context, before safe
  mode.
- **Per unit:** about 15 seconds per section at medium (119 s for 8) and 23 at the default (209 s
  for 9), about 5 seconds per task, and about 2.4 seconds per indexed section in a pool of eight. So
  "about 6 minutes" is the price of an 8-section part. A plan the size of the hosted launch, 24
  sections and 42 tasks, is more than three times that, because its sections were nearly twice as
  long: by output tokens it projects to roughly 14 to 19 minutes before judging. Never run at these
  settings. The real one, on Nov 25 under the old settings, took 27 minutes, failed lint, and took 8
  more for the rerun.

### Effort

One replay per level of the saved prompts, full spec in each. The six were sent at the same moment,
so their seconds include a longer wait for the first frame than a plan run sees (10 seconds on
average against 7):

| Effort | Spec call | Tasks call | Spec result             | Tasks result |
| ------ | --------- | ---------- | ----------------------- | ------------ |
| High   | 307 s     | 103 s      | 9 sections, 3,125 words | 17 tasks     |
| Medium | 162 s     | 57 s       | 8 sections, 2,876 words | 9 tasks      |
| Low    | 54 s      | 25 s       | 6 sections, 1,421 words | 8 tasks      |

- **Only the first step down was free.** From high to medium the spec call lost two thirds of its
  thinking and 7% of its text. Every other step also cuts what is written: medium to low halves the
  spec text (8,590 to 4,340 tokens).
- **Lower effort makes the plan coarser:** fewer, larger tasks. That is a correctness trade, because
  a larger task is a larger diff for an agent to build and a person to review.
- **The links to existing tasks change too:** 22 at high, 6 at medium and 5 at low, in one reply per
  level. Whether the extra links at high are wanted is not shown. They make its last drafts wait on
  56 of the 105 unbuilt tasks, and the plan that was really written declared one.
- **Drafts get larger as effort falls:** 7.4 files per task at high, 11.6 at medium and 11.0 at low.
  Larger drafts are what the judge splits, so part of a low-effort saving may come back as splits.
  Not measured.

`planner.effort.spec` and `planner.effort.tasks` in `.cairn/config.json` set the level per call.
This repository uses medium for the spec call and sets nothing for tasks.

"Nothing" is not a fixed level. Cairn passes no `--effort` for the tasks call and no `--model` for
either big call, so both follow the Claude Code settings of whoever runs the plan. Claude Code's
documentation gives the order: an exported `CLAUDE_CODE_EFFORT_LEVEL`, a level picked in the
session, `--effort`, a level saved in settings, then the model's own default, which is medium for
Opus 5.5. In the timed runs the unset tasks call behaved like high: 18 and 20 tasks, against 17 for
the high replay and 9 for medium. On a machine with no saved level it would run at medium. Every
saved big reply came from `claude-opus-5-5`.

### The low-effort dry run

The same plan, end to end, with `planner.effort` set to low for both calls and the index hashes
filled in as a real plan would leave them: 109 seconds, 0 lint errors, judging off.

| Step                      | Time |
| ------------------------- | ---- |
| Done-when statements      | 11 s |
| Spec sections, low effort | 56 s |
| Index, 6 new sections     | 16 s |
| Tasks, low effort         | 22 s |

It planned 6 spec sections and 6 tasks, where the medium run planned 8 sections and 20 tasks and
the first run 10 and 16. The sections are the same steps (Effect version, spike, porting the
viewer, components, removing Foldkit) with the baseline step folded in. The tasks are one per
section, so each is about three times the size of a task from the medium run.

One run. The owner read this result and kept medium for the spec call and the default for the tasks
call: six large tasks are harder to build and review than twenty small ones.

### Run-to-run spread

The saved material holds three pairs of whole-document runs of the same sections prompt at the same
effort: a dry run and a replay. The prompts in a pair differ only in the wording of three drafted
done-when statements.

| Effort           | Sections | Section ids in both | Dependencies on existing sections | In both | Code identifiers named |
| ---------------- | -------- | ------------------- | --------------------------------- | ------- | ---------------------- |
| Default and high | 9 and 9  | 8 of 10             | 10 and 9                          | 9 of 10 | 55 and 58              |
| Medium           | 8 and 8  | 6 of 10             | 8 and 8                           | 4 of 12 | 47 and 72              |
| Low              | 6 and 6  | 4 of 8              | 3 and 6                           | 2 of 7  | 39 and 31              |

"Of 10" and "of 12" count the ids either run used.

- At medium the planner reproduces 4 of its own 8 dependencies. A score that takes one run's
  declared dependencies as the answer has that much noise in it.
- Medium over low for the spec call, and the default for tasks, were each chosen on one run.
  Earlier, one part gave 3 tasks in a dry run and 5 in the real run.
- All of it is one PRD part, in the most linked area of the spec.
- Before a slice, a prompt change or an effort change is judged, replay the sections prompt three
  more times at medium (about 8 minutes, about $7 at list price) and treat a difference inside that
  range as no difference. For a change to the tasks prompt or the tasks effort, one skeptic asked
  for at least five replays per arm, scored on file-sharing task pairs left unordered and on how
  many unbuilt tasks a draft waits on, not on the count of links.

### Why a hand-run plan feels faster

Writing a spec and tasks by hand in one model session takes the owner one to two minutes. Cairn
takes longer for three reasons: about half the time of its two big calls is thinking at this
repository's settings, it makes three large calls that each start cold where a session makes one,
and it indexes each new section, which a hand-run plan does not.

Ways to close the gap that do not change what is written:

- **Fast mode.** `claude -p --settings '{"fastMode": true}'` turns it on for a print-mode call, and
  Opus 5.5 supports it. The documentation says up to 2.5 times faster output and nothing about the
  wait for the first token. On a subscription it is billed to usage credits, which must be turned
  on, not to included usage, at twice the rate for every token of the request. As a ceiling it takes
  the medium run from about 272 seconds to about 145 and the low run from 109 to about 70, for about
  $5 more per plan at list price or about $10 of usage credits. Not measured: every saved reply ran
  at standard speed. Whether `--safe-mode` honours the setting is not confirmed, and a fast request
  can fall back to standard speed on its own rate limit, so read `usage.speed` in the reply.
- **Run the index calls beside the tasks call in unattended runs** (`--yes`, `--dry-run`). Checked:
  the tasks call reads the PRD, `spec.md`, the section ids and the existing tasks, and none of the
  index prose. It saves 16 to 20 seconds a run once the one-time read is done. In an attended run
  the person is reading the spec while the index runs, so nothing is gained. Keep the entries in
  memory and write `spec.json` once, complete: an entry written with empty prose is never read
  again.
- **Show the draft as it is written.** Cairn shows nothing until a call ends. A streamed spec draft
  would start reaching the reviewer after about 85 seconds at medium instead of 162, with the same
  text. Not built.
- **Fill a draft's `files` in code** when it is the only builder of its sections. 19 of 19 such
  drafts in the saved replies list exactly the sections' `Files` keys. It saves about 4 to 7 seconds
  at this repository's settings.

Ways that change behaviour, for the owner to decide:

- **Start the tasks call while the person reviews the spec.** Today the tasks call reads `spec.md`
  after the "yes", so an edit made during the review is used. A call started early drafts from text
  that may change, and each one thrown away costs about $2.30 at list price.
- **One writer per section after an outline call.** In the medium reply 6 of 14 `Depends on` links
  point at sections the same reply writes, and all 7 child sections sit under a parent it creates.
  Each writer also reads the whole prompt again. It bounds the size of any one reply, so it belongs
  with the reply limit below, not with a quick speed-up.

One call for spec and tasks together would also be faster, but it removes the review between the
two steps that `prd.planning.two-reviews` requires.

## Size

### What is sent

A run sends three large prompts (`packages/cli/prompts/`). The statements prompt holds the whole
PRD. The `sections` and `tasks` prompts each hold the whole PRD and the whole `spec.md`, and the
tasks prompt adds a list of every existing task (23K characters). In the low-effort run the three
came to 1.56M characters: three PRD copies are 28.7% of it, two spec copies 69.0% and everything
else 2.3%.

The sections prompt that measured 252,616 tokens was 689.6K characters: 150K of PRD, 534K of the
scratch clone's slightly older spec and 5K of instructions, at 2.73 characters per token. The same
prompt with `main`'s 553K spec that day would be about 259K tokens; that was not measured. By share
of that prompt: finished spec sections 33%, sections with no landed task 34%, the PRD 22% and the
code-drawn stack diagram 6%.

| Date                                       | PRD (chars) | Spec (chars) | Sent per big call |
| ------------------------------------------ | ----------- | ------------ | ----------------- |
| Nov 22                                     | 20K         | 71K          | 91K               |
| Nov 23                                     | 38K         | 168K         | 206K              |
| Nov 24                                     | 80K         | 190K         | 270K              |
| Nov 25                                     | 146K        | 529K         | 675K              |
| Nov 26, afternoon                          | 150K        | 553K         | 703K              |
| Nov 26, night, after 29 more pull requests | 173K        | 584K         | 757K              |

Growth follows plan runs. The plan commits of Nov 25 added about 338K characters of spec; the
largest added 120K (the rest of the PRD) and 109K (the hosted launch). 43% of the spec is plan with
no landed task, and 92% of that came from three runs that day. The other commits still added about
51K characters of spec a day. Without those three runs, what a big call sends grew 84K to 97K
characters a day, which puts the window about three weeks away.

`spec.json` is not a summary. It is 1.65M characters, three times `spec.md`, and it is in no
prompt. 87% of its model-written text is three fields nothing reads (`requirements`, `artifacts`,
`decisions`). A map has to be cut from it.

### The window and the reply

- **The window is 1,000,000 tokens.** The CLI reports it in every reply, for Opus, Sonnet and
  Haiku. Calls with 472K to 497K tokens of input succeeded.
- **Near the window the CLI's documented default is to compact the conversation.** Claude Code's
  documentation says models with a 1M window compact at about 967K tokens by default and that
  `DISABLE_AUTO_COMPACT` turns it off. It does not say whether a one-turn print call is compacted,
  and that has not been observed. Cairn sets nothing to prevent it and reads no turn count or
  usage. If it happens, an oversized prompt would be answered from a summary of the PRD and spec
  with no error.
- **A reply holds 128,000 tokens, thinking included.** The two largest real plans wrote 43 sections
  (109,743 characters) and 24 sections (100,257). The larger is about 44,400 tokens of text, 35% of
  the limit. With the thinking measured per token of text it is 51 to 64% at medium and 74 to 91% at
  the default effort, and at the one high sample's ratio it projects to 118%, so it may go over.
  The one real plan of that size, the hosted launch on Nov 25, wrote at least about 75,000 output
  tokens in its sections reply, roughly 60% of the limit.
- **A first plan writes the whole spec in one reply.** The spec has been 2.4 to 4.4 times the PRD
  in characters. At this repository's ratio the largest PRD a first plan can finish is roughly 45K
  to 60K characters at medium and 35K to 40K at the level the unset calls ran at here. That is
  arithmetic and was never run. This PRD is 173K. `cairn plan <id>` with no spec already plans one
  part through the sections prompt, which is a way round, and nothing points a user to it.
- **A reply cut at the limit is not detected.** Read from the CLI's binary (2.1.332), not run: when
  a reply stops at the limit the CLI asks the model to continue, up to three times, and returns the
  last message's text. Cairn would get the end of the reply with `is_error` false. The
  documentation describes that continuation for an interrupted reply and does not mention the
  output limit. Lint would usually stop the run later with an `unknown-section` error, after
  `spec.md` is written.
- **Splitting by top-level PRD section does not bound a reply.** The hosted launch is one top-level
  section holding 23 of its 24 spec sections. Spec characters per PRD character ran from 1.8 to 6
  by area, so reply size cannot be estimated well from PRD size.

### What each cut would save

Per big call unless the row says otherwise, measured without a model call on `main`'s PRD and spec
at the afternoon snapshot (703K characters) or on the saved prompts (690K).

| Cut                                                         | Input removed                      | Standing                                                                                       |
| ----------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| The code-drawn stack diagram                                | 6% (45K characters)                | Safest. Untested: it is the only place a prompt shows existing tasks' dependencies             |
| Finished sections folded to a short record                  | 7% to 25%, by how much stays whole | Not recommended: 119 of 204 dependencies declared by new sections pointed at finished sections |
| Sections with no started task withdrawn                     | 34% (237K characters)              | Not supported: tasks never change once written and no command withdraws a section              |
| The hosted launch as its own plan                           | 16.5% (116K characters)            | Not a clean cut (see Experiment 3), and only for plans that touch nothing hosted               |
| The PRD cut to the part's top-level section and three rules | 23 to 26% of a run's input         | Breaks the hosted launch: 9 to 14 of its 24 sections use PRD text outside `prd.launch`         |
| A short fixed example in the first-plan prompt              | About 200K tokens, once            | Real, but only for the first plan of another repository                                        |

None of these saves more than a few seconds a run (the highest estimate is 8), and none changes the
rate of growth: PRD plus spec grew 55K characters in the six hours after the snapshot.

- **The diagram** is drawn by code from the manifest, and `withoutStackDiagram` (#248) removes
  exactly it. No tasks call and no whole-spec sections call has been run without it, and
  `prd.planning.part` says the planner reads the whole spec. Adding each task's dependencies to the
  existing-task list (4K characters) would keep every edge.
- **Finished sections** are not history. 83% of their text is a declared dependency of a section
  that is not built yet, and they hold the standing rules (the design system, the format, the
  libraries). Folding every one saves 25% of a call today, and 48% if all planned work landed;
  keeping must-not rules and the 16 most-used ones whole, 17.5%; keeping every one an unbuilt
  section depends on, 7%. No fold has been tested with a model, 33 of the 84 finished sections have
  an index record older than their text, and the status a rule would read is 19 tasks behind
  `main`.
- **Unstarted sections** cannot be withdrawn by any command. Withdrawing only the 41 outside the
  hosted launch (18% of a call) would leave three links from the hosted launch dangling.
- **The PRD** is sent three times a run, but a part's sections are not written from its part alone.
  See the hosted launch under "Found in the plan files".

### Experiment 1: a map plus a slice, on one live case

The saved `sections` prompt for `prd.viewer.effect-ui`, replayed at medium effort with the PRD left
whole and the spec replaced.

| Variant                                | Input tokens | Time  | Sections | Words | Code identifiers named |
| -------------------------------------- | ------------ | ----- | -------- | ----- | ---------------------- |
| Full spec                              | 252.6K       | 157 s | 8        | 2,876 | 72                     |
| Map only                               | 92.9K        | 83 s  | 7        | 1,748 | 25                     |
| Map + graph slice (28 sections)        | 126.9K       | 124 s | 8        | 2,618 | 61                     |
| Map + model-picked slice (25 sections) | 130.9K       | 121 s | 7        | 2,537 | 71                     |

- The map is every section's id, level, title, summary, files and dependencies: 93K characters, 17%
  of the spec. Without files and dependencies it is about 49K.
- The graph slice is the sections that implement the parent PRD section plus what they depend on.
- Every variant wrote 7 or 8 sections for the same work, named no id that does not exist, rewrote
  no existing section and covered all three done-when statements.
- **The table cannot rank the slices.** The full-spec row was not repeated, and it came from a
  different capture than the variants. A second full-spec run at medium named 47 identifiers (see
  "Run-to-run spread"), so 61, 71 and 72 are inside the spread. Outside it are map only (25
  identifiers), the graph slice's 20 dependencies against 8, and every variant's section ids: they
  share 2 or 3 of the baseline's 8, where a second full-spec run shares 6.
- The three slice variants were also sent without the stack diagram. The model-picked row leaves
  out the call that picked its sections: 91K more input tokens and 6 more seconds.
- The faster variants were faster because they wrote less: map only was 74 seconds faster, 66 of
  them from writing 7,155 fewer output tokens.
- Not tested: lint through the pipeline, the `tasks` call, a sliced PRD, and whether a draft
  contradicts a section it saw only as a summary.

Slicing the spec alone moves the ceiling from about 4 times today's size to about 10, because the
PRD is still sent whole and the flat map grows with the spec.

### Experiment 2: replaying this repository's history, with no model calls

For each of the 16 commits on `main` that added spec sections, the spec was rebuilt as it was just
before, and each slice rule was asked what it would have shown. The measure is how many of a new
section's declared `Depends on` sections were in the slice: 126 new sections, 204 dependencies, a
spec growing from 54 to 172 sections.

| Slice rule                                 | Dependencies found | Median slice |
| ------------------------------------------ | ------------------ | ------------ |
| Sections implementing the PRD parent       | 22%                | 0 sections   |
| + one hop of dependencies                  | 28%                | 0            |
| + PRD siblings and matching artifact names | 41%                | 4            |
| Text search alone (BM25), top 25           | 60%                | 25           |
| Links + search top 25                      | 69%                | 27           |
| + the 20 most-depended-on sections         | 81%                | 40           |

- **The replay had a defect.** It ignored that an `Implements` key applies to every section below
  it, which cost one large run 10 dependencies. With it fixed, the best rule finds 108 of 132 (82%)
  for the three large runs and 69 of 72 (96%) for the 13 small ones: 177 of 204, or 87%, where the
  table says 81%. The rows above it that follow links were not recomputed.
- **Recall follows the size of the run, not the size of the spec.** 84 of the 126 new sections had
  no anchor at all, and 67 of those belong to the three large runs, which each opened a new area.
  Above 120 sections the corrected figure is 78%: four small runs at 16 of 16, the rest from two
  large runs.
- **The evidence for small runs is thin.** For the nine earlier small runs the slice was 87 to 99%
  of the spec, so they test nothing. The case rests on 16 dependencies in four runs.
- **Pooled per plan run,** as one planner call would see it, the best rule finds 198 of 204 (97%),
  and every dependency in 14 of 16 runs. The pooled slices of the two largest late plans are 78 to
  79% of the sections and 87 to 88% of the characters. For the four late small runs the slice is 34
  to 45% of the sections and 45 to 61% of the characters.
- **The yardstick is noisy and narrow.** It is what one whole-document run declared, and a second
  run declares a different list (see "Run-to-run spread"). Declared dependencies also undercount
  what a new section touches: 615 pairs of an existing and a new section share a file and 126 of
  them are declared. The best rule shows 72% of file-sharing sections per section and 92% pooled
  per plan. File sharing is not shown to be a need either: a planner that saw everything left 80%
  of those pairs undeclared.
- A model choosing from a map was not replayed.

So a fixed slice of 25 sections chosen by links does not hold. A workable slice is 40 to 75
sections, with text search and the most-used sections, for a run that adds a few sections to an
area the spec already covers. A run that opens a new area needs most of the spec.

### Experiment 3: four architectures, each attacked

A workflow ran four independent designs (incremental build, navigation over a tree of summaries,
separately planned units with interfaces, and verification first), then one skeptic per design
checked it against the code. None survived. All four failed the same way:

1. **A global rule far from the part being planned.** `prd.redaction` says session files are never
   written if redaction fails. A new section elsewhere that writes session files never sees it.
2. **A new top-level PRD section.** It has no links, so a slicer that follows links returns nothing.
3. **The same thing in different words.** Nothing connects a new `resendWithDelay` to an existing
   `withRetry`.
4. **A stale summary** the planner trusts in place of the text.

What every skeptic said to keep:

- A receipt per planner call: the hash of everything it was shown in full.
- A freshness check on every summary.
- Summaries route, full text decides.
- After each new section, a search of the whole corpus for near matches, with every candidate
  recorded as checked or unchecked.
- A scope on each PRD rule (this section, this subtree, everything), so global rules are always
  sent.
- A symbol table: each named artifact marked as defined or used, checked the way a linker does.

What dropped out:

- **Splitting this repository into units.** 31 to 34% of dependency links cross one six-way cut,
  and 41% cross a cut along the spec's own 22 top-level areas. The least linked block is the hosted
  launch: 26 declared links out and none in. It is still not a clean cut. Four of the next eight
  plan commits edited 7 of its 24 sections, 41 of its 42 tasks wait on tasks outside it, and its
  text relies on rules in sections it does not declare (the trace's private fields, what counts as
  a gate approval). A repository gets one plan today, and the PRD lists both a plan split across
  files and several plans in one repository under Later. Splitting still fits separate products or
  repositories.
- **A tree of model-written summaries.** It conflicts in git whenever two people plan at once.
  Today's flat index does too: every entry stores its line number, so any two branches that add a
  line to `spec.md` conflict in `spec.json` and the demo trace.

No design gives a guarantee. Cases 2 and 3 are caught only with some probability, by search, and
that probability has to be measured. The whole-document planner has never been given the four cases
either, so its own miss rate is unknown.

## Found in the plan files

Faults in `.cairn/` that exist today whatever is decided about size. Checked, except the figures
marked as one reviewer's.

- **24 done-when statements cannot be cited.** 34 of the PRD's 62 statements have no ID, and 24 of
  those sit under sections the spec implements. The spec's tests cite 24 statement IDs that are in
  no committed `prd.md`, so 36 of the 78 `proves` links in `spec.json` point at nothing. Three
  things report it and none is in a gate: 11 warning lines in each plan run, `cairn ids --check`,
  and 23 of lint's 191 `task-without-statement` warnings, which do not name the cause. The first
  `spec.json` the tool writes will delete those 36 links. The fix needs no model call: run
  `cairn ids` (it adds 34 IDs on 34 lines and nothing else), record the new PRD hashes for the 13
  entries that depend on the 8 changed PRD sections, starting with `spec.cli.agent-access`, which a
  whole-PRD plan would otherwise rewrite, then `pnpm demo-trace` and `pnpm check`. Numbering goes by
  position, so it has to happen before a statement is added, removed or moved in those lists.
  Afterwards 18 of the 24 are linked (one reviewer) and 6 stay unlinked until their sections are
  read again. Linked is not proved: lint then counts 10 of the 24 as proved.
- **The spec and the PRD say things about the code that are no longer true.** 9 spec sections state
  Foldkit as how the viewer works, and 6 PRD sections do too; the code moved to Effect UI. Line 5
  of `spec.md` lists six finished things as unfinished. `spec.libraries` lists Effect 4.1.5 where
  4.1.6 is installed, lists a package that is not installed and omits `@effect/ui`. 12 sections'
  `Files` keys name deleted paths 27 times (17 different paths, 11 of the mentions in the section
  that records removing them); `cairn plan` copied one deleted three days earlier into three new
  sections and three tasks. Nothing detects any of this. Lint reads only the plan files, and the
  hash checks of #221, #248 and #249 compare text with text. In the four dry runs 11 of 60 new tasks
  were for things that have never existed in the repository. Three tasks not yet built are
  specified by a stale section: t81, t162 and t169. The narrow fix is to correct by hand what those
  three are built from: `spec.cli.documentation.docs-site` with its line in `prd.docs`,
  `spec.viewer.command-menu` with `prd.viewer.command-menu`, and one sentence in
  `spec.viewer.demo-data`. Eight more sections mention Foldkit as the record of the move or in
  code-drawn task titles, and those stay. Correcting all six stale PRD sections at once would flag 25 sections and 54 tasks.
- **19 landed tasks are still pending in the manifest:** t97, t122 to t126, t190 to t192 and t236
  to t245. `pnpm tasks` already lists them as drifted. No planner prompt says which tasks or
  sections are built.
- **Seven `spec.refactors` sections have a `Files` key and no task.** They describe code that
  landed without tasks. A whole-PRD `cairn plan` on `main` would draft tasks for them, and with
  `--yes` write those tasks to the manifest as pending. Giving them done tasks changes the
  manifest, the diagram, `spec.json` and the demo trace, so it is its own pull request, after the
  rebase.
- **The hosted launch was specified from PRD text outside its part.**
  `spec.hosted-launch.accounts-and-workspaces` specifies Better Auth sign-in and a five-minute
  magic link, which the PRD mentions only inside a section that `spec.scope` defers. Its
  `Implements` and its recorded hashes name only `prd.launch` sections, so an edit to the deferred
  text marks nothing out of date. By one reviewer's term match, 9 to 14 of the 24 hosted-launch
  sections, building 15 to 26 of 42 tasks, use terms the PRD has only in deferred sections. The
  cause is a stale scope: `prd.goal`
  says accounts are launch requirements while `spec.scope` still defers the whole section. 21% of
  the PRD's text is covered by no recorded hash.
- **Most of the out-of-date report is about finished work, and one line in it is the only notice of
  an unplanned requirement.** Every timed run printed the same 210 stale lines among 659 warnings.
  On `main` 38 of 193 lines are about work that can still change (one reviewer), though most of the
  19 PRD changes behind the report are real requirement changes. 33 of the 50 "edited after the task
  was planned" lines are for sections that never matched their recorded hash in any commit; the
  formatter is the shown cause for 14 such sections and the likely cause for the rest. The line that
  matters: `prd.deep-links.missing` gained "Authorization is checked before resolving or describing
  a protected target" after its only implementing section was built. A built section is never
  rewritten, so that stale line is the only notice that the requirement is unplanned.

## Pull requests

All on `benschac/cairn`, stacked in this order. #217 (timing each planner call) merged earlier.

| PR   | Change                                                     |
| ---- | ---------------------------------------------------------- |
| #218 | Send the planner's small calls to `planner.small`          |
| #219 | Use Sonnet for this repository's small planner calls       |
| #220 | Index eight sections at once                               |
| #221 | Read an edited spec section once, not on every plan        |
| #222 | Run the planner's `claude` calls in safe mode              |
| #236 | Add `planner.effort` for the spec and tasks calls          |
| #237 | Draft this repository's spec sections at medium effort     |
| #248 | Check every section's index entry against its body         |
| #249 | Record the sections a spec section depends on, with hashes |
| #250 | This file                                                  |

State on 2026-11-27:

- **All ten are open and the stack needs a rebase.** Another session's stack of 27 pull requests
  (#223 to #256) and two more (#257, #258) merged late on 2026-11-26, early on the 27th in UTC.
  `main` is 30 commits past this stack's base and #218 conflicts.
- **The rebase** has 16 conflict regions in source and tests, across five of the ten commits, 8 of
  them in #218. Another 200 are stored `line` numbers in `spec.json` and the demo trace, and one is
  the trace's copy of `spec.md`. Recompute `line` with `derivedOf` and run `pnpm demo-trace`. Do
  not run `cairn plan` to regenerate them: it would do the one-time read inside a rebase commit.
- **`indexedFrom` needs a place in `main`'s new schema.** `main` now declares each `spec.json`
  field as `derived` or `prose` (#251). `indexedFrom` (#221) is neither. Declared as prose it
  enters the schema sent to the model; declared as derived it is recomputed, and an edited section
  never looks stale.
- **A wrong resolution passes every test.** One reviewer resolved #218 onto `main` in a scratch
  copy: 371 of 371 tests pass with the right resolution, and still pass with the index, split,
  statements and tasks call sites left in `main`'s form, which sends index calls back to the
  default model. Unguarded today: which model the index and split-task calls use, whether effort
  reaches the spec and sections calls, and whether the sections, tasks and statements calls stay
  off the small model. Assert model and effort for all seven calls in the rebased #218 and #236.
- **#222's missing CI run goes away with the rebase,** which gives every pull request a new head.
- **#248** closes a gap found in the review: `editedOf` skipped every section a person wrote (93 of
  180 at the stack's base, 99 of 188 on `main` now), so their summaries could go stale unseen. The
  one-time read it causes replaces the index prose of about three quarters of the sections with
  Sonnet's. 67 of the 78 tests that prove a statement sit in sections it replaces. Do it as its own
  commit, compare the proofs before and after, and read about ten summaries against the old ones.
- **#249 only records.** `writtenFrom.spec` is filled for sections written, rewritten or accepted
  after it lands, which is none of the 188 today, and nothing reads it.
- **An older checkout can strip the new hashes.** A schema without `indexedFrom` and
  `writtenFrom.spec` decodes an index that has them and writes it back without them, and every
  worktree's CLI writes the main checkout's `.cairn`. After the stack lands, one plan or `--accept`
  from a worktree that has not been rebased removes the hashes and repeats the one-time read.

## Found in the code, not fixed

- **A reply that reuses an existing section id has the id silently stripped** (`placed` in
  `packages/cli/src/spec-merge.ts`), so a duplicate lands under a new id with no report.
- **The relation index computes dangling links and nothing outside tests reads them**
  (`packages/core/src/relation-index.ts`). All 36 it finds today are the `proves` links above.
- **Passing lint does not mean a requirement is met.** Lint checks that a section claims a PRD item,
  not that its text satisfies it.
- **The first-plan prompt carries this repository's whole `spec.md` as its worked example**
  (`exampleUrl` in `packages/cli/src/planner.ts`, `{{example}}` in `packages/cli/prompts/spec.md`).
  That is about 200K tokens before the user's PRD, it grows with Cairn's own spec, and it includes
  the stack diagram the same prompt says not to draw. Copied outside a checkout, the planner fails
  to start because the file is not there. A two-or-three-section example checked in beside the
  prompts would fix all three. Whether a short example gives as good a first spec was not tested.
- **Nothing bounds or checks a reply.** `cli-model.ts` decodes `is_error`, `result` and
  `structured_output` only: no turn count, stop reason or usage. The `api` source reads only the
  reply's text. See "The window and the reply".
- **One failed index call loses every finished one,** and the next run then records the new
  sections as written by a person. The planner retries a reply it cannot decode, not a failed call.
  None of the 205 logged index calls failed.
- **With judging on, a failed split aborts the plan after both big calls,** with `spec.md` already
  written. So does a split that returns a duplicate title, an unknown dependency or a cycle. No run
  has had judging on.
- **Every task split sends the whole spec.** On `main` since #231 the spec opens a chat that each
  split continues, and with the `claude` CLI each split still carries it.
- **The formatter changes Cairn's sections after their hashes are recorded.** `oxfmt` runs on
  `.cairn/spec.md` at commit time. A new hash is not the fix: hashing the parsed markdown misses
  reformatted code fences and makes every recorded hash incomparable.
- **The tool's own `spec.json` cannot be committed.** It is written on one line where the
  repository's copy is formatted, and `--accept` rewrites the whole file the same way. Every real
  plan so far was run in a scratch clone and rebuilt by hand, and that recipe throws away the
  refreshed `indexedFrom` hashes. No plan has reached `main` as the tool wrote it.
- **`spec.json` and the demo trace store every entry's line number,** so two branches that each add
  a line to `spec.md` conflict in both.
- **The statements call runs on the large model with no effort setting.** It is 98.6% PRD and
  writes about 600 characters in 11 to 19 seconds. Sending it to the small model with less of the
  PRD was judged unsafe: its drafts name behaviour found only in sibling sections.
- **The planner's log understates what is sent on `main` since #231.** It counts the turn, not the
  chat before it. None of the 174 logged calls is affected.
- **A plan's model and effort are not recorded.** The reply names the model and not the effort, and
  the totals line prints "default".

Settled by the review: the relation index does not fail at ten times today's size. One reviewer
built ten disjoint copies of the plan (2,480 tasks, 1,800 sections) and `indexOf` took 0.96 seconds
against 0.20. The copies are no deeper than today's plan, so depth is untested.

## Decisions for the owner

- **May the planner read a slice?** `prd.planning.part` requires reading the whole PRD, spec and
  manifest, in two bullets since #233. The smallest case is leaving out the code-drawn diagram.
- **Should a changed dependency be reported?** It would change `prd.planning.again`. Measured: by
  body hash it adds 44 to 61 flagged sections to today's 47, about doubling the report. Comparing
  model-extracted artifacts instead would misfire on about 90% of re-reads.
- **Can finished spec sections be retired** to a short record once their code lands? Measured: about
  a quarter of a call today in the best case and 17.5% as proposed, rising to 48% if all planned
  work lands; 7% if every finished section an unbuilt one depends on stays whole. It hides the text
  new sections depend on most, and no fold has been tested with a model. The review recommends
  against it.
- **Should tasks be drafted while the spec is being reviewed?** It changes what an edit during the
  review does.
- **Should the plan's model and tasks effort be pinned** in `.cairn/config.json` (`planner.model`,
  `planner.effort.tasks`)? Without it the next plan follows the settings of whoever runs it. The
  results the owner read came from `claude-opus-5-5` with the tasks call behaving like high; the
  model's own default is medium, where the replay wrote 9 tasks instead of 17. The final critic
  would pin both in the same change as the rebase.
- **Is fast mode worth usage credits** for planning?
- **What is the hosted launch's scope?** `prd.goal` and `spec.scope` disagree on whether accounts
  are deferred. Settle it before the first of the 42 launch tasks starts.
- **Who plans the authorization rule** added to `prd.deep-links.missing` after its section was
  built?
- **Should the seven `spec.refactors` sections get done tasks, or lose their `Files` key?**
- **Should `spec.json` keep `requirements`, `artifacts` and `decisions`?** Nothing reads them, they
  are most of the index calls' output, and the PRD and `spec.contract.spec-index` define them. A
  symbol table would read `artifacts`.
- **What is being optimised?** The review found two doubtful units. Dollars are list prices, while
  the account is probably a subscription whose real budget is its usage limit, shared with the
  agents that build the tasks. Seconds are a dry run's model time, while 147 merged task pull
  requests took a median 35 minutes from open to merge (15 for the third with the fewest files, 53
  for the third with the most). There is no measure yet of whether a plan was right. If listed cost
  or plan usage turns out to matter, `FORCE_PROMPT_CACHING_5M` or `DISABLE_PROMPT_CACHING` for the
  planner's `claude` process removes $1.58 or $2.10 of the two big calls' listed cost per run and
  changes nothing the model reads.

## Next steps, in order

1. Rebase the stack onto `main` and land it, with the routing and effort assertions and the schema
   declaration described under "Pull requests". Until then `main` plans without safe mode.
2. Number the PRD's statements with `cairn ids` and record the hashes, in one commit, before any
   tool-written `spec.json` is committed.
3. Reconcile the plan files by hand: mark the 19 landed tasks done, delete or regenerate line 5 of
   `spec.md`, correct the three stale sections that unbuilt tasks are specified by (with their PRD
   lines), and settle the seven `spec.refactors` sections. Do not run a whole-PRD `cairn plan` on
   `main` before the last of these.
4. Exercise the write path. Save replies as well as prompts on one dry run; after that it needs no
   model call. Answer from them with a stub `claude` and run a real `cairn plan --yes` in a scratch
   clone. Check what it wrote with `oxfmt --check`, lint, `pnpm demo-trace --check` and
   `pnpm check`. Apply steps 2 and 3 in that clone in a fixed order and note after each what a plan
   would rewrite or draft.
5. Fix the index's failure path: keep the run's list of sections it wrote and retry a failed call
   once. Then, with the owner's go-ahead because it sends repository text through the gateway, time
   judging in one dry run at the committed effort with the gateway token set. Do the one-time read
   as its own commit. Only then run a real plan.
6. Add the guards that change nothing while prompts fit: fail a text reply that took more than one
   turn or reached the output limit, after one small call confirms what a cut reply looks like, and
   set `DISABLE_AUTO_COMPACT` for the planner's `claude` process.
7. Measure the spread (see "Run-to-run spread"). Have the owner read the 19 changed PRD sections
   once and accept or fix each group, starting with `prd.deep-links.missing`, so baselines are not
   recorded on text the tool flags as out of date. Then build the set of planning cases the owner
   has judged, scored for missed requirements, duplicates and contradictions, and run the
   whole-document planner on them first. Include a planted far rule, a paraphrased duplicate, the
   hosted launch as a part run, a small viewer feature planned against today's spec, and the four
   commits that had to edit hosted sections (a01263a, 466ee07, c9abc4a, 7922067).
8. Try prompt changes only as scored experiments on those cases: the diagram left out, and each
   existing task shown with its status and dependencies. A third is the final critic's suggestion
   and untested: placing the documents before the ask. Both big templates state the ask first and
   end with 700K characters of documents, and the vendor's guidance for long inputs is the other way
   round, reporting up to 30% better answers. The skeptic who looked at caching advised against
   reordering the templates, because it changes every plan.
9. Add a scope to PRD rules.
10. Build the slice behind a setting, with whole-document planning as the default: linked sections,
    text search and the most-used sections in full, a map of the rest, and a receipt of what was
    shown. Choose it by whether an existing section implements the part or its parent, not by size.
11. Add the check after writing: search the whole spec for near matches to each new section and
    compare each pair in full.
12. Plant paraphrased duplicates in a corpus padded to about 18,000 sections and measure how often
    that search finds them.

Rules for doing this without regressions:

- Whole-document planning stays the default until the judged cases say a slice is as good.
- Never cut silently. If a slice does not fit, split the work or stop.
- The planner may depend only on a section it read in full.

## Assumptions that would change the plan if wrong

- The spec is a permanent record, so every landed section stays in the planner's input.
- Work divides into parts with few links between them. This repository argues against it.
- Section summaries are accurate enough to reveal a conflict. Never evaluated. 33 of the 84
  finished sections have a body that changed after their summary was written.
- The whole-document plan is the right answer to compare against. It is not stable from run to run,
  and an earlier whole-document run re-specced things that already existed.
- Dry-run seconds and list-price dollars are the right units. See the last decision above.

Known to be false: that planning is greenfield and the spec describes the code. The spec says
things the code no longer does, and the planner is shown neither the code nor what has landed.

## Considered and set aside

- **Rust.** Cairn's own work is 5 to 14 seconds of a run. The time is model calls and the limit is
  tokens.
- **Compression** (LLMLingua, other serialisations). It shrinks input by a constant factor, it is
  lossy on identifiers, and input size is 4 to 10% of the time.
- **Sharing the prompt cache between a run's calls.** Every planner call writes its whole prompt to
  a one-hour cache and no call in the run reads it. The write is 76 to 98% of a big call's listed
  cost, but the same tokens sent as plain input would still cost half of that: the premium is about
  $1 per big call, 38 to 49% of its listed cost. Sharing is blocked four ways: calls with
  a JSON schema share no cached block with calls without one, each call runs in its own directory,
  the CLI caches at the end of the request, and the text itself diverges. With all four removed the
  tasks call could read 206K tokens, which saves 58 cents a run at a five-minute lifetime and
  nothing at one hour. An identical prompt replayed within the hour does read the cache: its first
  frame came 3 to 7 seconds sooner, and it generated no faster.
- **Speculative encoding** (`b10-tv/speculative-encoding`). It needs the source model's hidden
  states and cache injection in the target, and lists only open-weight 8 to 14B models. Not usable
  with hosted Claude or OpenAI models.
- **Agent memory products.** `.cairn` is already the memory, versioned and hashed.
- **Embeddings first.** A safety net for finding a similar section with no link to the change; worth
  adding once the judged cases can measure it.
- **A Merkle tree over headings.** It tells you what changed, not what the change affects. A graph
  of receipts is the same hashing idea applied to dependencies, and that is what #249 starts.
- **Several plans in one repository.** See Experiment 3.
- **A table of file overlaps in the tasks prompt.** The one reply that acted on file overlap made
  its last drafts wait on 56 of the 105 unbuilt tasks, against 6. The pending task t142 reports
  overlaps from code after the reply, which is the safer place.

## What the review corrected

Statements in the first version of this file that were wrong, and what replaced them:

- "A first plan has no spec to read, so it is the smallest input." The first-plan prompt carries
  this repository's whole spec as its example.
- "16,000 output tokens for about 4,300 tokens of visible text." It was 8,590 of text and 7,316 of
  thinking.
- "About two thirds of its time is thinking at medium or high effort." About half of the two big
  calls at this repository's settings; two thirds only with both at high.
- "Trimming a prompt … does not save time." It saves about 2 seconds per 100K tokens.
- "One whole-PRD plan on Nov 25 added 340K characters." The day's plan commits added 338K; the
  largest added 120K.
- "The 1M-token window is assumed." The CLI reports it, with a 128,000-token reply limit.
- "43 of the 53 were for sections … someone had edited." Mostly the formatter.
- "About 226,000 fewer tokens" for safe mode. That holds for structured calls; the text call lost
  24,000.
- "Cairn's own work … is about 3 seconds." 4.5 to 13.5 seconds, growing faster than the spec.
- "Every variant cut the work into the same steps." The variants share 2 or 3 of the baseline's 8
  section ids, where two full-spec runs share 6.
- "Recall fell as the spec grew: 100%, 90% and 63%." The 63% mixed four small runs that found
  everything with two large runs that opened new areas, and a defect in the replay lowered one of
  those. Corrected, it is 78% above 120 sections, and recall follows the size of the run.
- "About a third of dependency links cross any six-way cut." One six-way cut.
- "Not verified that the tasks call does not need the index." Checked: it does not read the index
  prose.
- Retiring finished sections: "most of the size problem goes away." About a quarter of a call at
  today's statuses, and it hides the text new sections depend on most.
- "Speed is acceptable … it is 109 seconds." Every run had judging off, and the one-time read behind
  the 109 seconds was never run.
- "150K characters of PRD and 553K of spec, measured at 252,616 tokens." The measured prompt held an
  older 534K spec.
- "Calls of 276K tokens succeeded." Calls of 472K to 497K did.
- "#222 and everything above it is blocked." The whole stack needs a rebase, which also gives #222
  its CI run.
- "35% of sections are imported by another unit." For one six-way cut; 39% along the spec's own
  top-level areas.

Three conclusions the session reached in conversation also did not hold: that the cache write is
money paid for nothing and worth sharing (only its premium over plain input is avoidable, and
sharing saves at most 58 cents a run), that lower effort cannot shorten the writing, and that an
organisation's size problem goes away because it is many PRDs. A repository gets one plan, which is
the case measured here.

## Reading

Checked that each loads and is the right page, except where noted.

- _Designing Data-Intensive Applications_, the chapters on stream processing and the future of data
  systems: <https://dataintensive.net/>
- _Build Systems à la Carte_:
  <https://www.microsoft.com/en-us/research/publication/build-systems-la-carte/>
- _Software Engineering at Google_, chapter 18 (build systems) and chapter 21 (dependency
  management): <https://abseil.io/resources/swe-book/html/toc.html>
- rustc dev guide, incremental compilation in detail:
  <https://rustc-dev-guide.rust-lang.org/queries/incremental-compilation-in-detail.html>
- rust-analyzer architecture: <https://rust-analyzer.github.io/book/contributing/architecture.html>
- The Salsa book: <https://salsa-rs.github.io/salsa/>
- Introducing stack graphs: <https://github.blog/open-source/introducing-stack-graphs/>
- TypeScript project references: <https://www.typescriptlang.org/docs/handbook/project-references.html>
- Differential Dataflow: <https://github.com/TimelyDataflow/differential-dataflow>
- Not checked (the sites refused or were unreachable): _Learning Domain-Driven Design_ (Khononov),
  _Prompt Engineering for LLMs_ (Berryman and Ziegler), _Software Requirements_ (Wiegers and Beatty)
  on O'Reilly, and _Introduction to Information Retrieval_ at <https://nlp.stanford.edu/IR-book/>.

## Where the raw material is

- **The session.** Claude Code session `a579c88b-56bb-46b6-9144-c163fe1b5805` in this project. Its
  transcript is the file of that name with a `.jsonl` extension in the project's Claude Code
  sessions directory, and `claude --resume a579c88b-56bb-46b6-9144-c163fe1b5805` reopens it.
- **The four designs and their reviews.** In that session's directory, under
  `subagents/workflows/wf_1640f1b4-105/journal.jsonl`.
- **The review of 2026-11-27.** In the same directory, under
  `subagents/workflows/wf_ce86cec0-0c7/journal.jsonl`: each reviewer's and each skeptic's full
  result, with the figures behind every line of this file that says "checked".
- **Scripts and saved prompts.** In the session's scratchpad, which a reboot can clear: `slice/`
  (the map-plus-slice replay), `replay/` (the history replay), `cap/`, `cap2/` and `cap3/` (saved
  planner prompts), `effort/` (the replies at each effort level), the four timing logs, and
  `review/` (the reviewers' scripts). Rebuild them from this file if they are gone.
- **How to time real calls.** Put a wrapper named `claude` first on `PATH` that saves stdin and the
  arguments and then runs the real binary. Have it save the reply too, so a later run can be
  replayed with no model call. Replay the saved prompts with changed flags.
- **How to run a plan safely here.** In a scratch `git clone --local`, not a worktree: the CLI
  reads the main checkout's `.cairn`. Run `cairn ids --check` first, and merge `prd.md` back
  instead of copying it, because `main` moves. Do not run `pnpm check` while a dry run's index
  calls are going; a viewer test timed out under that load.
