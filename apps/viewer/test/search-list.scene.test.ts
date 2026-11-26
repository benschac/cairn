import { SectionId, TaskId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { Message } from "../src/message.ts";
import { searchTrace } from "../src/search.ts";
import { demoTrace } from "../src/demo.ts";
import { nodeKeyOf, type Node } from "../src/trace.ts";
import { ScrollSearchResult } from "../src/command.ts";
import {
  byRole,
  containing,
  data,
  inside,
  loaded,
  readerMounted,
  resolved,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

const sectionNode = (id: string): Node => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section",
});
const taskNode = (id: string): Node => ({ id: TaskId.make(id), kind: "task" });

const stackOrder = sectionNode("spec.planning.stack-order");
const judgments = sectionNode("spec.contract.judgments");
const t20 = taskNode("t20");

const searchBox = byRole("combobox", { name: "Search sections and tasks" });
const status = data("search-status");
const results = data("search-result");
const option = (node: Node) => data("search-result", nodeKeyOf(node));
const optionId = (node: Node) => `search-option-${nodeKeyOf(node)}`;

/** Typing sends the input's whole text, as the browser's input event does. */
const typed = (query: string) => (s: ViewerSteps) => s.type(searchBox, query);
const pressed = (key: string) => (s: ViewerSteps) => s.keydown(searchBox, key);
/** Moving the active search result scrolls the list to it; the test answers for the scroll. */
const scrolledSearchResult = resolved(ScrollSearchResult, Message.CompletedScrollSearchResult());

it.effect("an abbreviation lists ranked results with their kind, title and matched field", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted)
      .expect(searchBox)
      .toHaveAttribute("aria-expanded", "false")
      .expect(status)
      .toHaveText("")
      .pipe(typed("stkorder"), scrolledSearchResult)
      .expect(searchBox)
      .toHaveAttribute("aria-expanded", "true")
      .expect(status)
      .toHaveText("2 results.")
      .expect(results)
      .toHaveCount(2)
      .expect(byRole("listbox", { name: "Search results" }))
      .toExist()
      .expect(option(stackOrder))
      .toHaveAttribute("role", "option")
      .expect(option(stackOrder))
      .toHaveText(containing("Spec"))
      .expect(option(stackOrder))
      .toHaveText(containing("Stack order"))
      .expect(inside(option(stackOrder), data("search-field")))
      .toHaveText("title")
      .expect(option(t20))
      .toHaveText(containing("Task"))
      .expect(inside(option(t20), data("search-field")))
      .toHaveText("branch: cairn-mvp/20-stack-order");
  }),
);

it.effect("the arrow keys move through the results and stop at the first", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("judgmnt"), scrolledSearchResult)
      .expect(searchBox)
      .toHaveAttribute("aria-activedescendant", optionId(judgments))
      .expect(option(judgments))
      .toHaveAttribute("aria-selected", "true")
      .pipe(pressed("ArrowUp"))
      .expectDefaultPrevented(true)
      .pipe(scrolledSearchResult)
      .expect(option(judgments))
      .toHaveAttribute("aria-selected", "true")
      .pipe(pressed("ArrowDown"))
      .expectDefaultPrevented(true)
      .pipe(scrolledSearchResult)
      .expect(option(judgments))
      .toHaveAttribute("aria-selected", "false");
  }),
);

it.effect("emptying the query clears the list", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("t43"), scrolledSearchResult)
      .expect(results)
      .toExist()
      .pipe(typed(""))
      .expect(results)
      .toHaveCount(0)
      .expect(data("searched"))
      .toHaveCount(0)
      .expect(status)
      .toHaveText("");
  }),
);

it.effect("a query with no matches says so and leaves the reader usable", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("zzzz"))
      .expect(status)
      .toHaveText("No results.")
      .expect(searchBox)
      .toHaveAttribute("aria-expanded", "false")
      .expect(byRole("listbox"))
      .toBeAbsent()
      .pipe(pressed("ArrowDown"))
      .expectDefaultPrevented(true)
      .pipe(pressed("Enter"))
      .expectDefaultPrevented(true)
      .expect(byRole("region", { name: "PRD" }))
      .toExist();
  }),
);

it.effect("Escape clears the search", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("stkorder"), scrolledSearchResult, pressed("Escape"))
      .expectDefaultPrevented(true)
      .expect(searchBox)
      .toHaveValue("")
      .expect(status)
      .toHaveText("")
      .expect(results)
      .toHaveCount(0)
      .expect(data("search-match"))
      .toHaveCount(0);
  }),
);

it.effect("keys other than the arrows, Enter and Escape are left to the input", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("t43"), scrolledSearchResult, pressed("a"))
      .expectIgnored()
      .pipe(pressed("Tab"))
      .expectIgnored()
      .expect(searchBox)
      .toHaveAttribute("aria-expanded", "true");
  }),
);

it.effect("a typo finds the section it aimed at", () =>
  Effect.gen(function* () {
    const found = searchTrace(demoTrace, "judgmnt");
    const s = yield* viewerScene(loaded);
    s.pipe(readerMounted, typed("judgmnt"), scrolledSearchResult)
      .expect(status)
      .toHaveText(`${found.length} results.`);
  }),
);
