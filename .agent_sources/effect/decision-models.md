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

Keep these deterministic: a probability here is a bypass.

- Hooks and the guard (`scripts/guard/policy.ts`), the gate record, commit
  trailers and `pnpm land`'s checks.
- Human gates and gate approval. Judging never decides gates, IDs, branch
  names or order (`prd.judging-the-plan`), and only a person confirms a
  done-when statement (`prd.done-when.asking`).
- Redaction's main path (`prd.redaction`): it fails closed on exact values
  and patterns. A model may only ever strip more.
- Parsing: sections, IDs, manifests, diagrams, session logs and status
  derivation.
- The viewer's search, which is local, lexical and ranked by rule
  (`prd.viewer.fuzzy-search`).

## Where Cairn uses it, or could

Checked against local `main` at `56fd882` on 2026-11-26. `pnpm tasks <id>`
shows a task's current state. A candidate marked "PRD change" needs the owner
to change the PRD first.

### Written

| Where | Kinds | What it asks |
| --- | --- | --- |
| `packages/core/src/judging/questions.ts` `sectionQuestions` | `rate` `size`; `probability` `faithful`, `buildable` | Each spec section, after the spec is written. |
| `taskQuestionsWithoutModel`, `taskQuestions` | `probability` `matches`; `rate` `size`, `reasoning`; `classify` `model` over `judge.models` | Each task, after drafting. `model` is built only with two models or more. |
| `stackQuestions` | `probability` `complete`, `ordered`, `oneFeature` | The whole stack. |
| `packages/core/src/judging/verdicts.ts` | | The truth table: `pass`, `flag` or `unsure` from `judge.pass` (0.8), `judge.flag` (0.5) and `judge.minConfidence` (0.5). |
| `packages/cli/src/judge.ts`, `packages/cli/src/refine.ts` | `decideSettled` | One request per target, four at a time, hashed so an unchanged target is not asked again; `refine` splits what is judged too large. |

### Against the rules above (review before changing)

None of these is a bug the tests show. Each is where the written questions
depart from the guidance; probe before and after, with the owner's budget.

- **`faithful` and `matches` each ask two things.** "Does what its PRD
  sections ask *and* adds nothing they do not ask" is a missing-behaviour
  question and an extra-behaviour question. Split each into two
  `probability` questions so a flag says which.
- **`complete` and `ordered` judge a whole list at once.** One
  `probability` per PRD section (`` some task builds `section` ``) and one per
  task (`` `task` can be built with only its dependencies ``) would say which
  section is missing or which task is out of order, and code would count.
- **`size`, `model` and `reasoning` are gated on `confidence`.**
  `minConfidence` reads how peaked the answer is, not how likely it is to
  be right. Reading the winning label's probability is closer to the
  guidance.
- **`judge.flag` defaults to 0.5**, so a `probability` between 0.3 and 0.5
  is a `flag`, where TypeSafe's starting point would call it unsure.
- **`model` has no companion question.** Every task needs some model, so a
  forced pick is fine today; once the catalog is filtered by eligibility
  (`spec.judging.model-catalog`), ask whether any listed model fits.

### Candidates in written code

| Where | Today | Question | Fit |
| --- | --- | --- | --- |
| `scripts/tasks/report.ts` `STOPPED`, `isOpen` | A thread is open until a sentence of its latest reply starts with Stopping, Stopped, Landed or Abandoned. The only keyword match over prose in the repository. | The `replyQuestions` example above: `probability` `ended`, speculative `classify` `why`. Unsure keeps the regex's answer. | Good. A developer script, no PRD change; it would make `pnpm tasks` need a key and the network, so keep the regex as the offline default. |
| `packages/core/src/replan.ts` `stalenessOf` | Any change to a PRD section's body hash makes its spec sections and tasks stale, a typo fix included. | `probability` `materialChange` over the old and new PRD text; per implementing section, `probability` `` `spec` still does what `prd` asks ``. | Good, advisory only: show "likely cosmetic" beside the stale flag, never clear it. PRD change (`prd.planning.again`). |
| `packages/cli/src/ask-statements.ts` `askStatements` | A person reads every `Draft:` statement and accepts, rewrites, deletes or skips it. | Per draft: `probability` `faithful` (states what its PRD section means), `namesImplementation` (names a file, function or test, which `prd.done-when.statements` forbids), `observable`, `needsPerson` (only a person looking can settle it). | Good as hints that order and annotate the prompt. Never accept for the person (`prd.done-when.asking`); suggest the `<!-- human -->` tag, never add it. PRD change. |
| `packages/core/src/lint.ts` `unprovedStatements` | A statement is proved when its ID is in some test's `proves`. | `probability` `` `test` exercises `statement` `` per claimed pair. | Weak to good, as a `cairn judge` warning beside the structural check, never instead of it. PRD change. |
| Task `category` (`spec.planning.task-categories`; `packages/cli/src/planner.ts`) | The planner writes it; lint checks it is in config's list. | `classify` over config's categories, in `taskQuestions` beside `model`. | Good, small: config already owns the labels, as `judge.models` does for `model`. A second opinion needs no PRD change; overriding the planner does. |
| `packages/core/src/conflicts.ts` | A weighted score from co-change history and declared files. | `probability` that two tasks with disjoint files change the same behaviour. | Weak: the score must stay explainable by files (`prd.conflicts.predicting`). |
| `packages/core/src/gates.ts` | `<!-- human -->` tags and `humanPaths` globs. | `probability` that an ungated task touches auth, money or data loss. | Weak: a lint warning at most; gates stay deterministic. |

### In the PRD and spec, not built yet

| Task | Section | Question | Fit |
| --- | --- | --- | --- |
| t144, t157 | `prd.outcomes.attempts`, `spec.status.attempts`, `spec.orchestrator-adapter.attempts-and-verification` | `classify` a failed attempt's reason over `checks`, `agent`, `infra`, `upstream`, from the verify output tail and the session's last turns. | Good, and it feeds routing: only `checks` and `agent` count against a model's first-pass rate. Label only, never the outcome; a low answer keeps the adapter's reason. PRD change to say a model may label. |
| t143, t145, t150 | `spec.judging.model-catalog`, `spec.judging.routing-from-history` | `rate` `risk` and `complexity` per task (the PRD lists both as routing inputs), beside `reasoning`. | Good; composite scoring: rate each dimension once, weigh in code. |
| t146 | `spec.judging.openai-decisions` | A second `DecisionModel` layer; same questions. | Covered in [compare-models.md](compare-models.md). |
| t147 | `spec.judging.comparing-decision-providers` | Same requests to both providers. | Covered in [compare-models.md](compare-models.md). |
| t126, t170, hosted t213, t214, t224 | `prd.viewer.notes`, `spec.sessions.notes`, `spec.viewer.notes`, `prd.launch.discussion` | `classify` a note or review finding (`question`, `blocker`, `bug`, `nit`); `probability` that a later diff addresses a resolved thread. | Good for sorting and badges; a label never blocks landing. PRD change. |
| t205, t209, t215 | `prd.launch.sharing`, `spec.hosted-launch.visibility` | `probability` per field that it holds private data, before making a plan public. | Weak: a warning beside the deterministic stripping rule. |
| t1, t3 | `prd.redaction`, `spec.sessions.redaction` | `probability` that a string left after redaction is a secret. | Weak: a second pass that only strips more, and it sends session text to a provider, which the PRD rules out without an opt-in. |
| t213 | `prd.launch.discussion`, `prd.deep-links.missing` | `probability` that a changed passage means the same, to offer a re-anchor. | Weak: a hint only; the PRD wants "the passage changed" shown. |

### Deferred in `prd.later`

- **Choosing a recovery after a failed attempt**: `classify` over `retry`,
  `stronger_model`, `other_harness`, `more_context`, `smaller_task`,
  `hand_to_person`, read with the failure-reason `classify` above.
- **Judging during a run, and drift**: the `matches` and `faithful`
  questions asked of a task's diff instead of its draft.
- **Screenshots**: nothing in the PRD captures an image today, so `locate`
  has no use yet. If the viewer gains screenshot capture, the
  `screenshotQuestions` example above could check a human-tagged visual
  statement such as "reads well at phone width" and report it. It cannot
  settle that statement, because only a person confirms it.
