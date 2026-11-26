import { IndexedSection, Manifest, Slug, defaultConfig } from "@cairn/contract";
import type { SpecIndex } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String, Struct } from "effect";

import { derivedOf, lint } from "../src/index.ts";
import type { Finding, LintRule } from "../src/index.ts";

const RULES: ReadonlyArray<LintRule> = [
  "draft-statement",
  "unproved-statement",
  "task-without-statement",
];

const PRD = Array.join(
  [
    "# Title {#prd.title}",
    "",
    "## Saved views {#prd.saved-views}",
    "",
    "Done when:",
    "",
    "- Draft: Saving a view lists it. {#prd.saved-views#v1}",
    "- Renaming a view changes its title. {#prd.saved-views#v2}",
    "- <!-- human --> The list looks right. {#prd.saved-views#v3}",
    "",
    "## Sharing {#prd.sharing}",
    "",
    "Nothing to prove here.",
    "",
  ],
  "\n",
);

const SPEC = Array.join(
  [
    "# Spec {#spec.spec}",
    "",
    "## Views {#spec.views}",
    "",
    "- Implements: `prd.saved-views`",
    "",
    "## Share {#spec.share}",
    "",
    "- Implements: `prd.sharing`",
    "",
  ],
  "\n",
);

const task = (id: string, prdSections: ReadonlyArray<string>) => ({
  branch: `cairn-mvp/0${String.slice(1)(id)}-task`,
  commits: [],
  dependsOn: [],
  files: [],
  humanGate: { reasons: [], required: false },
  id,
  model: "sonnet",
  parent: null,
  prdSections,
  reasoning: "low",
  sessions: [],
  specSections: ["spec.views"],
  status: "pending",
  title: `Task ${id}`,
  worktree: null,
});

const manifestOf = (tasks: ReadonlyArray<ReturnType<typeof task>>) =>
  Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature: "cairn-mvp",
    tasks,
    version: 1,
  });

/** An index of `SPEC` whose sections ask for the given tests, each proving the statements named. */
const indexOf = (
  tests: ReadonlyArray<{ readonly proves: ReadonlyArray<string>; readonly section: string }>,
): SpecIndex => ({
  manifest: ".cairn/manifest.json",
  prd: ".cairn/prd.md",
  sections: Array.map(
    derivedOf({
      manifest: { tasks: [] },
      prd: PRD,
      previous: Option.none(),
      spec: SPEC,
      written: [],
    }),
    (derived): IndexedSection => ({
      ...derived,
      artifacts: [],
      decisions: [],
      requirements: [],
      summary: "",
      tests: Schema.decodeUnknownSync(IndexedSection.fields.tests)(
        Array.map(
          Array.filter(tests, ({ section }) => section === derived.id),
          ({ proves }, at) => ({
            id: `${derived.id}#t${at + 1}`,
            kind: "example",
            proves,
            text: "A test.",
          }),
        ),
      ),
    }),
  ),
  source: ".cairn/spec.md",
  tasks: [],
  version: 1,
});

const run = (prd: string, manifest: Option.Option<Manifest>, index: Option.Option<SpecIndex>) =>
  Array.filter(lint(prd, SPEC, manifest, { humanPaths: [] }, index), (finding) =>
    Array.contains(RULES, finding.rule),
  );

const place = (finding: Finding) => [finding.rule, finding.file, finding.line, finding.severity];

it("draft-statement fires on a draft, on its line, and not on a confirmed statement", () => {
  const found = Array.filter(
    run(PRD, Option.none(), Option.none()),
    ({ rule }) => rule === "draft-statement",
  );
  expect(Array.map(found, place)).toEqual([
    ["draft-statement", "prd.md", Option.some(7), "warning"],
  ]);
  expect(found[0]?.message).toContain("prd.saved-views#v1");
});

it("unproved-statement fires on an untagged statement with no test, and not on a human-tagged one", () => {
  const found = Array.filter(
    run(PRD, Option.none(), Option.some(indexOf([]))),
    ({ rule }) => rule === "unproved-statement",
  );
  expect(Array.map(found, place)).toEqual([
    ["unproved-statement", "prd.md", Option.some(7), "warning"],
    ["unproved-statement", "prd.md", Option.some(8), "warning"],
  ]);
  expect(Array.some(found, ({ message }) => String.includes("prd.saved-views#v3")(message))).toBe(
    false,
  );
});

const unproved = (tests: Parameters<typeof indexOf>[0]) =>
  Array.map(
    Array.filter(
      run(PRD, Option.none(), Option.some(indexOf(tests))),
      ({ rule }) => rule === "unproved-statement",
    ),
    ({ line }) => line,
  );

it("unproved-statement counts a test of a section that implements the owner, and no other", () => {
  expect(
    unproved([{ proves: ["prd.saved-views#v1", "prd.saved-views#v2"], section: "spec.views" }]),
  ).toEqual([]);
  expect(unproved([{ proves: ["prd.saved-views#v1"], section: "spec.views" }])).toEqual([
    Option.some(8),
  ]);
  expect(
    unproved([{ proves: ["prd.saved-views#v1", "prd.saved-views#v2"], section: "spec.share" }]),
  ).toEqual([Option.some(7), Option.some(8)]);
});

it("unproved-statement is not reported without an index", () => {
  expect(
    Array.some(run(PRD, Option.none(), Option.none()), ({ rule }) => rule === "unproved-statement"),
  ).toBe(false);
});

it("task-without-statement fires on a task whose PRD sections have no statement", () => {
  const found = Array.filter(
    run(
      PRD,
      Option.some(manifestOf([task("t1", ["prd.saved-views"]), task("t2", ["prd.sharing"])])),
      Option.none(),
    ),
    ({ rule }) => rule === "task-without-statement",
  );
  expect(Array.map(found, place)).toEqual([
    ["task-without-statement", "manifest.json", Option.none(), "warning"],
  ]);
  expect(found[0]?.message).toContain("t2");
});

it("all three are warnings, so a plan with only these findings has no error", () => {
  const findings = lint(
    PRD,
    SPEC,
    Option.some(manifestOf([task("t1", ["prd.sharing"])])),
    { humanPaths: [] },
    Option.some(indexOf([])),
  );
  const found = Array.filter(findings, ({ rule }) => Array.contains(RULES, rule));
  expect(Array.map(found, ({ rule }) => rule)).toEqual([
    "draft-statement",
    "unproved-statement",
    "unproved-statement",
    "task-without-statement",
  ]);
  expect(Array.every(found, ({ severity }) => severity === "warning")).toBe(true);
});

// Task categories (spec.planning.task-categories).

const CATEGORY_PRD = Array.join(["# Product {#prd.product}", "", "## Goal {#prd.goal}", ""], "\n");
const CATEGORY_SPEC = Array.join(
  [
    "# Spec {#spec.spec}",
    "",
    "- Implements: `prd.goal`",
    "",
    "## Store {#spec.store}",
    "",
    "- Implements: `prd.goal`",
    "",
  ],
  "\n",
);

const config = { categories: defaultConfig.categories, humanPaths: [] };
const names = Array.map(config.categories, ({ name }) => name);

/** A manifest of one task, with `category` when given. */
const categoryManifestOf = (category: string | undefined) =>
  Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature: "product",
    tasks: [
      {
        branch: "product/01-store",
        commits: [],
        dependsOn: [],
        files: [],
        humanGate: { reasons: [], required: false },
        id: "t1",
        model: "sonnet",
        parent: null,
        prdSections: ["prd.goal"],
        reasoning: "high",
        sessions: [],
        specSections: ["spec.store"],
        status: "pending",
        title: "Add the store",
        worktree: null,
        ...(category === undefined ? {} : { category }),
      },
    ],
    version: 1,
  });

const categoryFindings = (
  category: string | undefined,
  withConfig: Parameters<typeof lint>[3] = config,
): ReadonlyArray<Finding> =>
  Array.filter(
    lint(CATEGORY_PRD, CATEGORY_SPEC, Option.some(categoryManifestOf(category)), withConfig),
    ({ rule }) => rule === "unknown-category" || rule === "missing-category",
  );

it.prop("a category in the config's list is no finding", [Schema.Literals(names)], ([category]) => {
  expect(categoryFindings(category)).toEqual([]);
});

it.prop(
  "a category outside the config's list is an unknown-category error that names it",
  [Schema.NonEmptyString.check(Schema.makeFilter((text: string) => !Array.contains(names, text)))],
  ([category]) => {
    const [only, ...rest] = categoryFindings(category);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      file: "manifest.json",
      rule: "unknown-category",
      severity: "error",
    });
    expect(only?.message).toContain(category);
  },
);

it("a task with no category is a missing-category warning, and an old manifest still lints", () => {
  expect(categoryFindings(undefined)).toMatchObject([
    {
      file: "manifest.json",
      message: "t1 has no category.",
      rule: "missing-category",
      severity: "warning",
    },
  ]);
});

it("a category the config adds stops being unknown", () => {
  const added = Struct.assign({
    categories: Array.append(config.categories, {
      description: "Infrastructure",
      name: Schema.decodeSync(Slug)("infra"),
    }),
  })(config);
  expect(categoryFindings("infra")).toHaveLength(1);
  expect(categoryFindings("infra", added)).toEqual([]);
});

it("a config with no categories checks none", () => {
  expect(categoryFindings("infra", { humanPaths: [] })).toEqual([]);
});
