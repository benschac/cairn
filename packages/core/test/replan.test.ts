import { Manifest, PrdSectionId, SpecIndex, SpecSectionId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import {
  Array,
  HashSet,
  Number,
  Option,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

import {
  bodyHashOf,
  cosmeticOf,
  derivedOf,
  lint,
  outOfDateOf,
  replanOf,
  sectionsOf,
  withImplements,
} from "../src/index.ts";
import type { Finding, Replan } from "../src/index.ts";

/**
 * A plan as `cairn plan` writes it, before anything changes: PRD section `i` is `prd.s<i>`, and
 * spec section `j` is `spec.p<j>`, which implements `prd.s<j mod n>` and `prd.s<also mod n>`. A
 * nested spec section sits under the level-2 section before it. A last `spec.rest` section gives
 * every PRD section as context, so the plan covers its PRD.
 *
 * Then the PRD and the spec change: a `changed` PRD section gets a new sentence, and an `edited`
 * spec section gets a new sentence from a person. `human` is a section a person wrote, so
 * `writtenFrom.body` is null, and `tasked` is a section a task builds.
 */
const Shape = Schema.Struct({
  prd: Schema.Array(Schema.Struct({ changed: Schema.Boolean })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(5),
  ),
  spec: Schema.Array(
    Schema.Struct({
      also: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
      edited: Schema.Boolean,
      files: Schema.Boolean,
      human: Schema.Boolean,
      nested: Schema.Boolean,
      tasked: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});
type Shape = typeof Shape.Type;
type Part = Shape["spec"][number];

const prdId = (index: number) => `prd.s${index}`;
const specId = (index: number) => `spec.p${index}`;

const implementsOf = (shape: Shape, index: number, part: Part): ReadonlyArray<string> =>
  Array.dedupe([
    prdId(index % Array.length(shape.prd)),
    prdId(part.also % Array.length(shape.prd)),
  ]);

const codeList = (ids: ReadonlyArray<string>) =>
  Array.join(
    Array.map(ids, (id) => `\`${id}\``),
    ", ",
  );

/** The PRD; `changed` says whether to write the sentences that change a section. */
const prdOf = (shape: Shape, changed: boolean): string =>
  Array.join(
    Array.prepend(
      Array.map(
        shape.prd,
        (section, index) =>
          `## Section ${index} {#${prdId(index)}}\n\nText of ${prdId(index)}.${
            changed && section.changed ? " It changed." : ""
          }\n`,
      ),
      "# Product {#prd.product}\n",
    ),
    "\n",
  );

/** A part is nested when it asks to be and there is a level-2 part above it. */
const levelOf = (index: number, part: Part) => (index > 0 && part.nested ? 3 : 2);

/** The spec; `edited` says whether to write the sentences people added. */
const specOf = (shape: Shape, edited: boolean): string =>
  Array.join(
    Array.flatten([
      ["# Spec {#spec.spec}\n"],
      Array.map(shape.spec, (part, index) =>
        Array.join(
          Array.flatten([
            [
              `${String.repeat(levelOf(index, part))("#")} Part ${index} {#${specId(index)}}\n`,
              `- Implements: ${codeList(implementsOf(shape, index, part))}`,
            ],
            part.files ? [`- Files: \`src/p${index}.ts\``] : [],
            [`\nBuilds part ${index}.${edited && part.edited ? " A person added this." : ""}\n`],
          ]),
          "\n",
        ),
      ),
      [
        `## Rest {#spec.rest}\n\n- Context: ${codeList(Array.map(shape.prd, (_, index) => prdId(index)))}\n`,
      ],
    ]),
    "\n",
  );

const decodeIndex = Schema.decodeUnknownSync(SpecIndex);
const decodeManifest = Schema.decodeUnknownSync(Manifest);

/** `spec.json` as `cairn plan` records it when it writes the plan, before anything changes. */
const indexOf = (shape: Shape): SpecIndex => {
  const prdHashes: Record.ReadonlyRecord<string, string> = Record.fromEntries(
    Array.getSomes(
      Array.map(sectionsOf(prdOf(shape, false)), (section) =>
        Option.map(
          Option.fromUndefinedOr(section.id),
          (id) => [id, bodyHashOf(section.body)] as const,
        ),
      ),
    ),
  );
  const own = (
    id: string,
  ): { readonly human: boolean; readonly implements: ReadonlyArray<string> } =>
    Option.getOrElse(
      Option.flatMap(
        Array.findFirstIndex(shape.spec, (_, index) => specId(index) === id),
        (index) =>
          Option.map(Array.get(shape.spec, index), (part) => ({
            human: part.human,
            implements: implementsOf(shape, index, part),
          })),
      ),
      () => ({ human: false, implements: [] }),
    );
  return decodeIndex({
    manifest: ".cairn/manifest.json",
    prd: ".cairn/prd.md",
    sections: Array.flatMap(sectionsOf(specOf(shape, false)), (section) =>
      Array.map(Option.toArray(Option.fromUndefinedOr(section.id)), (id) => {
        const { human, implements: implemented } = own(id);
        return {
          artifacts: [],
          children: [],
          context: [],
          decisions: [],
          defers: [],
          dependsOn: [],
          files: [],
          human: false,
          id,
          implements: implemented,
          level: section.level,
          line: section.line,
          parent: Option.getOrNull(Option.fromUndefinedOr(section.parent)),
          requirements: [],
          summary: "",
          tasks: [],
          tests: [],
          title: section.title,
          writtenFrom: {
            body: human ? null : bodyHashOf(section.body),
            prd: Record.fromEntries(
              Array.map(implemented, (prd) => [
                prd,
                Record.get(prdHashes, prd).pipe(Option.getOrThrow),
              ]),
            ),
          },
        };
      }),
    ),
    source: ".cairn/spec.md",
    version: 1,
  });
};

/** One task per tasked part, `t1`, `t2`, … in spec order; none when no part is tasked. */
const manifestOf = (shape: Shape): Option.Option<Manifest> => {
  const tasked = Array.filter(
    Array.map(shape.spec, (part, index) => ({ index, part })),
    ({ part }) => part.tasked,
  );
  return Array.isReadonlyArrayEmpty(tasked)
    ? Option.none()
    : Option.some(
        decodeManifest({
          baseBranch: "main",
          feature: "cairn-mvp",
          tasks: Array.map(tasked, ({ index, part }, at) => ({
            branch: `cairn-mvp/0${at + 1}-part`,
            commits: [],
            dependsOn: [],
            files: [],
            humanGate: { reasons: [], required: false },
            id: `t${at + 1}`,
            model: "sonnet",
            parent: null,
            prdSections: implementsOf(shape, index, part),
            reasoning: "high",
            sessions: [],
            specSections: [specId(index)],
            status: "pending",
            title: `Build part ${index}`,
            worktree: at === 0 ? null : `wt-${at}`,
          })),
          version: 1,
        }),
      );
};

/** The shape as it is just after a plan is written: no change yet, and a task for every part with files. */
const justWritten = (shape: Shape): Shape => ({
  prd: Array.map(shape.prd, () => ({ changed: false })),
  spec: Array.map(shape.spec, (part) => ({
    also: part.also,
    edited: false,
    files: part.files,
    human: part.human,
    nested: part.nested,
    tasked: part.files,
  })),
});

const replanAfter = (shape: Shape): Replan =>
  replanOf(prdOf(shape, true), specOf(shape, true), indexOf(shape), manifestOf(shape));

const EMPTY: Replan = {
  rewritable: [],
  staleSections: [],
  staleTasks: [],
  uncovered: [],
  unmappedItems: [],
  untasked: [],
};

it.prop("replanOf of a plan just written is empty", [Shape], ([generated]) => {
  expect(replanAfter(justWritten(generated))).toEqual(EMPTY);
});

it.prop(
  "a PRD section added to a plan just written is uncovered, and nothing else is found",
  { at: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })), shape: Shape },
  ({ at: picked, shape: generated }) => {
    const shape = justWritten(generated);
    const prd = prdOf(shape, false);
    const at = picked % (Array.length(shape.prd) + 1);
    const added = "## Added {#prd.added}\n\nA new requirement.\n";
    const withAdded = Option.match(String.indexOf(`## Section ${at} `)(prd), {
      onNone: () => `${prd}\n${added}`,
      onSome: (offset) => `${String.slice(0, offset)(prd)}${added}\n${String.slice(offset)(prd)}`,
    });
    expect(replanOf(withAdded, specOf(shape, false), indexOf(shape), manifestOf(shape))).toEqual({
      rewritable: [],
      staleSections: [],
      staleTasks: [],
      uncovered: ["prd.added"],
      unmappedItems: [],
      untasked: [],
    });
  },
);

/** Every section the plan writes again or reports, sorted. */
const plannedOf = (found: Replan) =>
  Array.sort(Array.appendAll(found.rewritable, found.staleSections), String.Order);

it.prop(
  "cosmeticOf never adds a section to rewritable and never drops one from the plan",
  { cosmetic: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(5)), shape: Shape },
  ({ cosmetic, shape }) => {
    const prd = prdOf(shape, true);
    const spec = specOf(shape, true);
    const replan = replanAfter(shape);
    const outOfDate = outOfDateOf(prd, spec, indexOf(shape));
    const marked = HashSet.fromIterable(
      Array.filterMap(shape.prd, (_, index) =>
        Option.getOrElse(Array.get(cosmetic, index), () => false)
          ? Result.succeed(PrdSectionId.make(prdId(index)))
          : Result.failVoid,
      ),
    );
    const after = cosmeticOf(replan, marked, outOfDate);
    expect(Array.difference(after.rewritable, replan.rewritable)).toEqual([]);
    expect(plannedOf(after)).toEqual(plannedOf(replan));
    expect(Struct.omit(after, ["rewritable", "staleSections"])).toEqual(
      Struct.omit(replan, ["rewritable", "staleSections"]),
    );
    // What moves is each section whose changed PRD sections are all cosmetic, and the stale
    // sections stay in document order.
    const allCosmetic = (id: string) =>
      Array.some(
        outOfDate,
        (found) =>
          found.id === id && Array.every(found.changed, (changed) => HashSet.has(marked, changed)),
      );
    expect(Array.difference(replan.rewritable, after.rewritable)).toEqual(
      Array.filter(replan.rewritable, allCosmetic),
    );
    expect(after.staleSections).toEqual(
      Array.filter(
        Array.map(outOfDate, ({ id }) => id),
        (id) => Array.contains(after.staleSections, id),
      ),
    );
  },
);

it("cosmeticOf moves a section only when every PRD section that changed under it is cosmetic", () => {
  const shape: Shape = {
    prd: [{ changed: true }, { changed: true }],
    spec: [{ also: 1, edited: false, files: false, human: false, nested: false, tasked: false }],
  };
  const replan = replanAfter(shape);
  const outOfDate = outOfDateOf(prdOf(shape, true), specOf(shape, true), indexOf(shape));
  const moved = (ids: ReadonlyArray<string>) =>
    cosmeticOf(
      replan,
      HashSet.fromIterable(Array.map(ids, (id) => PrdSectionId.make(id))),
      outOfDate,
    );
  expect(replan.rewritable).toEqual(["spec.p0"]);
  expect(moved(["prd.s0"])).toEqual(replan);
  expect(moved(["prd.s0", "prd.s1"])).toEqual(
    Struct.assign(replan, { rewritable: [], staleSections: ["spec.p0"] }),
  );
});

/** The level-2 part a nested part sits under. */
const parentPartOf = (shape: Shape, index: number): Option.Option<number> =>
  Array.findLastIndex(Array.take(shape.spec, index), (part, at) => levelOf(at, part) === 2);

it.prop(
  "replanOf finds the sections and tasks a changed PRD and edited spec leave behind",
  [Shape],
  ([shape]) => {
    const changed = (part: Part, index: number) =>
      Array.some(implementsOf(shape, index, part), (prd) =>
        Array.some(shape.prd, (section, at) => section.changed && prdId(at) === prd),
      );
    const rewritable = (part: Part, index: number) =>
      changed(part, index) && !part.human && !part.edited && !part.tasked;
    const stale = (part: Part, index: number) => changed(part, index) && !rewritable(part, index);
    const tasked = Array.filter(
      Array.map(shape.spec, (part, index) => ({ index, part })),
      ({ part }) => part.tasked,
    );
    const builtBelow = (index: number) =>
      Array.some(
        shape.spec,
        (part, at) =>
          at > index &&
          part.tasked &&
          levelOf(at, part) === 3 &&
          Option.contains(parentPartOf(shape, at), index),
      );
    const pick = (keep: (part: Part, index: number) => boolean) =>
      Array.filterMap(shape.spec, (part, index) =>
        keep(part, index) ? Result.succeed(specId(index)) : Result.failVoid,
      );
    expect(replanAfter(shape)).toEqual({
      rewritable: pick(rewritable),
      staleSections: pick(stale),
      staleTasks: Array.filterMap(tasked, ({ index, part }, at) =>
        stale(part, index) || (part.edited && !part.human)
          ? Result.succeed(`t${at + 1}`)
          : Result.failVoid,
      ),
      uncovered: [],
      unmappedItems: [],
      untasked: pick((part, index) => part.files && !part.tasked && !builtBelow(index)),
    });
  },
);

it.prop("a section a person edited is never rewritable", [Shape], ([shape]) => {
  const edited = HashSet.fromIterable(
    Array.filterMap(shape.spec, (part, index) =>
      part.edited ? Result.succeed(specId(index)) : Result.failVoid,
    ),
  );
  expect(Array.filter(replanAfter(shape).rewritable, (id) => HashSet.has(edited, id))).toEqual([]);
});

it.prop("a section a task builds is never rewritable", [Shape], ([shape]) => {
  const built = HashSet.fromIterable(
    Array.flatMap(
      Option.match(manifestOf(shape), { onNone: () => [], onSome: (plan) => plan.tasks }),
      (task) => task.specSections,
    ),
  );
  expect(Array.filter(replanAfter(shape).rewritable, (id) => HashSet.has(built, id))).toEqual([]);
});

it.prop(
  "lint reports what replanOf finds stale, as warnings on the section's line or the task",
  [Shape],
  ([shape]) => {
    const prd = prdOf(shape, true);
    const spec = specOf(shape, true);
    const manifest = manifestOf(shape);
    const found = replanOf(prd, spec, indexOf(shape), manifest);
    const findings = lint(prd, spec, manifest, { humanPaths: [] }, Option.some(indexOf(shape)));
    const of = (rule: Finding["rule"]) =>
      Array.filter(findings, (finding) => finding.rule === rule);
    const lineOf = (id: string) =>
      Array.findFirst(sectionsOf(spec), (section) => section.id === id).pipe(
        Option.map((section) => section.line),
      );
    expect(Array.map(of("stale-section"), ({ line }) => line)).toEqual(
      Array.map(found.staleSections, lineOf),
    );
    expect(
      Array.dedupe(
        Array.map(of("stale-task"), ({ message }) =>
          Option.getOrElse(Array.head(String.split(message, " ")), () => ""),
        ),
      ),
    ).toEqual(found.staleTasks);
    expect(
      Array.every(
        Array.appendAll(of("stale-section"), of("stale-task")),
        ({ severity }) => severity === "warning",
      ),
    ).toBe(true);
    expect(
      Array.filter(
        lint(prd, spec, manifest, { humanPaths: [] }),
        ({ rule }) => rule === "stale-section" || rule === "stale-task",
      ),
    ).toEqual([]);
  },
);

/** One spec section built by `t1`, one a person wrote and one Cairn wrote, all implementing `prd.goal`. */
const EXAMPLE: Shape = {
  prd: [{ changed: true }],
  spec: [
    { also: 0, edited: false, files: true, human: false, nested: false, tasked: true },
    { also: 0, edited: false, files: false, human: true, nested: false, tasked: false },
    { also: 0, edited: true, files: true, human: false, nested: true, tasked: false },
  ],
};

it("a stale section names the PRD sections that changed and how to settle it", () => {
  const prd = prdOf(EXAMPLE, true);
  const spec = specOf(EXAMPLE, true);
  const manifest = manifestOf(EXAMPLE);
  const stale = Array.filter(
    lint(prd, spec, manifest, { humanPaths: [] }, Option.some(indexOf(EXAMPLE))),
    ({ rule }) => rule === "stale-section" || rule === "stale-task",
  );
  expect(stale).toEqual([
    {
      file: "spec.md",
      line: Option.some(3),
      message:
        "spec.p0 implements prd.s0, which changed after spec.p0 was written. Update the section if it needs it, then run cairn plan --accept spec.p0.",
      rule: "stale-section",
      severity: "warning",
    },
    {
      file: "spec.md",
      line: Option.some(10),
      message:
        "spec.p1 implements prd.s0, which changed after spec.p1 was written. Update the section if it needs it, then run cairn plan --accept spec.p1.",
      rule: "stale-section",
      severity: "warning",
    },
    {
      file: "spec.md",
      line: Option.some(16),
      message:
        "spec.p2 implements prd.s0, which changed after spec.p2 was written. Update the section if it needs it, then run cairn plan --accept spec.p2.",
      rule: "stale-section",
      severity: "warning",
    },
    {
      file: "manifest.json",
      line: Option.none(),
      message: "t1 builds spec.p0, which is stale.",
      rule: "stale-task",
      severity: "warning",
    },
  ]);
});

it("a section with files above one a task builds needs no task of its own", () => {
  const shape: Shape = {
    prd: [{ changed: false }],
    spec: [
      { also: 0, edited: false, files: true, human: false, nested: false, tasked: false },
      { also: 0, edited: false, files: true, human: false, nested: true, tasked: true },
      { also: 0, edited: false, files: true, human: false, nested: true, tasked: false },
    ],
  };
  expect(replanAfter(shape).untasked).toEqual(["spec.p2"]);
  expect(
    replanOf(prdOf(shape, false), specOf(shape, false), indexOf(shape), Option.none()).untasked,
  ).toEqual(["spec.p0", "spec.p1", "spec.p2"]);
});

it("a section spec.json does not record is neither stale nor rewritable", () => {
  const shape: Shape = {
    prd: [{ changed: true }],
    spec: [{ also: 0, edited: false, files: false, human: false, nested: false, tasked: false }],
  };
  const index = indexOf(shape);
  expect(
    replanOf(
      prdOf(shape, true),
      specOf(shape, true),
      Struct.evolve(index, {
        sections: (sections) => Array.filter(sections, ({ id }) => id !== "spec.p0"),
      }),
      Option.none(),
    ),
  ).toEqual(EMPTY);
  expect(replanAfter(shape).rewritable).toEqual(["spec.p0"]);
});

it("a body hash is the SHA-256 in hex of the body without trailing whitespace on each line", () => {
  expect(bodyHashOf("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(bodyHashOf("abc  \t")).toBe(bodyHashOf("abc"));
  expect(bodyHashOf("a \nb")).toBe(bodyHashOf("a\nb"));
  expect(bodyHashOf("a\n\nb")).not.toBe(bodyHashOf("a\nb"));
});

it("the stack diagram's section covers nothing, though its Context names the PRD's top section", () => {
  const prd =
    "# Notes {#prd.notes}\n\n## Capture {#prd.capture}\n\nKeep.\n\n## Share {#prd.share}\n\nShare.\n";
  const spec = Array.join(
    [
      "# Spec {#spec.spec}",
      "",
      "## Capture {#spec.capture}",
      "",
      "- Implements: `prd.capture`",
      "- Files: `src/capture.ts`",
      "",
      "## Stacks {#spec.stacks}",
      "",
      "- Context: `prd.notes`",
      "",
    ],
    "\n",
  );
  const index: SpecIndex = {
    manifest: ".cairn/manifest.json",
    prd: ".cairn/prd.md",
    sections: [],
    source: ".cairn/spec.md",
    tasks: [],
    version: 1,
  };
  expect(replanOf(prd, spec, index, Option.none()).uncovered).toEqual(["prd.share"]);
  const findings = lint(prd, spec, Option.none(), { humanPaths: [] });
  expect(Array.map(findings, (finding) => finding.rule)).toContain("unmapped-section");
});

/**
 * A spec of level-2 and level-3 parts, each with a key list that may open with the human marker
 * and may hold an `Implements` line naming some of the PRD IDs `prd.i0` to `prd.i3`, and after
 * its prose a line that reads like a key but is prose. `target` and `item` pick the section and
 * the item `withImplements` is given.
 */
const KeyedSpec = Schema.Struct({
  item: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  parts: Schema.Array(
    Schema.Struct({
      files: Schema.Boolean,
      hasImplements: Schema.Boolean,
      implements: Schema.Array(
        Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
      ).check(Schema.isMaxLength(3)),
      marker: Schema.Boolean,
      nested: Schema.Boolean,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  target: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
});
type KeyedSpec = typeof KeyedSpec.Type;

const itemId = (index: number) => `prd.i${index}`;

/** The lines of each part of a `KeyedSpec`, with the place of its `Implements` line among them. */
const keyedPartsOf = (shape: KeyedSpec) =>
  Array.map(shape.parts, (part, index) => {
    const heading = `${String.repeat(index > 0 && part.nested ? 3 : 2)("#")} Part ${index} {#${specId(index)}}`;
    const marker = part.marker ? ["<!-- human -->"] : [];
    const implemented = part.hasImplements
      ? [
          `- Implements:${Array.isReadonlyArrayEmpty(part.implements) ? "" : " "}${codeList(Array.dedupe(Array.map(part.implements, itemId)))}`,
        ]
      : [];
    const files = part.files ? [`- Files: \`src/p${index}.ts\``] : [];
    return {
      implementsAt: part.hasImplements
        ? Option.some(2 + Array.length(marker))
        : Option.none<number>(),
      lines: Array.flatten([
        [heading, ""],
        marker,
        implemented,
        files,
        ["", `Builds part ${index}.`, "- Implements: `prd.decoy` is prose here.", ""],
      ]),
    };
  });

it.prop(
  "withImplements adds the item to the section's own Implements line and changes no other line",
  [KeyedSpec],
  ([shape]) => {
    const parts = keyedPartsOf(shape);
    const lines = Array.flatten(
      Array.prepend(
        Array.map(parts, ({ lines: own }) => own),
        ["# Spec {#spec.spec}", ""],
      ),
    );
    const spec = Array.join(lines, "\n");
    const target = shape.target % Array.length(shape.parts);
    const item = PrdSectionId.make(itemId(shape.item));
    const after = String.split(
      withImplements(spec, SpecSectionId.make(specId(target)), item),
      "\n",
    );
    const offset =
      2 +
      Array.reduce(Array.take(parts, target), 0, (sum, { lines: own }) => sum + Array.length(own));
    const at = Option.map(
      Option.flatMap(Array.get(parts, target), ({ implementsAt }) => implementsAt),
      (inPart) => offset + inPart,
    );
    expect(Array.length(after)).toBe(Array.length(lines));
    expect(Array.filter(after, (_, index) => !Option.contains(at, index))).toEqual(
      Array.filter(lines, (_, index) => !Option.contains(at, index)),
    );
    Option.match(at, {
      onNone: () => expect(after).toEqual(lines),
      onSome: (index) => {
        const before = Option.getOrThrow(Array.get(lines, index));
        const named = Option.exists(Array.get(shape.parts, target), (part) =>
          Array.contains(part.implements, shape.item),
        );
        const empty = Option.exists(Array.get(shape.parts, target), (part) =>
          Array.isReadonlyArrayEmpty(part.implements),
        );
        expect(Array.get(after, index)).toEqual(
          Option.some(named ? before : `${before}${empty ? "" : ","} \`${item}\``),
        );
      },
    });
  },
);

/**
 * A PRD of level-2 headings `prd.h<i>` under `prd.product`, each with list items; an item may have
 * an ID `prd.h<i>.i<j>` and may be nested one level deeper than the item before it. Spec part `k`
 * has its own `Implements` naming headings and items by their place in `ids`, may be nested
 * under the part before it, and may have been written by a person (`human`, no `writtenFrom.body`)
 * or edited by one since Cairn wrote it.
 */
const ItemPlan = Schema.Struct({
  headings: Schema.Array(
    Schema.Array(Schema.Struct({ hasId: Schema.Boolean, nested: Schema.Boolean })).check(
      Schema.isMaxLength(4),
    ),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  parts: Schema.Array(
    Schema.Struct({
      edited: Schema.Boolean,
      human: Schema.Boolean,
      names: Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 0 }))).check(
        Schema.isMaxLength(3),
      ),
      nested: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(5)),
});
type ItemPlan = typeof ItemPlan.Type;

/** A PRD item of an `ItemPlan`: its ID if it has one, its depth, and its heading. */
interface PlannedItem {
  readonly depth: number;
  readonly heading: string;
  readonly id: Option.Option<string>;
}

const plannedItemsOf = (plan: ItemPlan): ReadonlyArray<PlannedItem> =>
  Array.flatMap(
    plan.headings,
    (items, h) =>
      Array.mapAccum(items, -1, (previous, item, j) => {
        const depth = item.nested && previous >= 0 ? Number.min(previous + 1, 2) : 0;
        return [
          depth,
          {
            depth,
            heading: `prd.h${h}`,
            id: item.hasId ? Option.some(`prd.h${h}.i${j}`) : Option.none<string>(),
          },
        ];
      })[1],
  );

/** Every ID a spec part can name: the top heading and the others, then the items that have one. */
const nameableOf = (plan: ItemPlan): ReadonlyArray<string> =>
  Array.appendAll(
    Array.prepend(
      Array.map(plan.headings, (_, h) => `prd.h${h}`),
      "prd.product",
    ),
    Array.getSomes(Array.map(plannedItemsOf(plan), ({ id }) => id)),
  );

const namesOf = (plan: ItemPlan, part: ItemPlan["parts"][number]): ReadonlyArray<string> => {
  const nameable = nameableOf(plan);
  return Array.dedupe(
    Array.getSomes(
      Array.map(part.names, (pick) => Array.get(nameable, pick % Array.length(nameable))),
    ),
  );
};

const itemPrdOf = (plan: ItemPlan): string =>
  Array.join(
    Array.prepend(
      Array.map(plan.headings, (_, h) =>
        Array.join(
          Array.prepend(
            Array.map(
              Array.filter(plannedItemsOf(plan), ({ heading }) => heading === `prd.h${h}`),
              ({ depth, id }, j) =>
                `${String.repeat(depth)("  ")}- Item ${j}${Option.match(id, { onNone: () => "", onSome: (found) => ` {#${found}}` })}`,
            ),
            `## Heading ${h} {#prd.h${h}}\n`,
          ),
          "\n",
        ),
      ),
      "# Product {#prd.product}\n",
    ),
    "\n\n",
  );

const itemSpecOf = (plan: ItemPlan, edited: boolean): string =>
  Array.join(
    Array.prepend(
      Array.map(plan.parts, (part, k) => {
        const names = namesOf(plan, part);
        return Array.join(
          Array.flatten([
            [`${String.repeat(k > 0 && part.nested ? 3 : 2)("#")} Part ${k} {#${specId(k)}}`, ""],
            Array.isReadonlyArrayEmpty(names) ? [] : [`- Implements: ${codeList(names)}`, ""],
            [`Builds part ${k}.${edited && part.edited ? " A person added this." : ""}`, ""],
          ]),
          "\n",
        );
      }),
      "# Spec {#spec.spec}\n",
    ),
    "\n",
  );

const itemIndexOf = (plan: ItemPlan): SpecIndex => {
  const spec = itemSpecOf(plan, false);
  return decodeIndex({
    manifest: ".cairn/manifest.json",
    prd: ".cairn/prd.md",
    sections: Array.map(
      derivedOf({
        manifest: { tasks: [] },
        prd: itemPrdOf(plan),
        previous: Option.none(),
        spec,
        written: Array.filterMap(plan.parts, (part, k) =>
          part.human ? Result.failVoid : Result.succeed(SpecSectionId.make(specId(k))),
        ),
      }),
      (entry) =>
        Struct.assign(entry, {
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
};

it.prop(
  "replanOf lists each uncovered item with the untouched sections that implement its heading or an item above it, inherited or not",
  [ItemPlan],
  ([plan]) => {
    const items = plannedItemsOf(plan);
    const named = Array.flatMap(plan.parts, (part) => namesOf(plan, part));
    /** The items with an ID above item `at` under its heading, nearest first. */
    const aboveItems = (at: number): ReadonlyArray<string> => {
      const item = Option.getOrThrow(Array.get(items, at));
      const before = Array.reverse(
        Array.filter(Array.take(items, at), ({ heading }) => heading === item.heading),
      );
      return pipe(
        Array.mapAccum(before, item.depth, (depth, other) =>
          other.depth < depth
            ? [other.depth, Option.some(other)]
            : [depth, Option.none<PlannedItem>()],
        )[1],
        Array.getSomes,
        Array.flatMap(({ id }) => Option.toArray(id)),
      );
    };
    /** What part `k` implements: its own names, and its parent's when it is nested. */
    const implementedBy = (k: number): ReadonlyArray<string> => {
      const isTop = (j: number) =>
        j === 0 || !Option.exists(Array.get(plan.parts, j), (part) => part.nested);
      const own = Option.match(Array.get(plan.parts, k), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (part) => namesOf(plan, part),
      });
      const parent = isTop(k)
        ? Option.none<number>()
        : Array.findLast(Array.range(0, k - 1), isTop);
      return Array.appendAll(
        own,
        Option.match(
          Option.flatMap(parent, (j) => Array.get(plan.parts, j)),
          {
            onNone: (): ReadonlyArray<string> => [],
            onSome: (part) => namesOf(plan, part),
          },
        ),
      );
    };
    const expected = Array.filterMap(items, (item, at) =>
      Option.match(
        Option.filter(item.id, (id) => !Array.contains(named, id)),
        {
          onNone: () => Result.failVoid,
          onSome: (id) => {
            const above = Array.append(aboveItems(at), item.heading);
            return Result.succeed({
              candidates: Array.filterMap(plan.parts, (part, k) =>
                !part.human &&
                !part.edited &&
                // It has an Implements line of its own, and implements the item's heading or an
                // item above it by that line or the one it inherits.
                Array.isReadonlyArrayNonEmpty(namesOf(plan, part)) &&
                Array.some(implementedBy(k), (name) => Array.contains(above, name))
                  ? Result.succeed(specId(k))
                  : Result.failVoid,
              ),
              item: id,
            });
          },
        },
      ),
    );
    const found = replanOf(
      itemPrdOf(plan),
      itemSpecOf(plan, true),
      itemIndexOf(plan),
      Option.none(),
    );
    expect(found.unmappedItems).toEqual(expected);
    // What lint reports as unmapped is exactly what is listed.
    const unmapped = Array.filter(
      lint(itemPrdOf(plan), itemSpecOf(plan, true), Option.none(), { humanPaths: [] }),
      (finding: Finding) => finding.rule === "unmapped-item",
    );
    expect(Array.length(unmapped)).toBe(Array.length(expected));
  },
);
