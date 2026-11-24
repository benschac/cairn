import { PrdSectionId, SpecSectionId } from "@cairn/contract";
import { SectionId } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Schema } from "effect";

import { gateOf, matchesPath, patternsMatching, sectionsOf } from "../src/index.ts";

const Segment = Schema.Literals(["db", "src", "auth", "migrations", "infra", "app"]);
const Directory = Schema.Array(Segment).check(Schema.isMinLength(1), Schema.isMaxLength(4));
const Name = Schema.Literals(["001", "schema", "index", "readme"]);
const Extension = Schema.Literals(["sql", "ts", "md"]);

const joined = (segments: readonly string[]) => Array.join(segments, "/");

it.prop(
  "a pattern without a slash matches the file name in any directory",
  { directory: Directory, extension: Extension, name: Name },
  ({ directory, extension, name }) => {
    const file = `${joined(directory)}/${name}.${extension}`;
    expect(matchesPath(`*.${extension}`, file)).toBe(true);
    expect(matchesPath(`*.${extension}`, `${name}.${extension}`)).toBe(true);
    expect(matchesPath(`${name}.${extension}`, file)).toBe(true);
  },
);

it.prop(
  "a pattern without a slash does not match another extension or a directory name",
  { directory: Directory, name: Name },
  ({ directory, name }) => {
    expect(matchesPath("*.sql", `${joined(directory)}/${name}.ts`)).toBe(false);
    expect(matchesPath("db", `db/${name}.sql`)).toBe(false);
  },
);

it.prop(
  "a pattern with a slash matches the whole path, not the file name",
  { directory: Directory, name: Name },
  ({ directory, name }) => {
    const file = `${joined(directory)}/${name}.sql`;
    expect(matchesPath("zzz/*.sql", file)).toBe(false);
    expect(matchesPath(`${joined(directory)}/*.sql`, file)).toBe(true);
    expect(matchesPath(`${joined(directory)}/**`, file)).toBe(true);
  },
);

it.prop(
  "a declared directory matches when a file inside it would",
  { directory: Directory, name: Name },
  ({ directory, name }) => {
    const dir = joined(directory);
    expect(matchesPath(`${dir}/**`, `${dir}/`)).toBe(true);
    expect(matchesPath(`${dir}/**`, `${dir}/${name}.ts`)).toBe(true);
    expect(matchesPath(`${dir}/**`, `other/${dir}/`)).toBe(false);
  },
);

it("matches the default high-trust patterns", () => {
  expect(matchesPath("**/migrations/**", "db/migrations/")).toBe(true);
  expect(matchesPath("**/migrations/**", "migrations/001.sql")).toBe(true);
  expect(matchesPath("**/auth/**", "packages/api/auth/session.ts")).toBe(true);
  expect(matchesPath("infra/**", "infra/")).toBe(true);
  expect(matchesPath("infra/**", "apps/infra/main.ts")).toBe(false);
  expect(matchesPath("*.sql", "db/001.sql")).toBe(true);
});

it.prop(
  "patternsMatching returns the matching patterns in their own order, each once per pattern",
  {
    files: Schema.Array(Schema.String),
    patterns: Schema.Array(Schema.Literals(["*.sql", "*.ts", "db/**", "infra/**", "**/auth/**"])),
  },
  ({ files, patterns }) => {
    const matched = patternsMatching(patterns, files);
    expect(matched).toStrictEqual(
      Array.filter(patterns, (pattern) => Array.some(files, (file) => matchesPath(pattern, file))),
    );
    expect(patternsMatching(patterns, [])).toStrictEqual([]);
  },
);

it("patternsMatching names only the patterns a path hits", () => {
  expect(
    patternsMatching(["*.sql", "infra/**", "**/auth/**"], ["db/001.sql", "src/app.ts"]),
  ).toStrictEqual(["*.sql"]);
  expect(patternsMatching(["*.sql"], [])).toStrictEqual([]);
});

const PrdName = Schema.Literals(["prd.goal", "prd.human-gates", "prd.viewer"]);
const decodePrd = Schema.decodeSync(PrdSectionId);
const decodeSpec = Schema.decodeSync(SpecSectionId);

const Pattern = Schema.Literals(["*.sql", "**/migrations/**", "infra/**", "**/auth/**"]);
const File = Schema.Literals([
  "db/001.sql",
  "db/migrations/",
  "infra/main.ts",
  "packages/api/auth/session.ts",
  "src/app.ts",
  "README.md",
]);

const decodeId = Schema.decodeSync(SectionId);

const sectionOf = (id: string | undefined, human: boolean): Section => ({
  body: "",
  human,
  id: id === undefined ? undefined : decodeId(id),
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: [] },
  level: 2,
  line: 1,
  parent: undefined,
  title: "A section",
});

const taskOf = (files: readonly string[], prd: string, spec: string) => ({
  files,
  prdSections: [decodePrd(prd)] as const,
  specSections: [decodeSpec(spec)] as const,
});

const Hits = {
  changed: Schema.Array(File),
  files: Schema.Array(File),
  patterns: Schema.Array(Pattern),
};

it.prop(
  "an untagged task is gated by exactly the patterns its files or its changed files match",
  Hits,
  ({ changed, files, patterns }) => {
    const gate = gateOf(
      taskOf(files, "prd.goal", "spec.format"),
      [],
      { humanPaths: patterns },
      changed,
    );
    const hits = Array.filter(Array.dedupe(patterns), (pattern) =>
      Array.some(Array.appendAll(files, changed), (file) => matchesPath(pattern, file)),
    );
    expect(gate.reasons).toStrictEqual(Array.map(hits, (pattern) => `path:${pattern}`));
    expect(gate.required).toBe(Array.isReadonlyArrayNonEmpty(hits));
  },
);

it.prop(
  "a hit after commit adds reasons and never removes one the plan found",
  Hits,
  ({ changed, files, patterns }) => {
    const task = taskOf(files, "prd.goal", "spec.format");
    const config = { humanPaths: patterns };
    const planned = gateOf(task, [], config, []);
    const actual = gateOf(task, [], config, changed);
    expect(Array.every(planned.reasons, (reason) => Array.contains(actual.reasons, reason))).toBe(
      true,
    );
    expect(planned.required && !actual.required).toBe(false);
  },
);

it("a change to a gated path after commit gates a task the plan did not", () => {
  const task = taskOf(["src/app.ts"], "prd.goal", "spec.format");
  const config = { humanPaths: ["**/migrations/**", "*.sql"] };
  expect(gateOf(task, [], config, [])).toStrictEqual({ reasons: [], required: false });
  expect(gateOf(task, [], config, ["db/migrations/001.sql"])).toStrictEqual({
    reasons: ["path:**/migrations/**", "path:*.sql"],
    required: true,
  });
});

it.prop(
  "a task is tagged exactly when a section it links has the human tag, however many sections do",
  {
    others: Schema.Array(Schema.Struct({ human: Schema.Boolean, id: PrdName })),
    prdHuman: Schema.Boolean,
    specHuman: Schema.Boolean,
  },
  ({ others, prdHuman, specHuman }) => {
    // the task links prd.goal and spec.format; every other section is unlinked and may be tagged
    const unlinked = Array.map(
      Array.filter(others, ({ id }) => id !== "prd.goal"),
      ({ human, id }) => sectionOf(id, human),
    );
    const sections = Array.appendAll(unlinked, [
      sectionOf("prd.goal", prdHuman),
      sectionOf("spec.format", specHuman),
      sectionOf("spec.gates", true),
    ]);
    const gate = gateOf(taskOf([], "prd.goal", "spec.format"), sections, { humanPaths: [] }, []);
    expect(gate).toStrictEqual(
      prdHuman || specHuman
        ? { reasons: ["tag:human"], required: true }
        : { reasons: [], required: false },
    );
  },
);

it.prop(
  "the tag reason comes before the path reasons and appears once",
  Hits,
  ({ changed, files, patterns }) => {
    const sections = [sectionOf("prd.human-gates", true), sectionOf("spec.gates.detection", true)];
    const gate = gateOf(
      taskOf(files, "prd.human-gates", "spec.gates.detection"),
      sections,
      { humanPaths: patterns },
      changed,
    );
    expect(gate.required).toBe(true);
    expect(Array.take(gate.reasons, 1)).toStrictEqual(["tag:human"]);
    expect(Array.filter(gate.reasons, (reason) => reason === "tag:human")).toHaveLength(1);
  },
);

it("a section without an id never gates a task", () => {
  expect(
    gateOf(
      taskOf([], "prd.goal", "spec.format"),
      [sectionOf(undefined, true)],
      { humanPaths: [] },
      [],
    ),
  ).toStrictEqual({ reasons: [], required: false });
});

it("a section inherits the tag from the heading above it, as sectionsOf reads it", () => {
  const sections = sectionsOf(
    Array.join(
      [
        "# Gates {#spec.gates}",
        "",
        "<!-- human -->",
        "",
        "## Detection {#spec.gates.detection}",
        "",
        "## Format {#spec.format}",
      ],
      "\n",
    ),
  );
  const config = { humanPaths: [] };
  expect(
    gateOf(taskOf([], "prd.goal", "spec.gates.detection"), sections, config, []).reasons,
  ).toStrictEqual(["tag:human"]);
  expect(gateOf(taskOf([], "prd.goal", "spec.format"), sections, config, []).reasons).toStrictEqual(
    ["tag:human"],
  );
});
