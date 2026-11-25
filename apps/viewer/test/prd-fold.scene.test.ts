import { expect as assert, it } from "@effect/vitest";
import { Array, Option } from "effect";
import { Mount, all, click, expect, expectAll, given, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { PrdSectionId, SectionId } from "@cairn/contract";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { isOpenPrdSection } from "../src/reader.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { loaded, unmeasuredWires } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

const mounted = Mount.resolveAll(
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

/** The PRD's sections under its title: each one has a heading in the pane. */
const BODY = Array.filter(demoTrace.prd.sections, (section) => section.level > 1);
const COUNT = Array.length(BODY);
const SECTION = "prd.goal";

const condense = selector("[data-prd-condense]");
const fold = (id: string) => selector(`[data-prd-fold="${id}"]`);
const section = (id: string) => selector(`[data-prd-sec="${id}"]`);
const prose = (id: string) => selector(`[data-prd-prose="${id}"]`);
const headings = all.selector("[data-prd-pane] [data-prd-fold]");
const proses = all.selector("[data-prd-prose]");

it("the PRD opens with every section's prose, and Collapse all leaves only the headings", () => {
  assert(COUNT).toBeGreaterThan(1);
  scene(
    { update, view },
    given(reading),
    mounted,
    expectAll(proses).toHaveCount(COUNT),
    expect(condense).toHaveText("Collapse all"),
    click(condense),
    expectAll(proses).toHaveCount(0),
    expectAll(headings).toHaveCount(COUNT),
    expect(fold(SECTION)).toHaveAttr("aria-expanded", "false"),
    expect(condense).toHaveText("Expand all"),
    click(condense),
    expectAll(proses).toHaveCount(COUNT),
    expect(fold(SECTION)).toHaveAttr("aria-expanded", "true"),
  );
});

it("a heading opens or closes its section alone, and the toggle for all forgets it", () => {
  scene(
    { update, view },
    given(reading),
    mounted,
    click(fold(SECTION)),
    expect(prose(SECTION)).toBeAbsent(),
    expect(section(SECTION)).toHaveAttr("data-open", "false"),
    expectAll(proses).toHaveCount(COUNT - 1),
    click(fold(SECTION)),
    expect(prose(SECTION)).toExist(),
    click(condense),
    click(fold(SECTION)),
    expect(prose(SECTION)).toExist(),
    expectAll(proses).toHaveCount(1),
    click(condense),
    click(condense),
    expectAll(proses).toHaveCount(0),
  );
});

it("a heading's click flips what its section shows, whatever the toggle for all says", () => {
  const id = SectionId.make(SECTION);
  Array.forEach([false, true], (isPrdCondensed) => {
    const before = modifyFields(reading, {
      reader: (reader) => modifyFields(reader, { isPrdCondensed: () => isPrdCondensed }),
    });
    const after = update(before, Message.ClickedPrdHeading({ id })).model;
    assert(isOpenPrdSection(after.reader, id)).toBe(!isOpenPrdSection(before.reader, id));
    const back = update(after, Message.ClickedPrdHeading({ id })).model;
    assert(isOpenPrdSection(back.reader, id)).toBe(isOpenPrdSection(before.reader, id));
  });
});
