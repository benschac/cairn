import { PrdSectionId, TraceJudgment, Verdict, type JudgmentTarget } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Order, Schema, Struct } from "effect";
import { expect, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { TraceData } from "../src/model.ts";
import { cardsOf } from "../src/reader.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, mounted } from "./fixtures.ts";

const judgment = (verdict: Verdict, stale: boolean, target: typeof JudgmentTarget.Encoded) =>
  Schema.decodeSync(TraceJudgment)({
    action: "none",
    answer: { probability: 0.5 },
    at: "2026-01-01T00:00:00.000Z",
    inputHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "m",
    question: "size",
    round: 1,
    stale,
    target,
    verdict,
  });

/** The PRD section whose cards list the most tasks, so six of them each get a verdict. */
const prdId = Option.getOrThrow(
  Array.head(
    Array.sort(
      Array.map(demoTrace.prd.sections, (section) => PrdSectionId.make(section.id)),
      Order.mapInput(Order.flip(Order.Number), (id: PrdSectionId) =>
        Array.length(Array.flatMap(cardsOf(demoTrace, id).cards, (card) => card.tasks)),
      ),
    ),
  ),
);
const { cards } = cardsOf(demoTrace, prdId);

interface Row {
  readonly card: string;
  readonly id: string;
}

const mark = (card: string, id: string) =>
  selector(`[data-task-row="${card}:${id}"] [data-judgment]`);

it("a flag or unsure judgment marks its task and section, dimmed when stale; a pass does not", () => {
  // Each task of the cards is listed under the first card that holds it.
  const rows = Array.dedupeWith(
    Array.flatMap(cards, (card) =>
      Array.map(card.tasks, (task): Row => ({ card: card.section.id, id: task.id })),
    ),
    (self: Row, that: Row) => self.id === that.id,
  );
  // Every verdict and staleness, each on its own task.
  const cases = Array.zipWith(
    rows,
    Array.cartesian(Verdict.literals, [false, true]),
    (row, [verdict, stale]) => ({ ...row, stale, verdict }),
  );
  assert(cases).toHaveLength(6);
  const specId = Option.getOrThrow(Array.head(cards)).section.id;
  const trace = Struct.evolve(demoTrace, {
    judgments: () =>
      Array.append(
        Array.map(cases, ({ id, stale, verdict }) =>
          judgment(verdict, stale, { id, kind: "task" }),
        ),
        judgment("flag", true, { id: specId, kind: "section" }),
      ),
  });
  scene(
    { update, view },
    given(
      modifyFields(loaded, {
        reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(prdId) }),
        trace: () => TraceData.Success({ data: trace }),
      }),
    ),
    mounted,
    ...Array.flatMap(cases, ({ card, id, stale, verdict }) =>
      verdict === "pass"
        ? [expect(mark(card, id)).toBeAbsent()]
        : [
            expect(mark(card, id)).toHaveAttr("data-judgment", verdict),
            expect(mark(card, id)).toHaveAttr("data-stale", String(stale)),
            // Staleness is in the text too, not only in the opacity.
            expect(mark(card, id)).toHaveText(stale ? `${verdict} (stale)` : verdict),
          ],
    ),
    expect(selector(`[data-spec="${specId}"] [data-judgment="flag"]`)).toHaveAttr(
      "data-stale",
      "true",
    ),
  );
});
