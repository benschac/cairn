import { PrdSectionId, SpecIndex, SpecSectionId, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Option, Order, Result, Schema, String } from "effect";

import {
  derivedOf,
  itemsOf,
  partOf,
  refusalOf,
  replanOf,
  scopeOf,
  sectionsOf,
} from "../src/index.ts";
import type { Part, Replan } from "../src/index.ts";

/**
 * A PRD as a run of headings and list items. Node `k` is `prd.n<k>` when it has an ID. An item
 * right after a heading starts a list at indent 0, and an item is indented at most one level
 * deeper than the item before it, so the markdown nests as generated.
 */
const TreeNode = Schema.TaggedUnion({
  heading: { id: Schema.Boolean, level: Schema.Literals([1, 2, 3]) },
  item: { id: Schema.Boolean, indent: Schema.Literals([0, 2, 4]) },
});
type TreeNode = typeof TreeNode.Type;

const Tree = Schema.Array(TreeNode).check(Schema.isMaxLength(14));

const Pick = Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 0 }));

const nodeId = (index: number) => `prd.n${index}`;

/** A node of the tree as the oracle reads it: its ID, if any, and the IDs above it. */
interface Expected {
  readonly above: ReadonlyArray<string>;
  readonly id: Option.Option<string>;
  readonly item: boolean;
  readonly text: ReadonlyArray<string>;
}

interface Open {
  readonly depth: number;
  readonly id: Option.Option<string>;
}

interface State {
  readonly headings: ReadonlyArray<Open>;
  readonly items: ReadonlyArray<Open>;
  readonly previous: Option.Option<number>;
}

const idsOf = (opens: ReadonlyArray<Open>) => Array.getSomes(Array.map(opens, ({ id }) => id));

const START: State = { headings: [], items: [], previous: Option.none() };

/** The tree's markdown and, for each node, the headings and items it sits under. */
const expectedOf = (tree: ReadonlyArray<TreeNode>): ReadonlyArray<Expected> =>
  Array.mapAccum(tree, START, (state, node, index): [State, Expected] => {
    const id = node.id ? Option.some(nodeId(index)) : Option.none<string>();
    const tail = Option.match(id, { onNone: () => "", onSome: (found) => ` {#${found}}` });
    return TreeNode.match(node, {
      heading: ({ level }): [State, Expected] => {
        const above = Array.filter(state.headings, ({ depth }) => depth < level);
        return [
          {
            headings: Array.append(above, { depth: level, id }),
            items: [],
            previous: Option.none(),
          },
          {
            above: idsOf(above),
            id,
            item: false,
            text: ["", `${String.repeat(level)("#")} Heading ${index}${tail}`, ""],
          },
        ];
      },
      item: ({ indent }): [State, Expected] => {
        const depth = Option.match(state.previous, {
          onNone: () => 0,
          onSome: (previous) => Order.min(Order.Number)(indent, previous + 2),
        });
        const above = Array.filter(state.items, (open) => open.depth < depth);
        return [
          {
            headings: state.headings,
            items: Array.append(above, { depth, id }),
            previous: Option.some(depth),
          },
          {
            above: Array.appendAll(idsOf(state.headings), idsOf(above)),
            id,
            item: true,
            text: [`${String.repeat(depth)(" ")}- Item ${index}${tail}`],
          },
        ];
      },
    });
  })[1];

const markdownOf = (expected: ReadonlyArray<Expected>) =>
  Array.join(
    Array.flatMap(expected, ({ text }) => text),
    "\n",
  );

/** The IDs of the tree, in document order. */
const treeIdsOf = (expected: ReadonlyArray<Expected>) =>
  Array.getSomes(Array.map(expected, ({ id }) => id));

const pickIds = (ids: ReadonlyArray<string>, picks: ReadonlyArray<number>) =>
  Array.match(ids, {
    onEmpty: () => [],
    onNonEmpty: (some) =>
      Array.getSomes(Array.map(picks, (pick) => Array.get(some, pick % Array.length(some)))),
  });

const partFor = (markdown: string, ids: ReadonlyArray<string>): Part => {
  const sections = sectionsOf(markdown);
  return Result.getOrThrow(partOf(sections, itemsOf(markdown, sections), ids));
};

const sorted = (ids: HashSet.HashSet<string>) => Array.sort(Array.fromIterable(ids), Order.String);

/** The oracle's part: the named IDs and every ID whose node sits under one, sorted. */
const underOf = (expected: ReadonlyArray<Expected>, named: ReadonlyArray<string>) =>
  Array.sort(
    Array.filterMap(expected, ({ above, id }) =>
      Option.match(id, {
        onNone: () => Result.failVoid,
        onSome: (found) =>
          Array.contains(named, found) || Array.some(above, (up) => Array.contains(named, up))
            ? Result.succeed(found)
            : Result.failVoid,
      }),
    ),
    Order.String,
  );

it.prop(
  "partOf holds every named ID and everything under it, and nothing else",
  { picks: Schema.Array(Pick), tree: Tree },
  ({ picks, tree }) => {
    const expected = expectedOf(tree);
    const markdown = markdownOf(expected);
    const named = pickIds(treeIdsOf(expected), picks);
    const part = partFor(markdown, named);
    expect(sorted(part.ids)).toEqual(underOf(expected, named));
    Array.forEach(treeIdsOf(expected), (id) => {
      expect(sorted(partFor(markdown, [id]).ids)).toEqual(underOf(expected, [id]));
    });
    expect(part.named).toEqual(
      Array.filter(treeIdsOf(expected), (id) => Array.contains(named, id)),
    );
    expect(partFor(markdownOf(expected), Array.reverse(named))).toEqual(part);
  },
);

it.prop(
  "a named item never brings in its section or that section's other items",
  { pick: Pick, tree: Tree },
  ({ pick, tree }) => {
    const expected = expectedOf(tree);
    const items = Array.getSomes(
      Array.map(
        Array.filter(expected, ({ item }) => item),
        ({ id }) => id,
      ),
    );
    Option.match(Array.head(pickIds(items, [pick])), {
      onNone: () => undefined,
      onSome: (item) => {
        const ids = Array.fromIterable(partFor(markdownOf(expected), [item]).ids);
        const inside = Array.filter(
          expected,
          ({ above, id }) =>
            Option.exists(id, (found) => found === item) || Array.contains(above, item),
        );
        expect(
          Array.every(ids, (id) => Array.some(inside, (node) => Option.contains(node.id, id))),
        ).toBe(true);
        expect(
          Array.some(ids, (id) =>
            Array.some(expected, (node) => !node.item && Option.contains(node.id, id)),
          ),
        ).toBe(false);
      },
    });
  },
);

it.prop(
  "naming a section and something under it gives the same part as naming the section alone",
  { below: Pick, pick: Pick, tree: Tree },
  ({ below, pick, tree }) => {
    const expected = expectedOf(tree);
    const headings = Array.getSomes(
      Array.map(
        Array.filter(expected, ({ item }) => !item),
        ({ id }) => id,
      ),
    );
    Option.match(Array.head(pickIds(headings, [pick])), {
      onNone: () => undefined,
      onSome: (heading) => {
        const under = Array.getSomes(
          Array.map(
            Array.filter(expected, ({ above }) => Array.contains(above, heading)),
            ({ id }) => id,
          ),
        );
        const markdown = markdownOf(expected);
        expect(partFor(markdown, Array.appendAll([heading], pickIds(under, [below]))).ids).toEqual(
          partFor(markdown, [heading]).ids,
        );
      },
    });
  },
);

const doc = (...lines: ReadonlyArray<string>) => Array.join(lines, "\n");

const PRD = doc(
  "# Product {#prd.product}",
  "",
  "## CLI {#prd.cli}",
  "",
  "- Lint {#prd.cli.lint}",
  "  - Warnings {#prd.cli.lint.warnings}",
  "- Plan {#prd.cli.plan}",
  "",
  "Done when:",
  "",
  "- Running cairn lint prints nothing. {#prd.cli.lint#v1}",
  "",
  "## Untitled",
  "",
  "- Under no ID {#prd.loose}",
  "",
  "### Deep links {#prd.deep-links}",
  "",
  "Text.",
);

const partOfPrd = (ids: ReadonlyArray<string>) => {
  const sections = sectionsOf(PRD);
  return partOf(sections, itemsOf(PRD, sections), ids);
};

it("naming the level 1 heading gives the whole PRD", () => {
  const part = Result.getOrThrow(partOfPrd(["prd.product"]));
  expect(part.named).toEqual(["prd.product"]);
  expect(sorted(part.ids)).toEqual(
    Array.sort(
      [
        "prd.product",
        "prd.cli",
        "prd.cli.lint",
        "prd.cli.lint.warnings",
        "prd.cli.plan",
        "prd.loose",
        "prd.deep-links",
      ],
      Order.String,
    ),
  );
});

it("a named item brings its nested items, and an item under a heading with no ID sits under the headings above", () => {
  expect(sorted(Result.getOrThrow(partOfPrd(["prd.cli.lint"])).ids)).toEqual([
    "prd.cli.lint",
    "prd.cli.lint.warnings",
  ]);
  expect(
    Result.getOrThrow(partOfPrd(["prd.cli.plan", "prd.cli.lint", "prd.cli.plan"])).named,
  ).toEqual(["prd.cli.lint", "prd.cli.plan"]);
  expect(
    HashSet.has(Result.getOrThrow(partOfPrd(["prd.product"])).ids, PrdSectionId.make("prd.loose")),
  ).toBe(true);
});

it("unknown IDs are all refused, each once, in the order given, with the line cairn plan prints", () => {
  const refused = partOfPrd([
    "prd.deep-link",
    "prd.cli",
    "spec.viewer.reader",
    "prd.cli.lint#v1",
    "prd.deep-link",
  ]);
  expect(refused).toEqual(
    Result.fail({
      unknown: [
        { id: "prd.deep-link", reason: "no-such-id" },
        { id: "spec.viewer.reader", reason: "spec-id" },
        { id: "prd.cli.lint#v1", reason: "statement-id" },
      ],
    }),
  );
  expect(
    Result.match(refused, {
      onFailure: ({ unknown }) => Array.map(unknown, refusalOf),
      onSuccess: () => [],
    }),
  ).toEqual([
    "Unknown PRD ID prd.deep-link: no heading or list item in .cairn/prd.md has it.",
    "spec.viewer.reader is a spec section. cairn plan <id> takes PRD headings and list items.",
    "prd.cli.lint#v1 is a done-when statement. Name its section, prd.cli.lint.",
  ]);
});

/**
 * A plan for `scopeOf`: PRD sections `prd.s0` to `prd.s<n-1>`, and spec sections `spec.p<j>`
 * that implement some of them. A nested spec section sits under the level-2 section before it and
 * inherits what it implements. Each spec section is rewritable, stale or neither in the whole-plan
 * replan, and may be untasked; the part holds the picked PRD sections.
 */
const Plan = Schema.Struct({
  part: Schema.Array(Pick),
  prd: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
  spec: Schema.Array(
    Schema.Struct({
      implements: Schema.Array(Pick).check(Schema.isMaxLength(3)),
      nested: Schema.Boolean,
      state: Schema.Literals(["rewritable", "stale", "current"]),
      untasked: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  staleTasks: Schema.Array(Schema.Literals(["t1", "t2", "t3"])),
  uncovered: Schema.Array(Pick),
});
type Plan = typeof Plan.Type;

const prdId = (plan: Plan, pick: number) => PrdSectionId.make(`prd.s${pick % plan.prd}`);
const specId = (index: number) => SpecSectionId.make(`spec.p${index}`);

/** The level-2 spec section a nested one sits under. */
const parentOf = (plan: Plan, index: number): Option.Option<number> =>
  Option.filter(
    Option.some(index),
    (at) => at > 0 && Option.exists(Array.get(plan.spec, at), (part) => part.nested),
  ).pipe(
    Option.flatMap(() =>
      Array.findLastIndex(Array.take(plan.spec, index), (part, at) => at === 0 || !part.nested),
    ),
  );

const ownOf = (plan: Plan, index: number): ReadonlyArray<PrdSectionId> =>
  Option.match(Array.get(plan.spec, index), {
    onNone: () => [],
    onSome: (part) => Array.dedupe(Array.map(part.implements, (pick) => prdId(plan, pick))),
  });

/** What spec section `index` implements, its own and its parent's. */
const implementedBy = (plan: Plan, index: number): ReadonlyArray<PrdSectionId> =>
  Array.dedupe(
    Array.appendAll(
      Option.match(parentOf(plan, index), {
        onNone: () => [],
        onSome: (parent) => ownOf(plan, parent),
      }),
      ownOf(plan, index),
    ),
  );

const decodeIndex = Schema.decodeUnknownSync(SpecIndex);

const planIndexOf = (plan: Plan): SpecIndex =>
  decodeIndex({
    manifest: ".cairn/manifest.json",
    prd: ".cairn/prd.md",
    sections: Array.map(plan.spec, (part, index) => ({
      artifacts: [],
      children: [],
      context: [],
      decisions: [],
      defers: [],
      dependsOn: [],
      files: [],
      human: false,
      id: specId(index),
      implements: ownOf(plan, index),
      level: Option.isSome(parentOf(plan, index)) ? 3 : 2,
      line: index + 1,
      parent: Option.getOrNull(Option.map(parentOf(plan, index), specId)),
      requirements: [],
      summary: "",
      tasks: [],
      tests: [],
      title: `Part ${index}`,
      writtenFrom: { body: null, prd: {} },
    })),
    source: ".cairn/spec.md",
    version: 1,
  });

const sectionsWhere = (plan: Plan, keep: (part: Plan["spec"][number]) => boolean) =>
  Array.filterMap(plan.spec, (part, index) =>
    keep(part) ? Result.succeed(specId(index)) : Result.failVoid,
  );

const wholeOf = (plan: Plan): Replan => ({
  rewritable: sectionsWhere(plan, ({ state }) => state === "rewritable"),
  staleSections: sectionsWhere(plan, ({ state }) => state === "stale"),
  staleTasks: Array.map(Array.dedupe(plan.staleTasks), (id) => TaskId.make(id)),
  uncovered: Array.dedupe(Array.map(plan.uncovered, (pick) => prdId(plan, pick))),
  unmappedItems: [],
  untasked: sectionsWhere(plan, ({ untasked }) => untasked),
});

const planPartOf = (plan: Plan): Part => {
  const ids = Array.dedupe(Array.map(plan.part, (pick) => prdId(plan, pick)));
  return { ids: HashSet.fromIterable(ids), named: ids };
};

const scopedOf = (plan: Plan) => scopeOf(wholeOf(plan), planPartOf(plan), planIndexOf(plan));

/** `scoped` is `whole` with some of its entries left out, in the same order. */
const isNarrowed = <A>(scoped: ReadonlyArray<A>, whole: ReadonlyArray<A>) =>
  Array.filter(whole, (id) => Array.contains(scoped, id));

it.prop(
  "every field but the stale ones is a subset of the same field without a part",
  [Plan],
  ([plan]) => {
    const whole = wholeOf(plan);
    const scoped = scopedOf(plan);
    expect(isNarrowed(scoped.uncovered, whole.uncovered)).toEqual(scoped.uncovered);
    expect(isNarrowed(scoped.rewritable, whole.rewritable)).toEqual(scoped.rewritable);
    expect(isNarrowed(scoped.untasked, whole.untasked)).toEqual(scoped.untasked);
  },
);

it.prop(
  "staleSections and staleTasks keep the whole plan's, and staleSections gains only rewritable sections that reach outside the part",
  [Plan],
  ([plan]) => {
    const whole = wholeOf(plan);
    const scoped = scopedOf(plan);
    const part = planPartOf(plan);
    const reachesOut = (id: SpecSectionId) =>
      Option.exists(
        Array.findFirstIndex(plan.spec, (_, index) => specId(index) === id),
        (index) => {
          const implemented = implementedBy(plan, index);
          return (
            Array.some(implemented, (prd) => HashSet.has(part.ids, prd)) &&
            Array.some(implemented, (prd) => !HashSet.has(part.ids, prd))
          );
        },
      );
    expect(scoped.staleTasks).toEqual(whole.staleTasks);
    expect(
      Array.filter(
        Array.map(plan.spec, (_, index) => specId(index)),
        (id) =>
          Array.contains(whole.staleSections, id) ||
          (Array.contains(whole.rewritable, id) && reachesOut(id)),
      ),
    ).toEqual(scoped.staleSections);
  },
);

it.prop(
  "a section that implements anything outside the part is never in rewritable",
  [Plan],
  ([plan]) => {
    const part = planPartOf(plan);
    const outside = Array.filterMap(plan.spec, (_, index) =>
      Array.some(implementedBy(plan, index), (prd) => !HashSet.has(part.ids, prd))
        ? Result.succeed(specId(index))
        : Result.failVoid,
    );
    expect(Array.intersection(scopedOf(plan).rewritable, outside)).toEqual([]);
  },
);

it.prop("scopeOf keeps exactly what the part reaches", [Plan], ([plan]) => {
  const whole = wholeOf(plan);
  const part = planPartOf(plan);
  const inPart = (prd: PrdSectionId) => HashSet.has(part.ids, prd);
  const keep = (rule: (implemented: ReadonlyArray<PrdSectionId>) => boolean) =>
    Array.filterMap(plan.spec, (_, index) =>
      rule(implementedBy(plan, index)) ? Result.succeed(specId(index)) : Result.failVoid,
    );
  const scoped = scopedOf(plan);
  expect(scoped.uncovered).toEqual(Array.filter(whole.uncovered, inPart));
  expect(scoped.rewritable).toEqual(
    Array.intersection(
      whole.rewritable,
      keep((implemented) => Array.some(implemented, inPart) && Array.every(implemented, inPart)),
    ),
  );
  expect(scoped.untasked).toEqual(
    Array.intersection(
      whole.untasked,
      keep((implemented) => Array.some(implemented, inPart)),
    ),
  );
});

it("a part run of a changed PRD rewrites only its own sections and reports the one it shares", () => {
  const before = doc(
    "# Product {#prd.product}",
    "",
    "## A {#prd.a}",
    "",
    "Text of a.",
    "",
    "## B {#prd.b}",
    "",
    "Text of b.",
    "",
    "- Share a view {#prd.b.share}",
    "",
    "## C {#prd.c}",
    "",
    "Text of c.",
  );
  const after = String.replace(
    "Text of b.",
    "Text of b, changed.",
  )(String.replace("Text of a.", "Text of a, changed.")(before));
  const spec = doc(
    "# Spec {#spec.spec}",
    "",
    "## A {#spec.a}",
    "",
    "- Implements: `prd.a`",
    "- Files: `src/a.ts`",
    "",
    "## B {#spec.b}",
    "",
    "- Implements: `prd.b`",
    "- Files: `src/b.ts`",
    "",
    "### B more {#spec.b.more}",
    "",
    "- Files: `src/b-more.ts`",
    "",
    "## Both {#spec.both}",
    "",
    "- Implements: `prd.a`, `prd.b`",
  );
  const ids = Array.map(["spec.spec", "spec.a", "spec.b", "spec.b.more", "spec.both"], (id) =>
    SpecSectionId.make(id),
  );
  const index = decodeIndex({
    manifest: ".cairn/manifest.json",
    prd: ".cairn/prd.md",
    sections: Array.map(
      derivedOf({
        manifest: { tasks: [] },
        prd: before,
        previous: Option.none(),
        spec,
        written: ids,
      }),
      (entry) => ({
        ...entry,
        artifacts: [],
        decisions: [],
        requirements: [],
        summary: "",
        tests: [],
      }),
    ),
    source: ".cairn/spec.md",
    version: 1,
  });
  const whole = replanOf(after, spec, index, Option.none());
  expect(whole).toEqual({
    rewritable: ["spec.a", "spec.b", "spec.both"],
    staleSections: [],
    staleTasks: [],
    uncovered: ["prd.c"],
    unmappedItems: [{ candidates: ["spec.b", "spec.both"], item: "prd.b.share" }],
    untasked: ["spec.a", "spec.b", "spec.b.more"],
  });
  const sections = sectionsOf(after);
  const items = itemsOf(after, sections);
  const scope = (named: ReadonlyArray<string>) =>
    scopeOf(whole, Result.getOrThrow(partOf(sections, items, named)), index);
  expect(scope(["prd.b"])).toEqual({
    rewritable: ["spec.b"],
    staleSections: ["spec.both"],
    staleTasks: [],
    uncovered: [],
    unmappedItems: [{ candidates: ["spec.b", "spec.both"], item: "prd.b.share" }],
    untasked: ["spec.b", "spec.b.more"],
  });
  expect(scope(["prd.c"])).toEqual({
    rewritable: [],
    staleSections: [],
    staleTasks: [],
    uncovered: ["prd.c"],
    unmappedItems: [],
    untasked: [],
  });
  expect(scope(["prd.b.share"])).toEqual({
    rewritable: [],
    staleSections: [],
    staleTasks: [],
    uncovered: [],
    unmappedItems: [{ candidates: ["spec.b", "spec.both"], item: "prd.b.share" }],
    untasked: [],
  });
});
