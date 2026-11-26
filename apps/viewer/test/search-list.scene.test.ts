import { SectionId, TaskId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Schema } from "effect";
import {
  all,
  expect,
  expectAll,
  expectHandled,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
} from "foldkit/scene";
import * as simulate from "foldkit/scene";

import { searchTrace } from "../src/search.ts";
import { demoTrace } from "../src/demo.ts";
import { nodeKeyOf, type Node } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, mounted, scrolledSearchResult } from "./fixtures.ts";

const sectionNode = (id: string): Node => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section",
});
const taskNode = (id: string): Node => ({ id: TaskId.make(id), kind: "task" });

const stackOrder = sectionNode("spec.planning.stack-order");
const judgments = sectionNode("spec.contract.judgments");
const t20 = taskNode("t20");

const searchBox = role("combobox", { name: "Search sections and tasks" });
const status = selector("[data-search-status]");
const option = (node: Node) => selector(`[data-search-result="${nodeKeyOf(node)}"]`);
const optionId = (node: Node) => `search-option-${nodeKeyOf(node)}`;

/** Typing sends the input's whole text, as the browser's input event does. */
const typed = (query: string) => simulate.type(searchBox, query);
const pressed = (key: string) => keydown(searchBox, key);

it("an abbreviation lists ranked results with their kind, title and matched field", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(searchBox).toHaveAttr("aria-expanded", "false"),
    expect(status).toHaveText(""),
    typed("stkorder"),
    scrolledSearchResult,
    expect(searchBox).toHaveAttr("aria-expanded", "true"),
    expect(status).toHaveText("2 results."),
    expectAll(all.selector("[data-search-result]")).toHaveCount(2),
    expect(role("listbox", { name: "Search results" })).toExist(),
    expect(option(stackOrder)).toHaveAttr("role", "option"),
    expect(option(stackOrder)).toContainText("Spec"),
    expect(option(stackOrder)).toContainText("Stack order"),
    expect(simulate.within(option(stackOrder), selector("[data-search-field]"))).toHaveText(
      "title",
    ),
    expect(option(t20)).toContainText("Task"),
    expect(simulate.within(option(t20), selector("[data-search-field]"))).toHaveText(
      "branch: cairn-mvp/20-stack-order",
    ),
  );
});

it("the arrow keys move through the results and stop at the first", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    expect(searchBox).toHaveAttr("aria-activedescendant", optionId(judgments)),
    expect(option(judgments)).toHaveAttr("aria-selected", "true"),
    pressed("ArrowUp"),
    expectHandled(),
    scrolledSearchResult,
    expect(option(judgments)).toHaveAttr("aria-selected", "true"),
    pressed("ArrowDown"),
    expectHandled(),
    scrolledSearchResult,
    expect(option(judgments)).toHaveAttr("aria-selected", "false"),
  );
});

it("emptying the query clears the list", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("t43"),
    scrolledSearchResult,
    expectAll(all.selector("[data-search-result]")).not.toBeEmpty(),
    typed(""),
    expectAll(all.selector("[data-search-result]")).toBeEmpty(),
    expectAll(all.selector("[data-searched]")).toBeEmpty(),
    expect(status).toHaveText(""),
  );
});

it("a query with no matches says so and leaves the reader usable", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("zzzz"),
    expect(status).toHaveText("No results."),
    expect(searchBox).toHaveAttr("aria-expanded", "false"),
    expect(role("listbox")).toBeAbsent(),
    pressed("ArrowDown"),
    expectHandled(),
    pressed("Enter"),
    expectHandled(),
    expect(role("region", { name: "PRD" })).toExist(),
  );
});

it("Escape clears the search", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("stkorder"),
    scrolledSearchResult,
    pressed("Escape"),
    expectHandled(),
    expect(searchBox).toHaveValue(""),
    expect(status).toHaveText(""),
    expectAll(all.selector("[data-search-result]")).toBeEmpty(),
    expectAll(all.selector("[data-search-match]")).toBeEmpty(),
  );
});

it("keys other than the arrows, Enter and Escape are left to the input", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("t43"),
    scrolledSearchResult,
    pressed("a"),
    expectIgnored(),
    pressed("Tab"),
    expectIgnored(),
    expect(searchBox).toHaveAttr("aria-expanded", "true"),
  );
});

it("a typo finds the section it aimed at", () => {
  const found = searchTrace(demoTrace, "judgmnt");
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    expect(status).toHaveText(`${found.length} results.`),
  );
});
