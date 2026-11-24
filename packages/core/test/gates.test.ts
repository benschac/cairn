import { expect, it } from "@effect/vitest";
import { Array, Schema } from "effect";

import { matchesPath, patternsMatching } from "../src/index.ts";

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
