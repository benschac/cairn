# One AI effect, many models

Write the AI effect once, then choose the model by the layer you provide to it.
Every provider's model is a layer for the same `effect/ai` service
(`LanguageModel` to write, `DecisionModel` to judge), so running the same
effect on several models is `Effect.all` over copies with different layers,
and picking the best answer is one more layer: a `DecisionModel` whose labels
are the candidates' keys.

Source: the "Comparing models" chapter of an Effect meetup talk
(<https://youtu.be/_tSGby_q890?t=2066>). The code below is rewritten against the
installed `effect@4.1.6` and `@effect/ai-*@4.1.6` and type-checks there; read
the declarations before you copy a call (`node_modules/effect/dist/ai/`,
`packages/cli/node_modules/@effect/ai-*/dist/`). For the four kinds of
question and how to write and read them, see
[decision-models.md](decision-models.md).

## The shape

```ts
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Array, Config, Effect, Layer, Option, Record, Result, Schema } from "effect";
import { Decision, DecisionModel, LanguageModel, Model } from "effect/ai";
import { FetchHttpClient } from "effect/http";

// 1. Each candidate is a layer for the same service, keyed by the name the judge will answer with.
const anthropic = AnthropicClient.layerConfig({ apiKey: Config.Redacted("ANTHROPIC_API_KEY") });
const openai = OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") });
const candidates = {
  gpt: OpenAiLanguageModel.model("gpt-6.1").pipe(Layer.provide(openai)),
  opus: AnthropicLanguageModel.model("claude-opus-5-5").pipe(Layer.provide(anthropic)),
  sonnet: AnthropicLanguageModel.model("claude-sonnet-5-5").pipe(Layer.provide(anthropic)),
};
const judge = TypeSafeDecisionModel.model("jev-1.14.0").pipe(
  Layer.provide(TypeSafeClient.layerConfig({ apiKey: Config.Redacted("TYPESAFE_API_KEY") })),
);

// 2. The AI effect, written once. It asks for the service inside, so each copy resolves its own.
const draft = (prd: string) =>
  Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({ prompt: prd });
    const configured = yield* Model.ModelName; // the name given to the layer
    // The model the provider says ran, which can differ when the name is an alias.
    const answered = Array.findFirst(response.content, (part) =>
      part.type === "response-metadata" ? Option.fromUndefinedOr(part.modelId) : Option.none(),
    );
    return { answered, configured, text: response.text };
  });

// 3. The judge's question. Its labels are the candidates' keys, so the answer indexes back.
// The judge sees only its input, so the input carries the PRD as well as the drafts.
const Drafts = Schema.Struct({ gpt: Schema.String, opus: Schema.String, sonnet: Schema.String });
const PickDraft = Decision.make({
  decisions: {
    best: Decision.classify({
      criteria: { gpt: null, opus: null, sonnet: null },
      instructions: "Which draft is the most faithful and buildable spec for the PRD?",
    }),
  },
  input: Schema.Struct({ drafts: Drafts, prd: Schema.String }),
});

// 4. Fan out, then judge.
export const compare = Effect.fn("compare")(function* (prd: string) {
  const drafts = yield* Effect.all(
    Record.map(candidates, (layer) => draft(prd).pipe(Effect.provide(layer))),
    { concurrency: "unbounded", mode: "result" },
  );
  const texts = Record.map(drafts, Result.match({ onFailure: () => "(no draft)", onSuccess: (d) => d.text }));
  const { answers } = yield* DecisionModel.decide(PickDraft, { input: { drafts: texts, prd } }).pipe(Effect.provide(judge));
  return {
    best: answers.best.label, // "gpt" | "opus" | "sonnet"
    probabilities: answers.best.probabilities, // one per candidate
    winner: drafts[answers.best.label],
  };
}, Effect.provide(FetchHttpClient.layer));
```

The judge answers with a typed label and a probability for each candidate, not
free text to parse, and it is a layer too, swappable like the models it judges.

## Rules

- **Keep the service lookup inside the effect.** `draft` yields
  `LanguageModel` when it runs, so `Effect.provide(layer)` decides which model
  each copy gets. A service that does `yield* LanguageModel.LanguageModel` once
  in its `Layer.effect` and closes over it (`Planner.layerWith`,
  `Judge.layerWith`) is bound to one model: to compare, provide a whole new
  service layer per candidate, or move the lookup into the method.
- **Key candidates by name, in a struct or record.** `Effect.all` keeps the
  keys, so `drafts` has the same keys as `candidates` and the judge's label
  indexes straight back into it. A list from config is a `Record` and works
  the same way (`Record.map` then `Effect.all`).
- **`Decision.classify` throws with fewer than two labels.** Build the
  definition only when there are two candidates or more; see `taskQuestions`
  and `taskQuestionsWithoutModel` in `packages/core/src/judging/questions.ts`.
- **One failure should not lose the others.** `Effect.all` fails fast by
  default. Use `mode: "result"` to keep every run's `Result` and record which
  candidate failed and why; that is part of the comparison.
- **Bound concurrency against rate limits.** `"unbounded"` suits a handful of
  candidates. Many targets times many models goes through `Effect.forEach`
  with a number, as the `Judge` does with `CONCURRENT_REQUESTS`
  (`packages/cli/src/judge.ts`), and retries rate limits with the provider's
  delay.
- **Record both the name you asked for and the model that answered.**
  `Model.ModelName` and `Model.ProviderName` (unstable API) come with every
  `*.model(name)` layer, but they hold the name given to the layer. The model
  that ran is the `modelId` of the response's `response-metadata` part, and
  `DecisionModel.decide` returns `modelId` too. An alias can resolve to a
  versioned model, so keep both.
- **The judge sees only its input.** It does not inherit the candidates'
  prompts. Put what the candidates were asked (the PRD here) in the decision's
  input beside their answers, or it can only compare the answers with each
  other.
- **Providers do not share thresholds.** A probability from one judge and a
  score from another mean different things; keep each provider's thresholds in
  config and never copy them across (`prd.judging-the-plan`). A low-confidence
  answer is `unsure` and changes nothing. Use `decideSettled` when one
  unanswered decision must not lose the rest.
- **Comparisons cost money.** A paid comparison runs only when a person runs it,
  inside a budget checked before each request
  (`spec.judging.comparing-decision-providers`). Agreement between models is
  evidence, not correctness.
- **Keys come from `Config.Redacted` when the layer is built.** No key in
  code, config files or logs. Through Cloudflare AI Gateway, see `withGatewayToken`
  and `typeSafeClient` in `packages/cli/src/models.ts`.
- **Tests never call a provider.** Script each candidate with
  `LanguageModel.make` and the judge with `DecisionModel.make`, give each
  candidate a different reply, and assert that the winner is the reply the
  scripted judge picked. Count calls to show that a failed candidate does not
  stop the others.

## Where Cairn uses it, or should

Checked against `main` at `56fd882` on 2026-11-26. `pnpm tasks <id>` shows a
task's current state.

### Written

| Where | What it does | How it stands against the pattern |
| --- | --- | --- |
| `packages/cli/src/models.ts` (`apiModel`, `languageModelFor`, `decisionModel`) | Builds a `LanguageModel` layer per provider (`anthropic`, `openai`, `openrouter`, `openai-compatible`, or the Claude or Codex CLI) and the TypeSafe `DecisionModel` layer from config. | Step 1: models as layers for one service. Builds one candidate at a time. |
| `packages/cli/src/planner.ts:629` (`Planner.layerWith`) | Yields `LanguageModel` when the layer is built and re-provides it on every call. | The lookup is hoisted, so one `Planner` is one model. To compare planners, provide one `Planner` layer per candidate. |
| `packages/cli/src/judge.ts:286` (`Judge.layerWith`) | The same for `DecisionModel`. | One `Judge` is one decision provider. |
| `packages/core/src/judging/questions.ts` (`taskQuestions`) | `Decision.classify` whose criteria are the model names in `judge.models`. | Step 3: the judge picks a label that is a model name. Here it routes a task to a model, rather than picking a winning answer. |
| `packages/cli/src/commands/plan.ts` (`dryRun`, t114) | `cairn plan --dry-run --source --provider --model` plans in memory with one planner and prints a totals line. | Comparing planners (`prd.planning.comparing`) is two runs by hand and a person reading two lines. |

### Gap in written code

- **`planner.small` never reaches the planner** (`prd.planning.writers`,
  `spec.models`). `languageModelFor(config, call)` picks `planner.small` for
  `index`, `splitSection` and `splitTask`, but its only caller is
  `languageModel(config)`, which asks for `"spec"`. `plan.ts` provides that one
  layer to `Planner.layerWith`, which closes over it, so the small calls run on
  `planner.model`. The fix is this pattern: write each call once, and provide
  `languageModelFor(config, call)` per call instead of one model per service.
  Open pull request #218 (`cairn/plan-small-calls`) fixes it with a second,
  optional `SmallLanguageModel` service that the plan command provides when
  `planner.small` is set.

### In the PRD and spec, not built yet

| Task | Spec section | What the pattern gives it |
| --- | --- | --- |
| t146 Add the OpenAI Decisions layer | `spec.judging.openai-decisions` | A second `DecisionModel` layer built with `DecisionModel.make`. `Judge.layerWith` takes it unchanged: the judge's provider is the layer provided. |
| t147 Compare decision providers within a budget | `spec.judging.comparing-decision-providers` | `cairn judge --compare` is this pattern with decision models: the same `requestsOf` requests to `{ typesafe, openai }` through `Effect.all` with `mode: "result"`, one row per answer, disagreement computed from the typed labels. Run the requests one at a time under the budget check, not unbounded. |
| t143, t145 Model catalog and routing | `spec.judging.model-catalog` | The catalog grows past Anthropic models. `taskQuestions` is already the classify step; the catalog only changes its criteria. |
| t150 Rank models from history | `spec.judging.routing-from-history` | Shadow mode keeps the judge's choice beside the history's. Not model fan-out: the ranking is arithmetic over recorded attempts. |

### Beyond the PRD, would need a PRD change first

- **`cairn plan --dry-run --compare a,b`.** Plan the same PRD with several
  planners at once and print one totals line each, instead of one run per
  planner. With a judge set, `stackQuestions` and `sectionQuestions` could
  score each candidate plan. `prd.planning.comparing` asks only for two runs
  and a person comparing the totals.
- **Second-model review.** `prd.viewer.notes` has the second-model review of
  each pull request write review notes, and `AGENTS.md` runs it by hand with
  `codex review`. `cli-model.ts` already makes the Claude and Codex CLIs
  `LanguageModel` layers, so a review effect written once could run on both and
  merge their findings. The PRD names one second model, not several.
