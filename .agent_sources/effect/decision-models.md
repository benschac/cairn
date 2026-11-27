# Decision models: typed questions with probabilities

Ask a model a typed question and get back a typed answer with its
probabilities, instead of prose to parse. `effect/ai` has four kinds of
question. They combine in one `Decision.make`, and `DecisionModel.decide`
(or `decideSettled`) asks them all in one request. Code then decides what to
do with the answers. Cairn's live decision model is TypeSafe's Jev, through
`@effect/ai-typesafe`.

Sources: the "Decision models overview" chapter of an Effect meetup talk
(<https://youtu.be/_tSGby_q890?t=2270>), TypeSafe's docs
(<https://docs.typesafe.ai/llms.txt>; append `.md` to a page path), and the
`typesafe-ai` skill. The code below type-checks against the installed
`effect@4.1.6` and `@effect/ai-typesafe@4.1.6`. Every kind is `unstable` in
`node_modules/effect/dist/ai/Decision.d.ts`; read the declarations before you
copy a call. To run one effect on several models and pick a winner, see
[compare-models.md](compare-models.md).

## The four kinds

| `effect/ai` | TypeSafe | Asks | Answer | Limits |
| --- | --- | --- | --- | --- |
| `Decision.classify({ instructions, criteria: { label: description \| null } })` | Choice | Which one of these labels? | `label`, `probabilities` (one per label, sum 1), `confidence?` | 2 to 255 labels; one pick only; leans toward the first label |
| `Decision.rate({ instructions, criteria: [lowest, ..., highest] })` | Score | Where on this ordered scale? | `label` (most likely level), `rating` (probability-weighted position in `[0, levels - 1]`), `probabilities`, `confidence?` | 2 to 10 levels; a string level is its own label and description, or use `{ label, description }` |
| `Decision.probability({ instructions, criteria?: { true, false } })` | Noul | Is this statement true? | `probability` of true | no `confidence`; one condition per question |
| `Decision.locate({ image: "path", instructions })` | Box | Where is this one thing in the image? | `box` (`left`, `top`, `right`, `bottom` as fractions of width and height from the top-left), `confidence?` | one box per question; always returns a box, even when the thing is absent; Jev 1.14 only |

`Decision.classify` and `Decision.rate` throw with fewer than two labels or
duplicate labels, and `Decision.make` throws with no decisions. Description
values can be a string or JSON (`{ what, examples }` reads well).

There is no multi-label, ranking, counting, extraction or generation kind. Each
is a pattern over the four:

| Need | Do this |
| --- | --- |
| Several labels can be true | One `probability` per label, in one request. |
| "None of these" | Pair the `classify` (or `locate`) with a `probability` that any label fits (or that the thing is in the image), and read it only when that is yes. TypeSafe says this beats a `none` label. |
| Rank candidates | One `probability` per candidate ("`candidate` answers `query`"), sorted in code. |
| Count | One `probability` per item, summed in code above a threshold. |
| Extract a value | Find candidates in code (a regex, a parser or a language model), then `classify` over them. Dates: `classify` over closed sets (month, day, year, `not_stated`), arithmetic in code. |
| Pick lines in a long text | `classify` over line IDs, plus a `probability` that the text answers at all. |
| A deep taxonomy | One `classify` per level, walked in code. |
| Generate text | Not a decision model's job. Use `LanguageModel`. |

## The shape

```ts
import { Effect, Number, Result, Schema } from "effect";
import { Decision, DecisionModel } from "effect/ai";

// The input is a schema. DecisionModel.decide encodes it to JSON with Schema.toCodecJson.
const BoardReply = Schema.Struct({ reply: Schema.String, task: Schema.String });

// The questions are plain data, so they live in core beside the input schema.
export const replyQuestions = Decision.make({
  decisions: {
    ended: Decision.probability({
      criteria: {
        false: "The author reports progress and keeps working. Example: t30 landed; continuing on t31.",
        true: "The author says they have stopped working on the task. Example: Stopping here, blocked on t40.",
      },
      instructions: "In `reply`, the author says they have stopped working on `task`.",
    }),
    // Speculative: asked in the same request, read only when `ended` is yes.
    why: Decision.classify({
      criteria: {
        abandoned: "The author dropped the task without finishing it.",
        blocked: "The author is waiting on something outside the task.",
        landed: "The task's pull request merged into main.",
      },
      instructions: "Why did the author stop working on `task`?",
    }),
  },
  input: BoardReply,
});

// The decision is code: thresholds, and a row for the band in between.
export const replyState = Effect.fn("replyState")(function* (input: typeof BoardReply.Type) {
  const { outcomes } = yield* DecisionModel.decideSettled(replyQuestions, { input });
  return Result.match(outcomes.ended, {
    onFailure: () => "unsure" as const, // Missing, Refused, NoDistribution or Invalid
    onSuccess: ({ probability }) =>
      Number.isGreaterThanOrEqualTo(probability, 0.7)
        ? ("ended" as const)
        : Number.isLessThanOrEqualTo(probability, 0.3)
          ? ("open" as const)
          : ("unsure" as const),
  });
});
```

- `DecisionModel.decide` returns `{ answers, modelId, usage, ... }` and fails
  the whole effect with an `AiError` when any decision is unanswered.
- `DecisionModel.decideSettled` returns `{ outcomes }`: one
  `Result<Answer, Unanswered>` per decision, so one refused question does not
  lose the rest. `Unanswered.reason` is `"Missing" | "Refused" |
  "NoDistribution" | "Invalid"`. The `Judge` uses it
  (`packages/cli/src/judge.ts`, `requestOf`).
- Both still fail with an `AiError` when the request fails. A failed call is
  an error, never a "no".

### Images and `locate`

```ts
const Screenshot = Schema.Struct({ statement: Schema.String, view: Decision.Image });

export const screenshotQuestions = Decision.make({
  decisions: {
    present: Decision.probability({ instructions: "`view` shows the stacks pane" }),
    pane: Decision.locate({ image: "view", instructions: "the stacks pane in `view`" }),
    fits: Decision.rate({
      criteria: [
        { description: "Text or controls are cut off or overlap.", label: "broken" },
        { description: "Everything is usable but something is cramped.", label: "cramped" },
        { description: "Everything fits with room to spare.", label: "fits" },
      ],
      instructions: "How well does the stacks pane fit in `view`?",
    }),
  },
  input: Screenshot,
});
```

- `image` is a path into the encoded input (`"photo"`, `"frames[2].frame"`),
  checked by the compiler: `Decision.make` rejects a path that is not a
  required `Decision.Image` field.
- `present` is the companion question: a box comes back even when the pane
  is not there.
- TypeSafe takes PNG or JPEG, 280 to 1568 px on each side, at most 16 MiB per
  image and 32 MiB per request. It rejects an image out of range rather than
  resizing it, and it ignores EXIF orientation. Images bill as input tokens.
  TypeSafe calls images and boxes experimental ("Danger Zone"); the format
  may change.

## Write the questions

The test for a question: could a person shown only this input answer it at a
glance? When the answer is no, fix the input before the wording.

- **The model judges; code decides.** Ask for the facts a decision rests on
  ("the reply says the author stopped"), not the decision ("should this
  thread close?"). Write the decision as a truth table in code, with a row for
  every combination of answers, including the unsure band.
- **One judgment per question.** A question joined by "and" or "or" is two
  questions. Five rules are five questions.
- **Ask the concrete, observable thing.** "The statement names a file,
  function or test", not "the statement is well written".
- **Phrase it so true means yes.** No "not", no double negatives. A
  `probability`'s `false` criterion is a situation ("the author keeps
  working"), not "not stopped".
- **Describe each `rate` level as a situation that reads alone.** "Several
  features, each of which could ship alone", not "bigger than the last
  level". Levels named only by numbers score poorly.
- **Labels are sent to the model; decision keys are not.** Name labels for
  their content (`blocked`, `landed`), never `a` or `option_1`.
- **Each question is answered alone.** Questions in one request cannot see
  each other. Context one question needs goes in its instructions or
  criteria; context many share goes in the input once, referred to by its
  path in backticks (`` `task` ``, `` `prdSections[0].body` ``).
- **Ask the same question per item, not over a list.** "Every PRD section
  listed has a task" over a list of 40 hides which one failed. One
  `probability` per section answers that and lets code count.
- **Name the case that confuses it**, with that case, in the criteria. Do not
  add a clause per failing test: that is prompt gymnastics and breaks on the
  next model.
- **Input: every field relevant, nothing truncated that a question needs.**
  Names, not IDs. Facts code already knows, stated. Leave out what no person
  could judge. Irrelevant fields lower accuracy for every question.
- **Bundle questions that share an input into one request.** Questions are
  cheap and run in parallel; the input is paid for once. Ask speculatively
  (`why` above). Make a second request only when code needs an answer to
  build the next input.
- **Keep all wording in one module.** Cairn's is
  `packages/core/src/judging/questions.ts`, with examples from this
  repository's own plan in the criteria.

## Read the answers

- **Thresholds are code, per provider, in config.** TypeSafe's starting point
  for a `probability` is yes at 0.7 or above, no at 0.3 or below, and
  unsure between. Raise the yes threshold when a wrong yes is costly. Do not
  fit thresholds to a handful of cases. Another provider's numbers mean
  something else (`prd.judging-the-plan`).
- **A probability near 0.5 means the input does not settle the question.**
  It is a row in the table, not a coin flip.
- **`confidence` is how peaked the distribution is, not the chance the
  answer is right.** Use it as a second axis at most. Read `probabilities`.
- **`rate`'s `rating` averages, so it hides two peaks.** A size answer split
  between `too_small` and `too_large` averages to `right`. Read `label` or
  `probabilities`; use `rating` only against a threshold, never as a
  measurement.
- **Pin the model** (`jev-1.14.0`, not `jev-latest`) once thresholds are
  tuned, and record `modelId` with each answer.
- **A low-confidence answer never acts** in Cairn. It is reported as `unsure`
  and the draft stands.

## Known weak spots (Jev)

From TypeSafe's jaggedness page; work around each in code or input.

| Weak spot | Workaround |
| --- | --- |
| Reads literally, not for intent | State the exact condition; split an interpretive question into literal ones. |
| Numbers, counting, maths | Do it in code. Convert numbers to named buckets. |
| Comparing dates | `classify` the parts, compare in code. |
| Indirection, double negatives, multi-hop | Ask directly; name the input field. |
| A large input of mostly irrelevant text | Filter in code, or screen with a `probability` first. |
| Instructions inside the input (prompt injection) | Be explicit in criteria; test hostile inputs. Never let an answer bypass a check that must hold. |
| Criteria that contradict the instruction | Make `true` mean the instruction holds. |
| First-option bias in `classify` | Reorder labels in a test and check the answer holds. |
| Writing text | Use `LanguageModel`; let the decision model pick among candidates. |

## Test without a provider

Tests never call TypeSafe. Build a `DecisionModel` with `DecisionModel.make`
and a scripted `decide` that answers by the decision's `_tag`, and provide it
with `Layer.succeed(DecisionModel.DecisionModel, model)`. Copy
`packages/cli/test/scripted-judge.ts`. Assert on what code does with each
answer (each row of the truth table, the unsure band, an `Unanswered`), and
record the requests to show what was asked. Never assert an exact probability
from a live model.

A live probe sends repository text to TypeSafe with `TYPESAFE_API_KEY` and
costs money (input tokens only; output is free). Ask the owner first, with a
budget and what data goes out. Keep each probe's payload so it can be rerun,
and check a wording change on cases you did not tune on.

## Where it must not go

The PRD keeps these deterministic or human. A decision model may not decide
them, and may not act on its own answer about them.

- **Gates and approval.** Judging never decides gates, IDs, branch names or
  order (`prd.judging-the-plan`). Gate approval is human-only and never an
  agent tool (`prd.agent-access`, `prd.launch.membership`); planning never
  touches a gate (`spec.cli.agent-access.review-checkpoints`).
- **Statements and reviews.** Only a person confirms a done-when statement;
  `--yes` does not agree to one, and a confirmed statement is never asked
  about or rewritten (`prd.done-when.asking`). A tool call is never an
  approval (`prd.agent-access`). The human still approves the plan.
- **What a person wrote.** A spec section a human wrote or edited is never
  rewritten, only reported on, and an existing task is never changed,
  renumbered or reordered (`prd.judging-the-plan`, `prd.planning.again`).
- **Low confidence never acts** (`prd.judging-the-plan`). Without a key,
  Cairn keeps the drafts and says judging was skipped: every question is an
  optional service.
- **Status, verification and cost.** Status comes from `events.jsonl` and git
  (`prd.orchestrator-contract`). A task is verified by its checks, not by
  an agent saying it is done, and a missing cost is unknown, never zero or
  guessed (`prd.outcomes.attempts`).
- **Structure drawn by code.** The stack diagram is never drawn by a model
  (`prd.planning.diagrams`); stack labels come from the manifest and spec
  (`prd.viewer.stacks`); a conflict score names its files
  (`prd.conflicts.predicting`); stopping running work is for a person
  (`prd.conflicts.running`).
- **Redaction** (`prd.redaction`) strips `.env*` values, token patterns and
  a deny list, and fails closed: an error means the session is not written.
- **Search** is local and ranked by rule (`prd.viewer.fuzzy-search`).
- **Anchors and links** match passages exactly and say when a passage changed
  (`prd.deep-links.missing`, `spec.hosted-launch.discussion`); a link never
  exposes a private title (`prd.launch.discussion`).
- **Hosted access.** A rule-based policy that denies by default decides who
  may do what (`prd.v2-multiplayer-on-cloudflare.permissions`); only a human
  resolves a human's note (`prd.launch.discussion`).
- **Hooks and the guard** (`scripts/guard/policy.ts`), the gate record,
  commit trailers and `pnpm land`'s checks.
- **Explanations are never parsed** (`spec.judging.model-catalog`): code
  reads the typed answer only.

## Where Cairn uses it, or could

Checked against `origin/main` at `5f9d300` on 2026-11-26, with three
independent passes over the PRD, the spec and the code. `pnpm tasks <id>`
shows a task's current state; the manifest's `status` lags, so "built"
below means its commit is on `main`.

### Written

| Where | Kinds | What it asks |
| --- | --- | --- |
| `packages/core/src/judging/questions.ts` `sectionQuestions` | `rate` `size`; `probability` `faithful`, `buildable` | Each spec section, after the spec is written. |
| `taskQuestionsWithoutModel`, `taskQuestions` | `probability` `matches`; `rate` `size`, `reasoning`; `classify` `model` over `judge.models` | Each task, after drafting. `model` is built only with two models or more (`judge.ts`). |
| `stackQuestions` | `probability` `complete`, `ordered`, `oneFeature` | The whole stack. The viewer shows none of the three. |
| `packages/core/src/judging/verdicts.ts` | | The truth table: `pass`, `flag` or `unsure` from `judge.pass` (0.8), `judge.flag` (0.5) and `judge.minConfidence` (0.5). |
| `packages/cli/src/judge.ts`, `packages/cli/src/refine.ts` | `decideSettled` | One request per target, four at a time, hashed so an unchanged target is not asked again; `refine` splits what is judged too large. |

Before adding or renaming a question:

- Add its name to `JudgmentQuestion` (`packages/contract/src/judgments.ts`)
  and to `KIND` in `verdicts.ts`. `requestOf` in `judge.ts` drops a
  decision key that is not a `JudgmentQuestion`, silently.
- `inputHash` covers the input, not the wording. A reworded criterion
  leaves old judgments fresh until `cairn judge --fresh`.
- A target needs every current question to be reused, so a new question
  re-asks every target once.
- A question about a new kind of thing (a PRD section, a file) needs a new
  `JudgmentTarget`, and every exhaustive match on it: `nameOf` in
  `judge.ts`, `targetName` in `print-judgments.ts`, `placeOf` in
  `commands/judge.ts`, `judges()` in `apps/viewer/src/trace.ts`.

### Against the rules above

None of these is a bug the tests show. Each is where the written or specified
questions depart from the guidance. Probe before and after a change.

- **`faithful` and `matches` each ask two things.** "Does what its PRD
  sections ask *and* adds nothing they do not ask" is a missing-behaviour
  question and an extra-behaviour question. Split them so a flag says which.
  The extra half of `matches` ("reaches past its spec sections") is not a
  clean set difference: 116 of 248 tasks name tests or `index.ts` files that
  their sections' `Files` leave out, so it stays a question.
- **`complete` and `ordered` judge a whole list at once.** One question per
  PRD section, given only the tasks that implement it, and one per task, given
  only its dependencies, would say which section is missing or which task is
  out of order. Structural coverage is already lint (`unmapped-section`,
  `unmapped-item`); the question adds whether those tasks build what the
  section asks. Under `cairn judge --strict`, many small questions need the
  unsure band, or a low false-flag rate fails most runs.
- **`size`, `model` and `reasoning` are gated on `confidence`**, which says
  how peaked the answer is, not how likely it is to be right. Read the
  label's probability instead.
- **Thresholds differ from TypeSafe's starting point.** `judge.pass` 0.8 and
  `judge.flag` 0.5 make 0.7 to 0.8 unsure and 0.3 to 0.5 a flag, where 0.7
  and 0.3 would call them yes and unsure.
- **`judge.models` lists `haiku` first**, and `classify` leans toward the
  first label, which favours the cheapest model. Test `model` with the
  labels reordered.
- **The routing `model` question as specified** (`spec.judging.model-catalog`,
  t145) gives the model prices and asks for "the lowest expected total cost
  of an accepted result". That is a decision plus arithmetic. Ask capability
  (`rate` `risk`, `complexity`, `reasoning`) and apply prices, preferences
  and the ceiling in code, as `rankOf` already does
  (`spec.judging.routing-from-history`). With fewer than two eligible models
  `classify` throws: skip the question.
- **`splitFile`** (`spec.planning.conflict-ordering`, t142, claimed, not
  built) asks "would splitting the file remove more conflicts than
  reordering?" over a path, a line count and task titles: a counterfactual
  and a number, which no person could answer from that input. Code already
  finds the hotspot; ask `separable` (`` the tasks change parts of `file`
  that do not depend on each other") over the file's top-level declarations
  and each task's title and section summary, and report "split" on yes,
  "reorder" on no, the hotspot alone when unsure.
- **`judgments.json` records one `model` per file** (`spec.contract.judgments`);
  a per-judgment provider and model arrive with t146.

### Candidates in written code

| Where | Today | Question | Fit |
| --- | --- | --- | --- |
| `replan.ts` (`spec.planning.again`, t112 and t113; code on main) | A PRD section's body hash changing marks its spec sections and tasks stale, and a `rewritable` section (Cairn wrote it, nobody edited it, no task builds it) is rewritten by the planner with no question. A typo fix costs a rewrite. | `probability` `materialChange` over the old and new PRD text: "the new text asks for something the old did not, or stops asking for something". | Good. Gate the automatic rewrite: confidently cosmetic skips it, unsure rewrites as today. The stale flag still shows, marked "likely cosmetic", and `cairn plan --accept` still clears it. Call it from the `plan` command; `replanOf` stays pure. PRD change (`prd.planning.again`). The same question serves the v2 rebase flow (`prd.v2-diverging-state.rebase-flow`) and the "plan no longer current" notice (`prd.launch.history`). #249 records spec dependencies' hashes, which this could cover later. |
| `replan.ts` item coverage (`prd.planning.again`; `spec.sections.item-coverage`) | The PRD says an item given an ID after its section was planned is added to the `Implements` of the spec sections that already build it. The spec has no row for it and no task builds it, so such items stay `unmapped-item`. | Per (item, candidate section) pair, `probability` `buildsItem`: `` `spec` already builds what `item` asks for ``. Code picks the candidates: sections that implement the item's heading or parent item. | Good, and the PRD already asks for it: spec change and a new task. Yes adds the item to that section's `Implements`; no for every candidate writes a new section; unsure leaves it unmapped and reported. Only into sections Cairn wrote and nobody edited; never for a `<!-- human -->` item, whose mapping would gate tasks. |
| `ask-statements.ts`, `packages/cli/prompts/statements.md` (`spec.planning.done-when.asking-the-person`, t133, built) | The `statements` prompt returns an empty list to mean "this target describes nothing to build", unrecorded. A person then reads every `Draft:` statement. | Per target, `probability` `describesBuild` (input: its own body and its children's titles). Per draft, `probability` `faithful`, `namesImplementation` (names a file, function or test, which `prd.done-when.statements` forbids), `observable` and `needsPerson`. | Good. `describesBuild`: unsure or no key drafts as today. A draft that names implementation goes back to the planner once before the person sees it. The rest are hints beside the prompt, and in MCP beside `Review.drafts`. Never accept for the person; suggest `<!-- human -->`, never add it. PRD change for the hints. |
| `scripts/tasks/report.ts` `STOPPED`, `isOpen` | A board thread is open until a sentence of its latest reply starts with Stopping, Stopped, Landed or Abandoned: the only keyword match over prose in the repository. | The `replyQuestions` example above: `probability` `ended`, speculative `classify` `why`. | Good. A developer script, no PRD change. `pnpm tasks` already uses the network; only `TYPESAFE_API_KEY` is new, so the regex stays the answer without a key and for unsure. |
| Task `category` (`spec.planning.task-categories`, t137, built) | The planner picks it from config's list; the planner refuses a draft outside the list and lint reports `unknown-category` and `missing-category`. | `classify` over config's categories, in `taskQuestions` beside `model`. | Good and small, as a second opinion that flags a disagreement. Likely a PRD change: `prd.outcomes.categories` gives the choice to the planner and `prd.judging-the-plan` lists the checkpoints. Not for backfilling old tasks: they have no attempts to feed `rankOf`. |
| `lint.ts` `unprovedStatements` (`spec.planning.done-when.tracing-statements`, t134, built) | A statement with an ID and no `<!-- human -->` tag is unproved when no test in an implementing spec section lists it in `proves`. The planner writes `proves`; code keeps only IDs it knows. | Per claimed pair, `probability` `` `test` exercises `statement` ``. | Weak: a spec test is one line of prose, so the answer mostly measures word overlap. If built, ask at index time, where the claim is made, and only flag. PRD change. |
| `conflicts.ts` (t141, built) | A weighted score from co-change history, churn and declared files. | `probability` that two tasks with disjoint files change the same behaviour. | Weak: the score must name its files (`prd.conflicts.predicting`). |
| `gates.ts` | `<!-- human -->` tags and `humanPaths` globs. | `probability` that an ungated task touches auth, money or data loss. | Weak: a lint warning at most. |

### In the PRD and spec, not built yet

| Task | Section | Question | Fit |
| --- | --- | --- | --- |
| t143, t145, t150 | `prd.judging-the-plan.routing`, `spec.judging.model-catalog`, `spec.judging.routing-from-history` | `rate` `risk` and `complexity` per task, beside `reasoning`; prices in code (see above). | Good, no PRD change: the PRD names complexity and risk as routing inputs. Required tools is weak: the catalog records no tools per harness. |
| t142 | `spec.planning.conflict-ordering` | `separable` instead of `splitFile` (see above). | Good once reworded. The task is claimed: change the spec before it is built. |
| t144, t157 | `prd.outcomes.attempts`, `spec.orchestrator-adapter.attempts-and-verification` | A failure's reason, restricted to what the facts leave open: when verify failed, `classify` `checks` vs `upstream`; when the agent stopped without verifying, `agent` vs `infra`. | Good, and it feeds routing (only `checks` and `agent` count against a first-pass rate). Never let a free choice relabel a failed check as `infra`. The adapter writes the reason on the `failed` event and "adds no detector of its own", so this needs a PRD and a spec change and a place to run. |
| t150, t126 (built) | `prd.outcomes.metrics`, `spec.sessions.notes` | Per `review` note, `classify` `finding` (`breaks_spec`, `bug`, `test_cannot_fail`, `style`) and `probability` `actionable`, over the note, its hunk and the section title. | Good: the PRD lists review findings and repair work as routing evidence, but `rankOf` reads only first-pass rate and cost. Count findings per verified task in `cairn stats`. PRD change; a label never blocks landing or resolves a note. |
| t170 | `prd.viewer.notes`, `spec.viewer.notes` | `classify` a note (`question`, `blocker`, `bug`, `nit`); `probability` that a later diff addresses an open thread. | Good for sorting and badges only. A note's `kind` (`note` or `review`) is the author's and stays. Only a human resolves a human's note. PRD change. |
| t223, t205 | `prd.launch.sharing`, `spec.hosted-launch.sharing-dialog` | Per piece of content that becomes public (section bodies, comments, task titles), `probability` that it holds private data, shown in "Make public…". | Weak: fields are fixed by schema (`publicTraceOf`), so this is a warning on content only, and hosted calls would send customer text out under the operator's key. |
| t1, t3 | `prd.redaction`, `spec.sessions.redaction` | `probability` that a string left after redaction is a secret. | Weak. It may only strip more. Its input is exactly the text that may still hold a secret, so a miss sends it to a provider; gateway logging of repository content must be set explicitly (`prd.judging-the-plan.gateway`). Needs a PRD change and an explicit opt-in. The section is `<!-- human -->`. |
| t146, t147 | `spec.judging.openai-decisions`, `spec.judging.comparing-decision-providers` | A second `DecisionModel` layer; the same requests to both. | Covered in [compare-models.md](compare-models.md). A person picks the evaluation tasks. |

### Deferred in `prd.later`

- **Choosing a recovery after a failed attempt.** Ask the facts, not the
  choice: the brief lacked something the agent needed; the diff spans two
  concerns; the failure repeats the last one. Code picks retry, stronger
  model, other harness, more context, smaller task or a person.
- **Judging during a run, and drift**: the `matches` and `faithful` questions
  asked of a task's diff instead of its draft.
- **Scoring planners against a reference plan**: per (reference task,
  candidate task) pair that shares a PRD section, `probability` `sameChange`;
  code matches one to one and computes recall and precision. No question
  scores a whole plan.
- **Images.** Cairn captures none. v2 stores screenshots attached to notes
  (`prd.v2-multiplayer-on-cloudflare.notes`); if a feature ever reads them,
  `screenshotQuestions` above is the shape, and it cannot settle a
  `<!-- human -->` statement, which only a person confirms.

### Considered and left out

- **Weak, list only:** whether a section needs an outside section it does not
  name in `Assumes:`; suggesting a diagram for a section that describes
  states or messages; suggesting an ID for an item that could be built alone
  (`cairn ids` never adds one unasked); flagging private data in note
  attachments.
- **Against the PRD:** a checklist that pre-answers a gate (it invites
  rubber-stamping where the PRD wants a person's eyes); a model choosing
  which tasks evaluate providers (a person picks them); suggesting links
  between PRDs (would expose private titles); re-anchoring a comment whose
  passage changed (anchors match exactly, against fixtures the viewer
  shares); semantic search.
- **Structural:** status, metrics, history ranking, conflict scores, landing
  order, relations, stack labels, deep links, the terminal view, the docs
  reference, hunk-to-turn attribution, permissions, billing, invitations,
  agent credentials, presence and the event log.
