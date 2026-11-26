import { IndexedSection, Manifest } from "@cairn/contract";
import type { SpecIndex } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String } from "effect";

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
