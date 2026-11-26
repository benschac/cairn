# `cairn plan`: speed and scale

Findings from one working session on 2026-11-26. It started as "the plan command is very slow" and
ended at "how does planning hold when the PRD and spec no longer fit in one model call". This file
records what was measured, what was built, what was tried and dropped, and what is still open, so the
next session does not have to find it again.

Every number here is from this repository on that day. Most are from one run each; where that
matters it is said.

## Where it stands

- **Speed is acceptable and can be traded against plan detail.** A dry run of one plan went from
  21 minutes to about 6. With both big calls at low effort and nothing left to re-read, it is 109 seconds.
- **Size is not solved.** Each big planner call reads the whole PRD and the whole spec, about 250K
  tokens. That fits about four times today's size. PRD plus spec grew eightfold in four days.
- **The size limit hits every run, not the first one.** A first plan has no spec to read, so it is
  the smallest input. Each later run reads everything written so far.
- **A direction is chosen but not built:** write from a slice, check the result against everything,
  and keep a receipt of what was read. Two pieces of groundwork are open as pull requests.

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
every dry run until a real plan records their hashes. The last row had those hashes filled in first,
so it is what a run costs once that one-time read is done. On the same footing the medium run would
be about 275 seconds.

Cairn's own work (parsing, hashing, graph queries, JSON) is about 3 seconds of any run.

### What made the difference

- **Index calls were repeated on every run.** 43 of the 53 were for sections on `main` that someone
  had edited since Cairn wrote them. #221 records the hash each entry was read from (`indexedFrom`),
  so an edited section is read once. In a dry run nothing is written, so they repeat until one real
  plan runs.
- **Small calls go to a smaller model.** `planner.small` is wired (#218) and set to Sonnet here
  (#219). Three real index calls each: default 29 to 48 s, Sonnet 16 to 25 s, Haiku 21 to 74 s.
- **Eight index calls at once** instead of four (#220).
- **Safe mode** (#222) stops each `claude` call loading the owner's Claude Code context: about
  226,000 fewer tokens on a one-word prompt, and a floor of 6 s instead of 10 s per call.
- **Effort** (#236) is the largest lever left. See below.

### Time follows output tokens, not prompt size

Replaying the same big prompt with 224,000 fewer input tokens was no faster. The big calls spend
about 10 ms per output token, and most of those tokens are thinking: the spec call wrote 16,000
output tokens for about 4,300 tokens of visible text. Trimming a prompt saves tokens and money. It
does not save time.

### Effort

One replay per level of the saved prompts, full spec in each:

| Effort | Spec call | Tasks call | Spec result             | Tasks result |
| ------ | --------- | ---------- | ----------------------- | ------------ |
| High   | 307 s     | 103 s      | 9 sections, 3,125 words | 17 tasks     |
| Medium | 162 s     | 57 s       | 8 sections, 2,876 words | 9 tasks      |
| Low    | 54 s      | 25 s       | 6 sections, 1,421 words | 8 tasks      |

Lower effort makes the plan coarser: fewer, larger tasks. That is a correctness trade, because a
larger task is a larger diff for an agent to build and a person to review. `planner.effort.spec` and
`planner.effort.tasks` in `.cairn/config.json` set the level per call; this repository uses medium
for the spec call and the default for tasks.

### The low-effort dry run

The same plan, end to end, with `planner.effort` set to low for both calls and the index hashes
filled in as a real plan would leave them: 109 seconds, 0 lint errors.

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

### Why a hand-run plan feels faster

Writing a spec and tasks by hand in one model session takes the owner one to two minutes. Cairn
takes longer for three reasons: about two thirds of its time is thinking at medium or high effort,
it makes three large calls that each start cold where a session makes one, and it indexes each new
section, which a hand-run plan does not.

Ways to close the gap that do not change what is written:

- Start the tasks call while the person reviews the spec. Not built; the owner has not decided.
- Run the index calls alongside the tasks call instead of before it. Not verified that the tasks
  call does not need the index.

One call for spec and tasks together would also be faster, but it removes the review between the
two steps that `prd.planning.two-reviews` requires.

## Size

### What is sent

The `sections` and `tasks` prompts (`packages/cli/prompts/`) each hold the whole PRD and the whole
`spec.md`. On 2026-11-26 that was 150K characters of PRD and 553K of spec, measured at 252,616
tokens (about 2.7 characters per token).

| Date   | PRD (chars) | Spec (chars) | Sent per big call |
| ------ | ----------- | ------------ | ----------------- |
| Nov 22 | 20K         | 71K          | 91K               |
| Nov 23 | 38K         | 168K         | 206K              |
| Nov 24 | 80K         | 190K         | 270K              |
| Nov 25 | 146K        | 529K         | 675K              |
| Nov 26 | 150K        | 553K         | 703K              |

Growth is bursty: one whole-PRD plan on Nov 25 added 340K characters of spec. The 1M-token window is
assumed, not confirmed; calls of 276K tokens succeeded.

`spec.json` is not a summary. It is 1.65M characters, three times `spec.md`. A map has to be cut
from it.

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
  of the spec. Without files and dependencies it is 46K.
- The graph slice is the sections that implement the parent PRD section plus what they depend on.
- Every variant cut the work into the same steps, named no id that does not exist, rewrote no
  existing section and covered all three done-when statements.
- Map only was vaguer. The graph slice declared 20 dependencies where the full prompt declared 8.
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

- 84 of the 126 new sections had no anchor at all: their PRD section was new and nothing
  implemented its parent yet.
- Recall fell as the spec grew: 100%, 90% and 63% for specs under 60, 60 to 120 and over 120
  sections.
- Pooled per plan run, the best rule found every dependency in 14 of 16 runs, but the pooled slice
  was 34 to 90% of the spec. For the four late runs that added a few sections, it stayed at 46 to 76
  sections while the spec tripled.
- The yardstick is imperfect: it is what a whole-document planner or a person declared. A model
  choosing from a map was not replayed.

So a fixed slice of 25 sections chosen by links does not hold. A workable slice here is 40 to 75
sections and needs text search and the most-used sections.

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

- **Splitting this repository into units.** About a third of dependency links cross any six-way
  cut, and 35% of sections are imported by another unit. It still fits separate products or
  repositories.
- **A tree of model-written summaries.** It conflicts in git whenever two people plan at once.

No design gives a guarantee. Cases 2 and 3 are caught only with some probability, by search, and
that probability has to be measured.

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

- **#222 had no CI run on its head commit** when this was written. Landing needs one on every pull
  request, so #222 and everything above it is blocked until that is sorted out.
- **#248** closes a gap found in the review: `editedOf` skipped every section a person wrote, 93 of
  180, so their summaries could go stale unseen. The first real plan after it lands re-reads those
  once.
- **#249 only records.** Nothing reports a section whose dependency changed.

## Found in the code, not fixed

- **A reply that reuses an existing section id has the id silently stripped** (`placed` in
  `packages/cli/src/spec-merge.ts`), so a duplicate lands under a new id with no report.
- **The relation index computes dangling links and nothing outside tests reads them**
  (`packages/core/src/relation-index.ts`).
- **Passing lint does not mean a requirement is met.** Lint checks that a section claims a PRD item,
  not that its text satisfies it.

Claimed by a skeptic and not checked: that the relation index fails near ten times today's size, and
that 21% of PRD prose is covered by no hash.

## Decisions for the owner

- **May the planner read a slice?** `prd.planning.part` requires reading the whole PRD, spec and
  manifest.
- **Should a changed dependency be reported?** It would change `prd.planning.again`, and one edit to
  a heavily used section would flag every section that depends on it.
- **Can finished spec sections be retired** to a short record once their code lands? If so the spec
  stops growing with history and most of the size problem goes away. Nothing here tested it.
- **Should tasks be drafted while the spec is being reviewed?**

## Next steps, in order

1. Land the stack, starting with #222's missing CI run.
2. Run one real plan, so the one-time re-read happens and freshness hashes are recorded.
3. Build a set of planning cases the owner has judged, scored for missed requirements, duplicates
   and contradictions. Record whole-document results now, while the spec still fits.
4. Add a scope to PRD rules.
5. Build the slice behind a setting, with whole-document planning as the default: linked sections,
   text search and the most-used sections in full, a map of the rest, and a receipt of what was
   shown.
6. Add the check after writing: search the whole spec for near matches to each new section and
   compare each pair in full.
7. Plant paraphrased duplicates in a corpus padded to about 18,000 sections and measure how often
   that search finds them.

Rules for doing this without regressions:

- Whole-document planning stays the default until the judged cases say a slice is as good.
- Never cut silently. If a slice does not fit, split the work or stop.
- The planner may depend only on a section it read in full.

## Assumptions that would change the plan if wrong

- The spec is a permanent record, so every landed section stays in the planner's input.
- Work divides into parts with few links between them. This repository argues against it.
- Planning is greenfield: the spec describes all the code that matters.
- Section summaries are accurate enough to reveal a conflict. Never evaluated.
- The whole-document plan is the right answer to compare against. An earlier whole-document run
  re-specced things that already existed.

## Considered and set aside

- **Rust.** Cairn's own work is 3 seconds of a run. The time is model calls and the limit is tokens.
- **Compression** (LLMLingua, other serialisations). It shrinks input by a constant factor, it is
  lossy on identifiers, and input size is not what takes the time.
- **Speculative encoding** (`b10-tv/speculative-encoding`). It needs the source model's hidden
  states and cache injection in the target, and lists only open-weight 8 to 14B models. Not usable
  with hosted Claude or OpenAI models.
- **Agent memory products.** `.cairn` is already the memory, versioned and hashed.
- **Embeddings first.** A safety net for finding a similar section with no link to the change; worth
  adding once the judged cases can measure it.
- **A Merkle tree over headings.** It tells you what changed, not what the change affects. A graph
  of receipts is the same hashing idea applied to dependencies, and that is what #249 starts.

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
- **Scripts and saved prompts.** In the session's scratchpad, which a reboot can clear: `slice/`
  (the map-plus-slice replay), `replay/` (the history replay), `cap2/` (saved planner prompts) and
  `effort/` (the replies at each effort level). Rebuild them from this file if they are gone.
- **How to time real calls.** Put a wrapper named `claude` first on `PATH` that saves stdin and the
  arguments and then runs the real binary. Replay the saved prompts with changed flags.
- **How to run a plan safely here.** In a scratch `git clone --local`, not a worktree: the CLI
  reads the main checkout's `.cairn`. Do not run `pnpm check` while a dry run's index calls are
  going; a viewer test timed out under that load.
