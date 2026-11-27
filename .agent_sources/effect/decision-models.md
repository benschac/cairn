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
independent passes over the PRD, the spec and the code, and updated for the
stack that built t250 to t259 on 2026-11-27. `pnpm tasks <id>`
shows a task's current state; the manifest's `status` lags, so "built"
below means its commit is on `main`.

### Written

| Where | Kinds | What it asks |
| --- | --- | --- |
| `packages/core/src/judging/questions.ts` `sectionQuestions` | `rate` `size`; `probability` `faithful`, `inScope`, `buildable` | Each spec section, after the spec is written. |
| `taskQuestionsWithoutModel`, `taskQuestions`, `taskQuestionsFor` | `probability` `matches`, `inScope`, `ordered`; `rate` `size`, `reasoning`; `classify` `model` over `judge.models`, `category` over `config.categories` | Each task, after drafting; `ordered` only once `stackOf` has ordered the drafts, over the task's `others` (tasks it does not depend on that share a section or file with it). `model` and `category` are asked only with two labels or more. |
| `prdSectionQuestions` | `probability` `built` | Each PRD section some task implements, given only those tasks. The viewer marks the section. |
| `stackQuestions` | `probability` `oneFeature` | The whole stack. The viewer does not show it. |
| `partQuestions` (t255) | `probability` `describesBuild` | Each PRD part before statements are drafted; a confident no gets no draft (`ask-statements.ts`). |
| `draftQuestions` (t256) | `probability` `faithful`, `observable`, `namesImplementation`, `needsPerson` | Each draft statement: a confident `namesImplementation` is drafted again once; the rest print as notes under the draft and never change the PRD. |
| `changeQuestions` (t257) | `probability` `materialChange` | Each changed PRD body before a stale spec section is rewritten; a confident no keeps the section and marks it likely cosmetic (`commands/plan.ts`). |
| `itemQuestions` (t258) | `probability` `buildsItem` | Each new item and candidate spec section; yes adds the item to that section's `Implements` (`commands/plan.ts`). |
| `noteQuestions` (t259) | `classify` `label`; `probability` `actionable` | Each note `cairn note add` stores; the label is kept only above `judge.minProbability` (`commands/note.ts`). |
| `scripts/tasks/reply-questions.ts` | `probability` `ended`; `classify` `why` | The latest reply of each board thread that claims a task; the regex decides when the judge is unsure, missing or slow. |
| `packages/core/src/judging/verdicts.ts` | | The truth tables: `verdictOf` gives `pass`, `flag` or `unsure` from `judge.pass` (0.7), `judge.flag` (0.3) and `judge.minProbability` (0.5), reading a label's own probability, never `confidence`; `yesNoOf` reads a probability as yes, no or unsure. |
| `packages/cli/src/judge.ts`, `packages/cli/src/refine.ts` | `decideSettled` | `Judge.judge`: one request per target, four at a time, hashed so an unchanged target is not asked again; `refine` splits what is judged too large. `Judge.ask`: one definition about many inputs during planning, no `judgments.json`. |

Before adding or renaming a question:

- Put its wording in `questions.ts` beside the others.
- A plan judgment: add its name to `JudgmentQuestion`
  (`packages/contract/src/judgments.ts`) and to `KIND` in `verdicts.ts`.
  `requestOf` in `judge.ts` drops a decision key that is not a
  `JudgmentQuestion`, silently; `questions.test.ts` checks every key.
- `inputHash` covers the input, not the wording. A reworded criterion
  leaves old judgments fresh until `cairn judge --fresh`.
- A target needs every current question to be reused, so a new question
  re-asks every target once.
- A question about a new kind of thing (a PRD section, a file) needs a new
  `JudgmentTarget`, and every exhaustive match on it: `nameOf` in
  `judge.ts`, `targetName` in `print-judgments.ts`, `placeOf` in
  `commands/judge.ts`, `judges()` in `apps/viewer/src/trace.ts`.
- A planning question goes through `Judge.ask` and `yesNoOf`; without a
  judge, the step runs as it did before the question existed.

### Still to check

- **Only the planning questions have been probed against Jev**: once, on
  2026-11-27, through the gateway, with 35 cases from this repository
  (32,878 input tokens, about $0.0014). No answer fell on the wrong side of
  a threshold in a way that changes what Cairn does.
  - `materialChange` and `buildsItem` got all 12 cases right, every "no" at
    0.08 or lower. `buildsItem` passed `prd.cli.lint` against `spec.lint`
    at only 0.76.
  - `describesBuild` gave 0.97 to 0.99 to parts that ask for something to
    build, and under 0.3 to three of the five that do not. `prd.done-when`'s
    introduction stayed unsure at 0.39. `prd.v2-diverging-state` got 0.83 by
    reading "This later extension adds ..." literally; `spec.scope` defers it
    anyway. `prd.repo-layout` got 0.22, so it would get no draft statement.
  - The draft notes: `namesImplementation` caught both statements that name
    code (0.86, 0.96) and passed one that names a `cairn` command (0.04);
    `needsPerson` gave 0.96 to a "reads well" statement.
  - Not probed yet: `inScope`, `category`, `built`, `ordered`,
    `noteQuestions` and the `pnpm tasks` reply question. Probe each with
    representative, hard and negative cases before trusting its thresholds.
- **`judge.models` lists `haiku` first**, and `classify` leans toward the
  first label, which favours the cheapest model. Probe `model` with the
  labels reordered.
- **`judgments.json` records one `model` per file** (`spec.contract.judgments`);
  a per-judgment provider and model arrive with t146.
- **A part run that plans one list item asks `built` of its heading**, which
  can flag a sibling left for later (`spec.planning.planning-a-part`).

### Specified, not built yet

| Task | Section | Question | Fit |
| --- | --- | --- | --- |
| t145 (with t143, t150) | `spec.judging.model-catalog`, `spec.judging.routing-from-history` | `model` over eligible models only, with no prices; `rate` `risk` and `complexity` as evidence; prices, ceiling and preferences in code. | Specified. Asking a decision model for the cheapest acceptable model asks it to do arithmetic. |
| t142 | `spec.planning.conflict-ordering` | `separable`: the tasks change parts of a hotspot file that do not depend on each other, over its top-level declarations and each task's title and section summaries. | Specified, replacing `splitFile`'s counterfactual over a line count. The task is claimed by another session. |
| t260 (after t157) | `spec.orchestrator-adapter.attempts-and-verification` | `cairn judge failure`: `upstream` when verify failed, `infra` when the agent stopped without verifying. | Specified. Only the two-way choices the facts leave open; whether an attempt verified is never asked. |
| t261 (after t170) | `spec.viewer.notes` | Shows each note's label; open notes list blockers first. | Specified; the label is `noteQuestions` (t259). |
| t262 (after t149) | `spec.status.outcome-metrics` | `findingsPerVerified`: review notes labelled `breaks_spec` or `bug` per verified task. | Specified, as routing evidence beside first-pass rate and cost. |
| t146, t147 | `spec.judging.openai-decisions`, `spec.judging.comparing-decision-providers` | A second `DecisionModel` layer; the same requests to both. | Covered in [compare-models.md](compare-models.md). A person picks the evaluation tasks. |

### Considered and left out

- **Weak:** whether a test exercises the statement it claims to prove (a spec
  test is one line of prose, so the answer measures word overlap); two
  tasks with disjoint files changing the same behaviour (a conflict score
  must name its files); an ungated task touching auth or money (gates stay
  deterministic); private data in content made public (fields are fixed by
  schema, and hosted calls would send customer text out); a secret left
  after redaction (its input is the text that may hold the secret).
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

### Deferred in `prd.later`

- **Choosing a recovery after a failed attempt.** Ask the facts, not the
  choice: the brief lacked something the agent needed; the diff spans two
  concerns; the failure repeats the last one. Code picks retry, stronger
  model, other harness, more context, smaller task or a person.
- **Judging during a run, and drift**: the `matches`, `inScope` and
  `faithful` questions asked of a task's diff instead of its draft.
- **Scoring planners against a reference plan**: per (reference task,
  candidate task) pair that shares a PRD section, `probability` `sameChange`;
  code matches one to one and computes recall and precision. No question
  scores a whole plan.
- **Images.** Cairn captures none. v2 stores screenshots attached to notes
  (`prd.v2-multiplayer-on-cloudflare.notes`); if a feature ever reads them,
  `screenshotQuestions` above is the shape, and it cannot settle a
  `<!-- human -->` statement, which only a person confirms.
