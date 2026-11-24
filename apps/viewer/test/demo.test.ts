import { readFileSync } from "node:fs";

import { Manifest, SectionStatus, SpecIndexJson, TaskStatus, Trace } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Option, Schema, String } from "effect";
import { expect } from "vitest";

import { demoTrace } from "../src/demo.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const decodeManifest = Schema.decodeSync(Schema.fromJsonString(Manifest));
const decodeTrace = Schema.decodeUnknownOption(Trace);

/** The fixture as plain JSON, so a test can corrupt any field before decoding it. */
const fixture = Schema.decodeSync(Schema.fromJsonString(Schema.Any))(
  readFileSync(new URL("../src/demo-trace.json", import.meta.url), "utf8"),
);

const fencePattern = /^\s*(```|~~~)/u;
const headingIdPattern = /^#{1,6} .*\{#([^}]+)\}\s*$/u;

/** The `{#id}` headings of a document, skipping any inside a fenced code block. */
const headingIds = (markdown: string): ReadonlyArray<string> => {
  const [, ids] = Array.mapAccum(String.split(markdown, "\n"), false, (isFenced, line) => {
    const isInFence = fencePattern.test(line) ? !isFenced : isFenced;
    const maybeId = isInFence
      ? Option.none()
      : Option.flatMap(String.match(headingIdPattern)(line), (match) => Array.get(match, 1));
    return [isInFence, maybeId];
  });
  return Array.getSomes(ids);
};

const idsOf = (sections: ReadonlyArray<{ readonly id: string }>) =>
  Array.map(sections, (section) => section.id);

const progressOf = (task: { readonly id: string; readonly status: string }) => ({
  id: task.id,
  status: task.status,
});

/** Whether the Trace schema refuses the fixture after an edit. */
const refused = (edit: (copy: typeof fixture) => void) => {
  const copy = structuredClone(fixture);
  edit(copy);
  return Option.isNone(decodeTrace(copy));
};

it("the fixture decodes through the Trace schema", () => {
  expect(demoTrace.feature).toBe("cairn-mvp");
  expect(demoTrace.tasks.length).toBeGreaterThan(0);
});

it("every task in the manifest appears in the trace", () => {
  const manifest = decodeManifest(repo(".cairn/manifest.json"));
  const missing = Array.difference(
    Array.map(manifest.tasks, (task) => task.id),
    Array.map(demoTrace.tasks, (task) => task.id),
  );
  expect(missing).toEqual([]);
  expect(demoTrace.tasks.length).toBe(manifest.tasks.length);
});

it("the demo reports the manifest's task progress", () => {
  const manifest = decodeManifest(repo(".cairn/manifest.json"));
  expect(Array.map(demoTrace.tasks, progressOf)).toEqual(Array.map(manifest.tasks, progressOf));
});

it("the demo links each task to the manifest's recorded commits", () => {
  const manifest = decodeManifest(repo(".cairn/manifest.json"));
  expect(
    Array.map(demoTrace.tasks, (task) => ({
      id: task.id,
      commits: Array.map(task.commits, (commit) => commit.sha),
    })),
  ).toEqual(Array.map(manifest.tasks, (task) => ({ id: task.id, commits: task.commits })));
});

it.each([
  ["prd", ".cairn/prd.md", demoTrace.prd],
  ["spec", ".cairn/spec.md", demoTrace.spec],
] as const)(
  "every {#id} heading in the %s document appears in sections and in its list",
  (_name, path, doc) => {
    const ids = headingIds(repo(path));
    expect(ids.length).toBeGreaterThan(0);
    expect(doc.path).toBe(path);
    expect(doc.markdown).toBe(repo(path));
    expect(Array.difference(ids, idsOf(demoTrace.sections))).toEqual([]);
    expect(Array.difference(ids, idsOf(doc.sections))).toEqual([]);
    expect(doc.sections.length).toBe(ids.length);
  },
);

it("every spec section carries its summary from spec.json, and a PRD section none", () => {
  const index = Schema.decodeSync(SpecIndexJson)(repo(".cairn/spec.json"));
  const summaries = Array.map(index.sections, (section) => [section.id, section.summary] as const);
  expect(Array.map(demoTrace.spec.sections, (section) => [section.id, section.summary])).toEqual(
    summaries,
  );
  expect(Array.every(demoTrace.prd.sections, (section) => section.summary === null)).toBe(true);
});

it("a copy with a corrupted field is refused", () => {
  expect(
    refused((copy) => {
      copy.tasks[0].status = "in-progress";
    }),
  ).toBe(true);
  expect(
    refused((copy) => {
      copy.sections[0].id = "section.not-a-prefix";
    }),
  ).toBe(true);
  expect(
    refused((copy) => {
      const committed = Option.getOrThrow(
        Array.findFirst(copy.tasks, (task: typeof fixture) => Array.isArrayNonEmpty(task.commits)),
      );
      committed.commits[0].sha = "76aa977";
    }),
  ).toBe(true);
  expect(refused((copy) => copy.tasks)).toBe(false);
});

it.prop(
  "any task status the contract allows still decodes",
  { status: TaskStatus },
  ({ status }) => {
    expect(
      refused((copy) => {
        copy.tasks[0].status = status;
      }),
    ).toBe(false);
  },
);

it.prop(
  "any section status the contract allows still decodes",
  { status: SectionStatus },
  ({ status }) => {
    expect(
      refused((copy) => {
        copy.sections[0].status = status;
      }),
    ).toBe(false);
  },
);
