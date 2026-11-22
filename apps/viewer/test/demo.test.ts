import { readFileSync } from "node:fs";

import { Manifest, SectionStatus, TaskStatus, Trace } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { demoTrace } from "../src/demo.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const fixture = JSON.parse(
  readFileSync(new URL("../src/demo-trace.json", import.meta.url), "utf8"),
);

/** The `{#id}` headings of a document, skipping any inside a fenced code block. */
const headingIds = (markdown: string): string[] => {
  const ids: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const match = /^#{1,6} .*\{#([^}]+)\}\s*$/u.exec(line);
    if (!fenced && match?.[1] !== undefined) ids.push(match[1]);
  }
  return ids;
};

const decodeCopy = (edit: (copy: typeof fixture) => void) => {
  const copy = structuredClone(fixture);
  edit(copy);
  return Schema.decodeUnknownSync(Trace)(copy);
};

/** Whether the Trace schema refuses the fixture after an edit. */
const refused = (edit: (copy: typeof fixture) => void) => {
  try {
    decodeCopy(edit);
    return false;
  } catch {
    return true;
  }
};

it("the fixture decodes through the Trace schema", () => {
  expect(demoTrace.feature).toBe("cairn-mvp");
  expect(demoTrace.tasks.length).toBeGreaterThan(0);
});

it("every task in the manifest appears in the trace", () => {
  const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(repo(".cairn/manifest.json")));
  const traced = new Set(demoTrace.tasks.map((task) => task.id));
  for (const task of manifest.tasks) expect(traced.has(task.id)).toBe(true);
  expect(demoTrace.tasks.length).toBe(manifest.tasks.length);
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
    const sectionIds = new Set<string>(demoTrace.sections.map((section) => section.id));
    const listed = new Set<string>(doc.sections.map((section) => section.id));
    for (const id of ids) {
      expect(sectionIds.has(id)).toBe(true);
      expect(listed.has(id)).toBe(true);
    }
    expect(doc.sections.length).toBe(ids.length);
  },
);

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
      copy.tasks[0].commits[0].sha = "76aa977";
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
