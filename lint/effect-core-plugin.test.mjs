// Proves the Effect core rules fire on native patterns and stay quiet on the Effect ones:
// the core/* rules in lint/effect-core-plugin.mjs through the root oxlint.config.ts, and the
// @effect/tsgo diagnostics each tsconfig turns on. Run with: node --test lint/
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name) => join(root, "node_modules", ".bin", name);
const effect = "import { Array, Effect, Order } from 'effect'\n";

// [name, source, the core rule it must trip or null]
const lintCases = [
  [
    "native sort with comparator",
    `${effect}export const f = (xs: number[]) => [...xs].sort((a, b) => a - b)`,
    "no-native-sort",
  ],
  [
    "native toSorted",
    `${effect}export const f = (xs: number[]) => xs.toSorted((a, b) => a - b)`,
    "no-native-sort",
  ],
  [
    "Array.sort with Order",
    `${effect}export const f = (xs: number[]) => Array.sort(xs, Order.Number)`,
    null,
  ],
  [
    "sort outside Effect code",
    "export const f = (xs: number[]) => [...xs].sort((a, b) => a - b)",
    null,
  ],
  [
    "spread Set dedupe",
    `${effect}export const f = (xs: number[]) => [...new Set(xs)]`,
    "no-set-dedupe",
  ],
  [
    "Array.from Set dedupe",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = (xs: number[]) => Array.from(new Set(xs))",
    "no-set-dedupe",
  ],
  [
    "spread Set of an Effect iterable",
    "import { Iterable } from 'effect'\nexport const f = (rows: { id: number | null }[]) => [...new Set(Iterable.flatMapNullishOr(rows, (row) => row.id))]",
    "no-set-dedupe",
  ],
  [
    "spread Set of a pair",
    `${effect}export const f = (a: number, b: number) => [...new Set([a, b])]`,
    "no-set-dedupe",
  ],
  [
    "spread Set with a typed Set",
    `${effect}export const f = (xs: number[]) => [...new Set<number>(xs)]`,
    "no-set-dedupe",
  ],
  [
    "spread Set beside other elements",
    `${effect}export const f = (xs: number[], ys: number[]) => [...new Set(xs), ...ys]`,
    "no-set-dedupe",
  ],
  [
    "spread Set inside a type assertion",
    `${effect}export const f = (xs: number[]) => [...(new Set(xs) as Set<number>)]`,
    "no-set-dedupe",
  ],
  [
    "Array.from Set with a mapper",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = (xs: number[]) => Array.from(new Set(xs), (x) => x + 1)",
    "no-set-dedupe",
  ],
  [
    "for-of over a new Set",
    `${effect}export const f = (xs: number[]) => { let n = 0; for (const x of new Set(xs)) n += x; return n }`,
    "no-set-dedupe",
  ],
  [
    "Set of concatenated spreads",
    `${effect}export const f = (xs: number[], ys: number[]) => new Set([...xs, ...ys])`,
    "no-set-dedupe",
  ],
  ["Set of a mixed list", `${effect}export const f = (xs: number[]) => new Set([0, ...xs])`, null],
  ["spread of a Set variable", `${effect}export const f = (ids: Set<number>) => [...ids]`, null],
  ["dedupe outside Effect code", "export const f = (xs: number[]) => [...new Set(xs)]", null],
  [
    "native sort of a spread Set variable",
    `${effect}export const f = (ids: Set<number>) => [...ids].sort((a, b) => a - b)`,
    "no-native-sort",
  ],
  ["Array.dedupe", `${effect}export const f = (xs: number[]) => Array.dedupe(xs)`, null],
  ["Set kept as a Set", `${effect}export const f = (xs: number[]) => new Set(xs)`, null],
  [
    "yield* in for-of",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () { const out: number[] = []; for (const x of xs) out.push(yield* Effect.succeed(x)); return out })`,
    "no-yield-in-loop",
  ],
  [
    "yield* in while",
    `${effect}export const f = Effect.gen(function* () { let n = 0; while (n < 3) n += yield* Effect.succeed(1); return n })`,
    "no-yield-in-loop",
  ],
  [
    "marked loop",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () {\n  // loop: stops at the first match\n  for (const x of xs) if ((yield* Effect.succeed(x)) > 1) return x\n  return 0\n})`,
    null,
  ],
  [
    "bare loop marker",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () {\n  // loop:\n  for (const x of xs) yield* Effect.succeed(x)\n})`,
    "no-yield-in-loop",
  ],
  [
    "yield* of the iterable",
    `${effect}export const f = Effect.gen(function* () { let n = 0; for (const x of yield* Effect.succeed([1, 2])) n += x; return n })`,
    null,
  ],
  [
    "Effect.forEach",
    `${effect}export const f = (xs: number[]) => Effect.forEach(xs, (x) => Effect.succeed(x))`,
    null,
  ],
  [
    "generator nested in a loop",
    `${effect}export const f = (xs: number[]) => { const out = []; for (const x of xs) out.push(Effect.gen(function* () { return yield* Effect.succeed(x) })); return out }`,
    null,
  ],
  [
    "yield* in a loop outside Effect code",
    "export function* f(xs: number[][]) { for (const x of xs) yield* x }",
    null,
  ],
];

// [tsconfig the fixture extends, name, source, the @effect/tsgo diagnostic it must report or null]
const tsgoCases = [
  [
    "tsconfig.base.json",
    "Date in Effect",
    `${effect}export const f = Effect.sync(() => Date.now())`,
    "globalDateInEffect",
  ],
  ["tsconfig.base.json", "Date outside Effect", "export const f = () => Date.now()", "globalDate"],
  [
    "tsconfig.base.json",
    "console outside Effect",
    "export const f = () => console.log(1)",
    "globalConsole",
  ],
  [
    "tsconfig.base.json",
    "JSON outside Effect",
    "export const f = (s: string): unknown => JSON.parse(s)",
    "globalJson",
  ],
  [
    "tsconfig.base.json",
    "native Error subclass",
    "export class Boom extends Error {}",
    "extendsNativeError",
  ],
  [
    "tsconfig.base.json",
    "try/catch in Effect.gen",
    `${effect}export const f = Effect.gen(function* () { try { return yield* Effect.succeed(1) } catch { return 0 } })`,
    "tryCatchInEffectGen",
  ],
  [
    "tsconfig.base.json",
    "Effect.all over map",
    `${effect}export const f = (xs: number[]) => Effect.all(xs.map((x) => Effect.succeed(x)))`,
    "allOfMapToForEach",
  ],
  [
    "tsconfig.base.json",
    "Clock in Effect",
    "import { Clock } from 'effect'\nexport const f = Clock.currentTimeMillis",
    null,
  ],
  [
    "packages/cli/tsconfig.json",
    "cli: Date in Effect",
    `${effect}export const f = Effect.sync(() => Date.now())`,
    "globalDateInEffect",
  ],
  [
    "packages/cli/tsconfig.json",
    "cli: Date outside Effect",
    "export const f = () => Date.now()",
    "globalDate",
  ],
  [
    "tsconfig.json",
    "scripts: Date in Effect",
    `${effect}export const f = Effect.sync(() => Date.now())`,
    "globalDateInEffect",
  ],
  ["tsconfig.json", "scripts: Date in a plain script", "export const f = () => Date.now()", null],
  [
    "tsconfig.json",
    "scripts: JSON in a plain script",
    "export const f = (s: string): unknown => JSON.parse(s)",
    null,
  ],
];

let dir;
const lintFound = new Map();
const tsgoFound = new Map();
const caseIndex = (path) => Number(/case-(\d+)\.ts$/.exec(path)?.[1] ?? -1);

// The fixtures live outside the repo, so a `pnpm lint` or `pnpm format:check` running beside
// this test never sees them. A node_modules link lets them resolve effect and @types/node.
const setup = async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "cairn-effect-core-")));
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
};

// The root config, linting fixtures in a project that extends tsconfig.base.json.
const lint = async () => {
  const project = join(dir, "oxlint");
  await mkdir(project);
  const files = lintCases.map((_, index) => `case-${index}.ts`);
  await Promise.all(
    lintCases.map(([, source], index) => writeFile(join(project, files[index]), source)),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    JSON.stringify({ extends: join(root, "tsconfig.base.json"), files, include: [] }),
  );
  const config = join(project, "oxlint.config.ts");
  const base = JSON.stringify(pathToFileURL(join(root, "oxlint.config.ts")).href);
  await writeFile(config, `export { default } from ${base};\n`);
  const result = spawnSync(bin("oxlint"), ["-c", config, "--format", "json", ...files], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, "oxlint failed to start");
  const { diagnostics, number_of_files: linted } = JSON.parse(result.stdout);
  assert.equal(linted, files.length, "every fixture must be linted");
  assert.ok(!diagnostics.some((d) => d.message.includes("Error running JS plugin")), result.stdout);
  const reported = files.map(() => []);
  for (const diagnostic of diagnostics)
    reported[caseIndex(diagnostic.filename)]?.push(diagnostic.code);
  for (const [index, [name]] of lintCases.entries()) lintFound.set(name, reported[index]);
};

const typecheck = async (extend, cases) => {
  const project = join(dir, extend.replaceAll("/", "-"));
  await mkdir(project);
  const files = cases.map((_, index) => `case-${index}.ts`);
  await Promise.all(
    cases.map(([, , source], index) => writeFile(join(project, files[index]), source)),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    JSON.stringify({ extends: join(root, extend), files, include: [] }),
  );
  const result = spawnSync(bin("effect-tsgo"), ["tsc", "--noEmit", "-p", project], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, "effect-tsgo failed to start");
  const reported = files.map(() => []);
  for (const line of result.stdout.split("\n")) {
    const match = /^(.*?)\(\d+,\d+\): error TS\d+: .* effect\((\w+)\)$/.exec(line);
    if (match) reported[caseIndex(match[1])]?.push(match[2]);
  }
  for (const [index, [, name]] of cases.entries()) tsgoFound.set(name, reported[index]);
};

before(async () => {
  await setup();
  const groups = Map.groupBy(tsgoCases, ([extend]) => extend);
  await Promise.all([lint(), ...Array.from(groups, ([extend, cases]) => typecheck(extend, cases))]);
});

after(() => rm(dir, { recursive: true, force: true }));

await test("core/* oxlint rules", (t) =>
  Promise.all(
    lintCases.map(([name, , expected]) =>
      t.test(name, () => {
        const core = lintFound.get(name).filter((code) => code.startsWith("core("));
        if (expected) assert.ok(core.includes(`core(${expected})`), JSON.stringify(core));
        else assert.deepEqual(core, []);
      }),
    ),
  ));

await test("@effect/tsgo diagnostics", (t) =>
  Promise.all(
    tsgoCases.map(([extend, name, , expected]) =>
      t.test(`${name} (${extend})`, () => {
        const found = tsgoFound.get(name);
        if (expected) assert.ok(found.includes(expected), JSON.stringify(found));
        else assert.deepEqual(found, []);
      }),
    ),
  ));
