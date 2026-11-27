import { Manifest, PrdSectionId, SpecIndex } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Option, Record, Result, Schema, String, Struct } from "effect";

import { bodyHashOf, cosmeticOf, lint, outOfDateOf, replanOf, sectionsOf } from "../src/index.ts";
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
