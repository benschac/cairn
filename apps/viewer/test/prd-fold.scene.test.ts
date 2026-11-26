import { UiStruct } from "@effect/ui";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect } from "effect";

import { SectionId } from "@cairn/contract";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { isOpenPrdSection } from "../src/reader.ts";
import { update } from "../src/update.ts";
import { data, inside, loaded, readerMounted, viewerScene } from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });

/** The PRD's sections under its title: each one has a heading in the pane. */
const BODY = Array.filter(demoTrace.prd.sections, (section) => section.level > 1);
const COUNT = Array.length(BODY);
const SECTION = "prd.goal";

const condense = data("prd-condense");
const fold = (id: string) => data("prd-fold", id);
const section = (id: string) => data("prd-sec", id);
const prose = (id: string) => data("prd-prose", id);
const headings = inside(data("prd-pane"), data("prd-fold"));
const proses = data("prd-prose");

it.effect(
  "the PRD opens with every section's prose, and Collapse all leaves only the headings",
  () =>
    Effect.gen(function* () {
      assert(COUNT).toBeGreaterThan(1);
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(proses)
        .toHaveCount(COUNT)
        .expect(condense)
        .toHaveText("Collapse all")
        .click(condense)
        .expect(proses)
        .toHaveCount(0)
        .expect(headings)
        .toHaveCount(COUNT)
        .expect(fold(SECTION))
        .toHaveAttribute("aria-expanded", "false")
        .expect(condense)
        .toHaveText("Expand all")
        .click(condense)
        .expect(proses)
        .toHaveCount(COUNT)
        .expect(fold(SECTION))
        .toHaveAttribute("aria-expanded", "true");
    }),
);

it.effect("a heading opens or closes its section alone, and the toggle for all forgets it", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(fold(SECTION))
      .expect(prose(SECTION))
      .toBeAbsent()
      .expect(section(SECTION))
      .toHaveAttribute("data-open", "false")
      .expect(proses)
      .toHaveCount(COUNT - 1)
      .click(fold(SECTION))
      .expect(prose(SECTION))
      .toExist()
      .click(condense)
      .click(fold(SECTION))
      .expect(prose(SECTION))
      .toExist()
      .expect(proses)
      .toHaveCount(1)
      .click(condense)
      .click(condense)
      .expect(proses)
      .toHaveCount(0);
  }),
);

it("a heading's click flips what its section shows, whatever the toggle for all says", () => {
  const id = SectionId.make(SECTION);
  Array.forEach([false, true], (isPrdCondensed) => {
    const before = UiStruct.evolve(reading, {
      reader: (reader) => UiStruct.evolve(reader, { isPrdCondensed: () => isPrdCondensed }),
    });
    const after = update(before, Message.ClickedPrdHeading({ id })).model;
    assert(isOpenPrdSection(after.reader, id)).toBe(!isOpenPrdSection(before.reader, id));
    const back = update(after, Message.ClickedPrdHeading({ id })).model;
    assert(isOpenPrdSection(back.reader, id)).toBe(isOpenPrdSection(before.reader, id));
  });
});
