import { Manifest } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String } from "effect";

import { lint } from "../src/index.ts";
import type { Finding, LintRule } from "../src/index.ts";

/** `prd.cli` is on line 3, and item `k` of its list is on line `5 + k`. */
const prdOf = (items: ReadonlyArray<string>) =>
  `# Product {#prd.product}\n\n## CLI {#prd.cli}\n\n${Array.join(items, "\n")}\n`;

const itemLine = (index: number) => 5 + index;

const itemId = (index: number) => `prd.cli.item-${index}`;

const itemsOf = (count: number) =>
  Array.makeBy(count, (index) => `- Item number ${index} {#${itemId(index)}}`);

/** One spec section per key, each naming its IDs; a key with no IDs is not written. */
const specOf = (keys: Record<"Context" | "Defers" | "Implements", ReadonlyArray<string>>) =>
  `# Spec {#spec.spec}\n\n${Array.join(
    Array.getSomes(
      Array.map(["Implements", "Defers", "Context"] as const, (key) =>
        Array.isReadonlyArrayNonEmpty(keys[key])
          ? Option.some(
              `## Plan ${key} {#spec.plan-${String.toLowerCase(key)}}\n\n- ${key}: ${Array.join(
                Array.map(keys[key], (id) => `\`${id}\``),
                ", ",
              )}\n`,
            )
          : Option.none(),
      ),
    ),
    "\n",
  )}`;

const NO_GATES = { humanPaths: [] };

const only = (findings: ReadonlyArray<Finding>, rule: LintRule) =>
  Array.filter(findings, (finding) => finding.rule === rule);

const decodeManifest = Schema.decodeUnknownSync(Manifest);

const manifestOf = (prd: string, gate: { reasons: string[]; required: boolean }) =>
  decodeManifest({
    baseBranch: "main",
    feature: "cairn-mvp",
    tasks: [
      {
        branch: "cairn-mvp/01-task",
        commits: [],
        dependsOn: [],
        files: [],
        humanGate: gate,
        id: "t1",
        model: "sonnet",
        parent: null,
        prdSections: [prd],
        reasoning: "high",
        sessions: [],
        specSections: ["spec.plan-implements"],
        status: "pending",
        title: "Task 1",
        worktree: null,
      },
    ],
    version: 1,
  });

const Key = Schema.Literals(["none", "Implements", "Defers", "Context"]);

it.prop(
  "an item is covered when a key names it, or a Defers or Context names what it sits under, but not an Implements of its section",
  {
    items: Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
    section: Key,
  },
  ({ items, section }) => {
    const named = (key: "Context" | "Defers" | "Implements") =>
      Array.appendAll(
        Array.getSomes(
          Array.map(items, (item, index) =>
            item === key ? Option.some(itemId(index)) : Option.none(),
          ),
        ),
        section === key ? ["prd.cli"] : [],
      );
    const findings = lint(
      prdOf(itemsOf(Array.length(items))),
      specOf({
        Context: named("Context"),
        Defers: named("Defers"),
        Implements: named("Implements"),
      }),
      Option.none(),
      NO_GATES,
    );
    const uncovered = Array.filter(
      Array.range(0, Array.length(items) - 1),
      (index) =>
        Array.getUnsafe(items, index) === "none" && section !== "Defers" && section !== "Context",
    );
    expect(Array.map(only(findings, "unmapped-item"), ({ line }) => line)).toEqual(
      Array.map(uncovered, (index) => Option.some(itemLine(index))),
    );
    expect(
      Array.every(only(findings, "unmapped-item"), ({ severity }) => severity === "error"),
    ).toBe(true);
    // a section whose item is named is covered, and one with nothing named is not
    const sectionUncovered = section === "none" && Array.every(items, (item) => item === "none");
    expect(
      Array.some(only(findings, "unmapped-section"), ({ message }) =>
        String.startsWith("prd.cli ")(message),
      ),
    ).toBe(sectionUncovered);
  },
);

it("a PRD with prd.cli implemented and an item that nothing names gives unmapped-item", () => {
  const prd = prdOf(["- Lint the plan. {#prd.cli.lint}"]);
  const found = only(
    lint(
      prd,
      specOf({ Context: [], Defers: [], Implements: ["prd.cli"] }),
      Option.none(),
      NO_GATES,
    ),
    "unmapped-item",
  );
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ file: "prd.md", line: Option.some(5), severity: "error" });
  expect(found[0]?.message).toContain("prd.cli.lint");
  const silenced = [
    specOf({ Context: ["prd.cli"], Defers: [], Implements: [] }),
    specOf({ Context: [], Defers: ["prd.cli"], Implements: [] }),
    specOf({ Context: [], Defers: [], Implements: ["prd.cli.lint"] }),
  ];
  Array.forEach(silenced, (spec) => {
    expect(only(lint(prd, spec, Option.none(), NO_GATES), "unmapped-item")).toEqual([]);
  });
});

it("a Defers or Context on an item covers the items nested under it, and an Implements does not", () => {
  const prd = prdOf([
    "- Lint the plan. {#prd.cli.lint}",
    "  - Check IDs. {#prd.cli.ids}",
    "    - Check prefixes {#prd.cli.prefixes}",
  ]);
  const unmapped = (key: "Context" | "Defers" | "Implements") =>
    Array.map(
      only(
        lint(
          prd,
          specOf({ Context: [], Defers: [], Implements: [], [key]: ["prd.cli.lint"] }),
          Option.none(),
          NO_GATES,
        ),
        "unmapped-item",
      ),
      ({ line }) => line,
    );
  expect(unmapped("Defers")).toEqual([]);
  expect(unmapped("Context")).toEqual([]);
  expect(unmapped("Implements")).toEqual([Option.some(6), Option.some(7)]);
});

it("a task or a key that names an item the PRD no longer has is unknown-section, and one that names it is not", () => {
  const spec = specOf({ Context: [], Defers: [], Implements: ["prd.cli.lint"] });
  const present = prdOf(["- Lint the plan. {#prd.cli.lint}"]);
  const deleted = prdOf(["- Lint the plan."]);
  const manifest = Option.some(manifestOf("prd.cli.lint", { reasons: [], required: false }));
  expect(only(lint(present, spec, manifest, NO_GATES), "unknown-section")).toEqual([]);
  const missing = only(lint(deleted, spec, manifest, NO_GATES), "unknown-section");
  expect(Array.map(missing, ({ file }) => file)).toEqual(["spec.md", "manifest.json"]);
  expect(Array.every(missing, ({ message }) => String.includes("prd.cli.lint")(message))).toBe(
    true,
  );
});

it("an item's ID is a duplicate of a heading's or another item's, and has the wrong prefix in the wrong file", () => {
  const prd = prdOf([
    "- One {#prd.cli.same}",
    "- Two {#prd.cli.same}",
    "- Three {#prd.cli}",
    "- Four {#spec.cli.four}",
  ]);
  const findings = lint(
    prd,
    specOf({ Context: ["prd.cli"], Defers: [], Implements: [] }),
    Option.none(),
    NO_GATES,
  );
  expect(Array.map(only(findings, "duplicate-id"), ({ line }) => line)).toEqual([
    Option.some(6),
    Option.some(7),
  ]);
  expect(Array.map(only(findings, "wrong-prefix"), ({ line }) => line)).toEqual([Option.some(8)]);
});

it("a task that names a human item must be gated, as plan-time detection finds", () => {
  const prd = prdOf(["- Approve a plan <!-- human --> {#prd.cli.approve}"]);
  const spec = specOf({ Context: [], Defers: [], Implements: ["prd.cli.approve"] });
  const gates = (gate: { reasons: string[]; required: boolean }) =>
    Array.map(
      only(
        lint(prd, spec, Option.some(manifestOf("prd.cli.approve", gate)), NO_GATES),
        "gate-mismatch",
      ),
      ({ message }) => message,
    );
  expect(gates({ reasons: [], required: false })).toEqual([
    "t1's gate is not required, but plan-time detection finds required (tag:human).",
  ]);
  expect(gates({ reasons: ["tag:human"], required: true })).toEqual([]);
});

it("a spec item's ID is checked as a heading's is: it can be a duplicate or have the wrong prefix", () => {
  const spec = `# Spec {#spec.spec}\n\n## Plan {#spec.plan}\n\n- Do one thing {#spec.plan}\n- Do two {#prd.plan.two}\n`;
  const findings = lint(prdOf([]), spec, Option.none(), NO_GATES);
  expect(Array.map(only(findings, "duplicate-id"), ({ file, line }) => [file, line])).toEqual([
    ["spec.md", Option.some(5)],
  ]);
  expect(Array.map(only(findings, "wrong-prefix"), ({ file, line }) => [file, line])).toEqual([
    ["spec.md", Option.some(6)],
  ]);
});
