import { readFileSync } from "node:fs";

import { Manifest } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Result, Schema, String, pipe } from "effect";

import {
  STACKS_CLOSE,
  STACKS_OPEN,
  lint,
  mermaidBlocksOf,
  withStackDiagram,
  withoutMermaidBlocks,
} from "../src/index.ts";
import type { Finding, LintFile, LintRule } from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const NO_GATES = { humanPaths: [] };
const PRD = "# Product {#prd.product}\n";
const SPEC = "# Spec {#spec.spec}\n\n- Context: `prd.product`\n";

const rulesOf = (findings: ReadonlyArray<Finding>, rule: LintRule) =>
  Array.filter(findings, (finding) => finding.rule === rule);

const NodeId = Schema.Literals(["a", "b", "c", "d", "e"]);
const Direction = Schema.Literals(["TD", "LR", "BT", "RL"]);
const Edges = Schema.Array(Schema.Tuple([NodeId, NodeId])).check(Schema.isMinLength(1));

/** A flowchart that draws when `broken` is false, and ends in half an edge when it is true. */
const diagram = (
  direction: string,
  edges: ReadonlyArray<readonly [string, string]>,
  broken: boolean,
) =>
  pipe(
    Array.map(edges, ([from, to]) => `  ${from} --> ${to}`),
    Array.appendAll(broken ? ["  a --"] : []),
    Array.join("\n"),
    (body) => `flowchart ${direction}\n${body}`,
  );

const fenced = (language: string, body: string) => `\`\`\`${language}\n${body}\n\`\`\``;

const Blocks = Schema.Array(
  Schema.Struct({ broken: Schema.Boolean, direction: Direction, edges: Edges }),
).check(Schema.isMinLength(1), Schema.isMaxLength(6));

/** A document of `head` and then, after a line of prose, each block. */
const documentOf = (head: string, blocks: typeof Blocks.Type) =>
  `${head}${Array.join(
    Array.map(blocks, ({ broken, direction, edges }) =>
      Array.join(["Prose.", "", fenced("mermaid", diagram(direction, edges, broken)), ""], "\n"),
    ),
    "\n",
  )}`;

/** The 1-based line of each opening fence of the document, in order. */
const fencesOf = (text: string) =>
  Array.filterMap(String.split(text, "\n"), (line, index) =>
    line === "```mermaid" ? Result.succeed(index + 1) : Result.failVoid,
  );

it.prop(
  "a Mermaid block that does not draw is a bad-diagram error at its fence, in the file it is in",
  { blocks: Blocks, inSpec: Schema.Boolean },
  ({ blocks, inSpec }) => {
    const file: LintFile = inSpec ? "spec.md" : "prd.md";
    const text = documentOf(inSpec ? SPEC : PRD, blocks);
    const fences = fencesOf(text);
    const findings = rulesOf(
      lint(inSpec ? PRD : text, inSpec ? text : SPEC, Option.none(), NO_GATES),
      "bad-diagram",
    );
    expect(
      Array.map(findings, (finding) => [finding.file, finding.line, finding.severity]),
    ).toEqual(
      Array.map(
        Array.filter(fences, (_, index) => blocks[index]?.broken === true),
        (line) => [file, Option.some(line), "error"],
      ),
    );
    expect(
      Array.every(findings, (finding) => String.includes("does not draw")(finding.message)),
    ).toBe(true);
  },
);

it("a Mermaid block in a list item is found and drawn", () => {
  const spec = `${SPEC}\n- Item:\n\n  \`\`\`mermaid\n  flowchart TD\n    a --\n  \`\`\`\n`;
  const found = rulesOf(lint(PRD, spec, Option.none(), NO_GATES), "bad-diagram");
  expect(Array.map(found, (finding) => finding.line)).toEqual([Option.some(7)]);
});

it("a fence quoted inside a longer fence does not end it, so the block after it is still checked", () => {
  const spec = Array.join(
    [
      SPEC,
      "````text",
      fenced("mermaid", "flowchart TD\n  a --"),
      "````",
      "",
      fenced("mermaid", "flowchart TD\n  a --"),
    ],
    "\n",
  );
  const found = rulesOf(lint(PRD, spec, Option.none(), NO_GATES), "bad-diagram");
  expect(Array.map(found, (finding) => finding.line)).toEqual([Option.some(12)]);
});

it("a fence that is not Mermaid, or sits inside another fence, is not drawn", () => {
  const spec = Array.join(
    [
      SPEC,
      fenced("ts", "const x: = ;"),
      "",
      "~~~text",
      "not a diagram",
      "~~~",
      "",
      fenced("markdown", fenced("mermaid", "not a diagram")),
    ],
    "\n",
  );
  expect(rulesOf(lint(PRD, spec, Option.none(), NO_GATES), "bad-diagram")).toEqual([]);
});

const Segments = Schema.Array(Schema.Literals(["prose", "mermaid", "code", "tilde"])).check(
  Schema.isMaxLength(8),
);

const segment = {
  code: fenced("ts", "const a = 1;"),
  mermaid: fenced("mermaid", "flowchart TD\n  a --> b"),
  prose: "Some prose.",
  tilde: "~~~mermaid\nflowchart TD\n  a --> b\n~~~",
} as const;

const join = (kept: ReadonlyArray<keyof typeof segment>) =>
  Array.join(
    Array.map(kept, (name) => segment[name]),
    "\n",
  );

it.prop(
  "withoutMermaidBlocks leaves exactly the lines outside the Mermaid blocks",
  { segments: Segments },
  ({ segments }) => {
    const document = join(segments);
    const blocks = mermaidBlocksOf(document);
    const drawn = Array.filter(segments, (name) => name === "mermaid" || name === "tilde");
    expect(Array.length(blocks)).toBe(Array.length(drawn));
    expect(Array.every(blocks, (block) => block.source === "flowchart TD\n  a --> b")).toBe(true);
    expect(withoutMermaidBlocks(document, blocks)).toBe(
      join(Array.filter(segments, (name) => name === "prose" || name === "code")),
    );
  },
);

it("a Mermaid block with no closing fence runs to the end of the document", () => {
  const [block] = mermaidBlocksOf("Intro.\n```mermaid\nflowchart TD\n  a --> b\n");
  expect(block).toEqual({ end: 5, source: "flowchart TD\n  a --> b\n", start: 1 });
});

const PLAN = Schema.decodeSync(Schema.fromJsonString(Manifest))(repo(".cairn/manifest.json"));

it("this repository's plan has no bad-diagram or diagram-drift finding", () => {
  const findings = lint(repo(".cairn/prd.md"), repo(".cairn/spec.md"), Option.some(PLAN), {
    humanPaths: [],
  });
  expect(rulesOf(findings, "bad-diagram")).toEqual([]);
  expect(rulesOf(findings, "diagram-drift")).toEqual([]);
});

const task = (number: number, parent: string | null, dependsOn: ReadonlyArray<string>) => ({
  branch: `product/0${number}-store`,
  commits: [],
  dependsOn,
  files: ["src/store.ts"],
  humanGate: { reasons: [], required: false },
  id: `t${number}`,
  model: "sonnet",
  parent,
  prdSections: ["prd.product"],
  reasoning: "high",
  sessions: [],
  specSections: ["spec.spec"],
  status: "pending",
  title: `Task ${number}`,
  worktree: null,
});

const SMALL = Schema.decodeUnknownSync(Manifest)({
  baseBranch: "main",
  feature: "product",
  tasks: [task(1, null, []), task(2, "t1", ["t1"]), task(3, null, ["t1"])],
  version: 1,
});

const drawnSpec = withStackDiagram(SPEC, SMALL);
const drawnLines = String.split(drawnSpec, "\n");
const opening = Option.getOrThrow(Array.findFirstIndex(drawnLines, (line) => line === STACKS_OPEN));
const closing = Option.getOrThrow(
  Array.findFirstIndex(drawnLines, (line) => line === STACKS_CLOSE),
);

it("a spec drawn from the manifest has no diagram-drift finding", () => {
  expect(rulesOf(lint(PRD, drawnSpec, Option.some(SMALL), NO_GATES), "diagram-drift")).toEqual([]);
});

it.prop(
  "editing any line between the markers is a diagram-drift error at that line",
  { offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
  ({ offset }) => {
    const at = opening + 1 + (offset % (closing - opening - 1));
    const edited = Array.join(
      Array.map(drawnLines, (line, index) => (index === at ? `${line} edited` : line)),
      "\n",
    );
    const found = rulesOf(lint(PRD, edited, Option.some(SMALL), NO_GATES), "diagram-drift");
    expect(Array.map(found, (finding) => [finding.file, finding.line, finding.severity])).toEqual([
      ["spec.md", Option.some(at + 1), "error"],
    ]);
    expect(Array.every(found, (finding) => String.includes("cairn plan")(finding.message))).toBe(
      true,
    );
    expect(
      rulesOf(
        lint(PRD, withStackDiagram(edited, SMALL), Option.some(SMALL), NO_GATES),
        "diagram-drift",
      ),
    ).toEqual([]);
  },
);

it("a spec with no markers has drifted from a manifest, and from no manifest has not", () => {
  const spec = repo(".cairn/spec.md");
  const bare = Array.join(
    Array.filter(String.split(spec, "\n"), (line) => line !== STACKS_OPEN && line !== STACKS_CLOSE),
    "\n",
  );
  expect(
    Array.length(
      rulesOf(lint(repo(".cairn/prd.md"), bare, Option.some(PLAN), NO_GATES), "diagram-drift"),
    ),
  ).toBe(1);
  expect(rulesOf(lint(PRD, SPEC, Option.none(), NO_GATES), "diagram-drift")).toEqual([]);
  expect(rulesOf(lint(PRD, bare, Option.none(), NO_GATES), "diagram-drift")).toEqual([]);
});
