import { Manifest } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Order, Result, Schema, String } from "effect";

import { STACKS_CLOSE, STACKS_OPEN, lint, withStackDiagram } from "../src/index.ts";
import type { Finding, LintRule } from "../src/index.ts";

/**
 * A PRD under one title heading, `prd.product` on line 1. Section `i` is `prd.s<i>` on line
 * `3 + 2i`; its level is the generated one, but at most one below the section before it.
 */
const Levels = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 2 }))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10),
);

const levelsOf = (raw: ReadonlyArray<number>): ReadonlyArray<number> =>
  Array.mapAccum(raw, 1, (previous, level) => {
    const kept = level > previous + 1 ? previous + 1 : level;
    return [kept, kept];
  })[1];

const ROOT = "prd.product";
const prdId = (index: number) => `prd.s${index}`;
const lineOf = (index: number) => 3 + 2 * index;

/** Writes headings, one per two lines, after the title heading on line 1. */
const documentOf = (
  title: string,
  headings: ReadonlyArray<{ readonly id: Option.Option<string>; readonly level: number }>,
): string =>
  Array.join(
    Array.prepend(
      Array.map(
        headings,
        ({ id, level }, index) =>
          `${String.repeat(level)("#")} Section ${index}${Option.match(id, {
            onNone: () => "",
            onSome: (value) => ` {#${value}}`,
          })}\n`,
      ),
      `# ${title}\n`,
    ),
    "\n",
  );

const prdOf = (levels: ReadonlyArray<number>) =>
  documentOf(
    "Product {#prd.product}",
    Array.map(levels, (level, index) => ({ id: Option.some(prdId(index)), level })),
  );

/** The sections above section `index` in the heading tree, the title included. */
const ancestorsOf = (levels: ReadonlyArray<number>, index: number): ReadonlyArray<string> => {
  const [, found] = Array.mapAccum(
    Array.reverse(Array.take(levels, index)),
    Option.getOrElse(Array.get(levels, index), () => 2),
    (below, level, at): [number, Option.Option<string>] =>
      level < below ? [level, Option.some(prdId(index - 1 - at))] : [below, Option.none()],
  );
  return Array.prepend(Array.getSomes(found), ROOT);
};

const specWith = (key: string, ids: ReadonlyArray<string>) =>
  `# Spec {#spec.spec}\n\n## Plan {#spec.plan}\n\n- ${key}: ${Array.join(
    Array.map(ids, (id) => `\`${id}\``),
    ", ",
  )}\n`;

const decodeManifest = Schema.decodeUnknownSync(Manifest);

/** No high-trust paths: these tests are about sections, and no task here touches a gated file. */
const NO_GATES = { humanPaths: [] };

/** `spec` with the stack diagram of `manifest` between markers at its end, so it does not drift. */
const drawn = (spec: string, manifest: Manifest) =>
  withStackDiagram(`${spec}\n${STACKS_OPEN}\n${STACKS_CLOSE}\n`, manifest);

const manifestOf = (tasks: ReadonlyArray<{ readonly prd: string; readonly spec: string }>) =>
  decodeManifest({
    baseBranch: "main",
    feature: "cairn-mvp",
    tasks: Array.map(tasks, ({ prd, spec }, index) => ({
      branch: `cairn-mvp/0${index + 1}-task`,
      commits: [],
      dependsOn: [],
      files: [],
      humanGate: { reasons: [], required: false },
      id: `t${index + 1}`,
      model: "sonnet",
      parent: null,
      prdSections: [prd],
      reasoning: "high",
      sessions: [],
      specSections: [spec],
      status: "pending",
      title: `Task ${index + 1}`,
      worktree: index === 0 ? null : `wt-${index}`,
    })),
    version: 1,
  });

const only = (findings: ReadonlyArray<Finding>, rule: LintRule) =>
  Array.filter(findings, (finding) => finding.rule === rule);

const linesOf = (findings: ReadonlyArray<Finding>) =>
  Array.sort(Array.getSomes(Array.map(findings, (finding) => finding.line)), Order.Number);

const CoverKey = Schema.Literals(["Implements", "Defers", "Context"]);

it.prop(
  "a PRD section is covered when it or one under it is named, or one above it is deferred or context",
  {
    key: CoverKey,
    levels: Levels,
    target: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
  },
  ({ key, levels: raw, target: picked }) => {
    const levels = levelsOf(raw);
    const target = picked % Array.length(levels);
    const findings = lint(prdOf(levels), specWith(key, [prdId(target)]), Option.none(), NO_GATES);
    const isUnder = (index: number) => Array.contains(ancestorsOf(levels, index), prdId(target));
    const covered = (index: number) =>
      index === target ||
      Array.contains(ancestorsOf(levels, target), prdId(index)) ||
      (key !== "Implements" && isUnder(index));
    const uncovered = Array.filter(
      Array.range(0, Array.length(levels) - 1),
      (index) => !covered(index),
    );
    expect(findings).toEqual(
      Array.map(uncovered, (index) => ({
        file: "prd.md",
        line: Option.some(lineOf(index)),
        message: `${prdId(index)} is not implemented, deferred or given as context by any spec section.`,
        rule: "unmapped-section",
        severity: "error",
      })),
    );
  },
);

it.prop(
  "a plan whose spec implements every PRD section and whose tasks name real sections has no findings",
  [Levels],
  ([raw]) => {
    const levels = levelsOf(raw);
    const ids = Array.map(levels, (_, index) => prdId(index));
    const manifest = manifestOf(Array.map(ids, (prd) => ({ prd, spec: "spec.plan" })));
    // The PRD has no statements, so every task also gets a `task-without-statement` warning.
    expect(
      Array.filter(
        lint(
          prdOf(levels),
          drawn(specWith("Implements", ids), manifest),
          Option.some(manifest),
          NO_GATES,
        ),
        ({ rule }) => rule !== "task-without-statement",
      ),
    ).toEqual([]);
  },
);

const Heading = Schema.Struct({
  id: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
  identified: Schema.Boolean,
  prefix: Schema.Literals(["prd", "spec"]),
});
const Headings = Schema.Array(Heading).check(Schema.isMinLength(1), Schema.isMaxLength(10));

/** A PRD whose headings may lack an ID, share one from a small pool, or carry the spec prefix. */
const messyPrd = (headings: ReadonlyArray<typeof Heading.Type>) =>
  documentOf(
    "Product {#prd.product}",
    Array.map(headings, ({ id, identified, prefix }) => ({
      id: identified ? Option.some(`${prefix}.s${id}`) : Option.none(),
      level: 2,
    })),
  );

const SPEC = specWith("Context", [ROOT]);

it.prop(
  "every heading without an ID is a missing-id finding on its line",
  [Headings],
  ([headings]) => {
    const findings = only(lint(messyPrd(headings), SPEC, Option.none(), NO_GATES), "missing-id");
    expect(linesOf(findings)).toEqual(
      Array.filterMap(headings, ({ identified }, index) =>
        identified ? Result.failVoid : Result.succeed(lineOf(index)),
      ),
    );
    expect(Array.every(findings, (finding) => String.includes("cairn ids")(finding.message))).toBe(
      true,
    );
  },
);

it.prop(
  "every heading after the first with an ID is a duplicate-id finding that points at the first",
  [Headings],
  ([headings]) => {
    const findings = only(lint(messyPrd(headings), SPEC, Option.none(), NO_GATES), "duplicate-id");
    const ids = Array.map(headings, ({ id, identified, prefix }) =>
      identified ? Option.some(`${prefix}.s${id}`) : Option.none(),
    );
    const repeated = Array.filterMap(ids, (id, index) =>
      Option.exists(id, (value) => Array.contains(Array.getSomes(Array.take(ids, index)), value))
        ? Result.succeed(lineOf(index))
        : Result.failVoid,
    );
    expect(linesOf(findings)).toEqual(repeated);
    Array.forEach(findings, (finding) => {
      const first = Option.getOrThrow(
        Array.findFirstIndex(ids, (id) =>
          Option.exists(id, (value) => String.startsWith(`${value} `)(finding.message)),
        ),
      );
      expect(String.endsWith(`prd.md:${lineOf(first)}.`)(finding.message)).toBe(true);
    });
  },
);

it.prop("a spec. ID in prd.md is a wrong-prefix finding on its line", [Headings], ([headings]) => {
  const findings = only(lint(messyPrd(headings), SPEC, Option.none(), NO_GATES), "wrong-prefix");
  expect(linesOf(findings)).toEqual(
    Array.filterMap(headings, ({ identified, prefix }, index) =>
      identified && prefix === "spec" ? Result.succeed(lineOf(index)) : Result.failVoid,
    ),
  );
});

it("a prd. ID in spec.md is a wrong-prefix finding", () => {
  const spec = "# Spec {#spec.spec}\n\n## Plan {#prd.plan}\n\n- Context: `prd.product`\n";
  expect(
    only(lint("# Product {#prd.product}\n", spec, Option.none(), NO_GATES), "wrong-prefix"),
  ).toEqual([
    {
      file: "spec.md",
      line: Option.some(3),
      message: "prd.plan is in spec.md, where every ID starts with spec.",
      rule: "wrong-prefix",
      severity: "error",
    },
  ]);
});

const Named = Schema.Array(
  Schema.Struct({
    gone: Schema.Literals(["no", "deleted", "other-prefix"]),
    key: Schema.Literals(["Implements", "Defers", "Context", "Depends on"]),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(6));

/**
 * The ID a generated key names: a heading of the file the key names, one that is gone, or a real
 * heading of the other file, which `sectionsOf` leaves out of the key.
 */
const idOf = ({ gone, key }: (typeof Named.Type)[number], index: number) =>
  key === "Depends on"
    ? { deleted: `spec.gone-${index}`, no: "spec.spec", "other-prefix": ROOT }[gone]
    : { deleted: `prd.gone-${index}`, no: ROOT, "other-prefix": "spec.plan" }[gone];

it.prop(
  "a key that names an ID no heading of its file has is an unknown-section finding on its section",
  [Named],
  ([named]) => {
    const keyLines = Array.map(
      named,
      (entry, index) => `- ${entry.key}: \`${idOf(entry, index)}\``,
    );
    const spec = `# Spec {#spec.spec}\n\n## Plan {#spec.plan}\n\n${Array.join(keyLines, "\n")}\n`;
    const findings = only(
      lint("# Product {#prd.product}\n", spec, Option.none(), NO_GATES),
      "unknown-section",
    );
    const expected = Array.filterMap(named, (entry, index) =>
      entry.gone !== "no"
        ? Result.succeed(
            `${entry.key} names ${idOf(entry, index)}, which no heading in ${
              entry.key === "Depends on" ? "spec.md" : "prd.md"
            } has.`,
          )
        : Result.failVoid,
    );
    expect(Array.map(findings, (finding) => [finding.file, finding.line])).toEqual(
      Array.map(expected, () => ["spec.md", Option.some(3)]),
    );
    expect(
      Array.sort(
        Array.map(findings, (finding) => finding.message),
        String.Order,
      ),
    ).toEqual(Array.sort(expected, String.Order));
  },
);

it("a key a section inherits is reported once, on the section that writes it", () => {
  const spec = Array.join(
    [
      "# Spec {#spec.spec}",
      "",
      "## Area {#spec.area}",
      "",
      "- Implements: `prd.deleted`",
      "",
      "### Part {#spec.area.part}",
      "",
      "### Other part {#spec.area.other}",
      "",
    ],
    "\n",
  );
  expect(
    only(lint("# Product {#prd.product}\n", spec, Option.none(), NO_GATES), "unknown-section"),
  ).toEqual([
    {
      file: "spec.md",
      line: Option.some(3),
      message: "Implements names prd.deleted, which no heading in prd.md has.",
      rule: "unknown-section",
      severity: "error",
    },
  ]);
});

const TaskLinks = Schema.Array(
  Schema.Struct({ prdGone: Schema.Boolean, specGone: Schema.Boolean }),
).check(Schema.isMinLength(1), Schema.isMaxLength(6));

it.prop(
  "a task that names an ID no heading has is an unknown-section finding in manifest.json",
  [TaskLinks],
  ([links]) => {
    const manifest = manifestOf(
      Array.map(links, ({ prdGone, specGone }) => ({
        prd: prdGone ? "prd.deleted" : ROOT,
        spec: specGone ? "spec.deleted" : "spec.plan",
      })),
    );
    const findings = only(
      lint(prdOf([2]), specWith("Context", [ROOT]), Option.some(manifest), NO_GATES),
      "unknown-section",
    );
    const expected = Array.flatMap(links, ({ prdGone, specGone }, index) =>
      Array.appendAll(
        prdGone ? [`t${index + 1} names prd.deleted, which no heading in prd.md has.`] : [],
        specGone ? [`t${index + 1} names spec.deleted, which no heading in spec.md has.`] : [],
      ),
    );
    expect(Array.map(findings, (finding) => [finding.file, finding.line, finding.message])).toEqual(
      Array.map(expected, (message) => ["manifest.json", Option.none(), message]),
    );
  },
);

it("orders findings by file, then by line, with manifest findings last", () => {
  const prd = "# Product {#prd.product}\n\n## Goal\n";
  const spec = "# Spec {#spec.spec}\n\n## Plan\n\n- Implements: `prd.gone`\n";
  const manifest = manifestOf([{ prd: "prd.gone", spec: "spec.plan" }]);
  expect(
    Array.map(lint(prd, drawn(spec, manifest), Option.some(manifest), NO_GATES), (finding) => [
      finding.file,
      finding.line,
      finding.rule,
    ]),
  ).toEqual([
    ["prd.md", Option.some(1), "unmapped-section"],
    ["prd.md", Option.some(3), "missing-id"],
    ["spec.md", Option.some(3), "missing-id"],
    ["spec.md", Option.some(3), "unknown-section"],
    ["manifest.json", Option.none(), "task-without-statement"],
    ["manifest.json", Option.none(), "unknown-section"],
    ["manifest.json", Option.none(), "unknown-section"],
  ]);
});
