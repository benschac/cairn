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

// [name, source, every core rule it must trip: one name, a list, or null for none]. The test
// compares the whole set, so a case also proves the other core rules stay quiet.
const lintCases = [
  [
    "native sort with comparator",
    `${effect}export const f = (xs: number[]) => [...xs].sort((a, b) => a - b)`,
    ["no-array-spread", "no-native-sort"],
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
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "Array.from Set dedupe",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = (xs: number[]) => Array.from(new Set(xs))",
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "spread Set of an Effect iterable",
    "import { Iterable } from 'effect'\nexport const f = (rows: { id: number | null }[]) => [...new Set(Iterable.flatMapNullishOr(rows, (row) => row.id))]",
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "spread Set of a pair",
    `${effect}export const f = (a: number, b: number) => [...new Set([a, b])]`,
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "spread Set with a typed Set",
    `${effect}export const f = (xs: number[]) => [...new Set<number>(xs)]`,
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "spread Set beside other elements",
    `${effect}export const f = (xs: number[], ys: number[]) => [...new Set(xs), ...ys]`,
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "spread Set inside a type assertion",
    `${effect}export const f = (xs: number[]) => [...(new Set(xs) as Set<number>)]`,
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "Array.from Set with a mapper",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = (xs: number[]) => Array.from(new Set(xs), (x) => x + 1)",
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "for-of over a new Set",
    `${effect}export const f = (xs: number[]) => { let n = 0; for (const x of new Set(xs)) n += x; return n }`,
    ["no-native-collection", "no-native-loop", "no-set-dedupe"],
  ],
  [
    "Set of concatenated spreads",
    `${effect}export const f = (xs: number[], ys: number[]) => new Set([...xs, ...ys])`,
    ["no-array-spread", "no-native-collection", "no-set-dedupe"],
  ],
  [
    "Set of a mixed list",
    `${effect}export const f = (xs: number[]) => new Set([0, ...xs])`,
    ["no-array-spread", "no-native-collection"],
  ],
  [
    "spread of a Set variable",
    `${effect}export const f = (ids: Set<number>) => [...ids]`,
    "no-array-spread",
  ],
  ["dedupe outside Effect code", "export const f = (xs: number[]) => [...new Set(xs)]", null],
  [
    "native sort of a spread Set variable",
    `${effect}export const f = (ids: Set<number>) => [...ids].sort((a, b) => a - b)`,
    ["no-array-spread", "no-native-sort"],
  ],
  ["Array.dedupe", `${effect}export const f = (xs: number[]) => Array.dedupe(xs)`, null],
  [
    "Set kept as a Set",
    `${effect}export const f = (xs: number[]) => new Set(xs)`,
    "no-native-collection",
  ],
  [
    "yield* in for-of",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () { const out: number[] = []; for (const x of xs) out.push(yield* Effect.succeed(x)); return out })`,
    ["no-native-loop", "no-yield-in-loop"],
  ],
  [
    "yield* in while",
    `${effect}export const f = Effect.gen(function* () { let n = 0; while (n < 3) n += yield* Effect.succeed(1); return n })`,
    ["no-native-loop", "no-yield-in-loop"],
  ],
  [
    "marked loop",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () {\n  // loop: stops at the first match\n  for (const x of xs) if ((yield* Effect.succeed(x)) > 1) return x\n  return 0\n})`,
    null,
  ],
  [
    "bare loop marker",
    `${effect}export const f = (xs: number[]) => Effect.gen(function* () {\n  // loop:\n  for (const x of xs) yield* Effect.succeed(x)\n})`,
    ["no-native-loop", "no-yield-in-loop"],
  ],
  [
    "yield* of the iterable",
    `${effect}export const f = Effect.gen(function* () { let n = 0; for (const x of yield* Effect.succeed([1, 2])) n += x; return n })`,
    "no-native-loop",
  ],
  [
    "Effect.forEach",
    `${effect}export const f = (xs: number[]) => Effect.forEach(xs, (x) => Effect.succeed(x))`,
    null,
  ],
  [
    "generator nested in a loop",
    `${effect}export const f = (xs: number[]) => { const out = []; for (const x of xs) out.push(Effect.gen(function* () { return yield* Effect.succeed(x) })); return out }`,
    "no-native-loop",
  ],
  [
    "yield* in a loop outside Effect code",
    "export function* f(xs: number[][]) { for (const x of xs) yield* x }",
    null,
  ],
  [
    "new Map",
    `${effect}export const f = (xs: [string, number][]) => new Map(xs)`,
    "no-native-collection",
  ],
  ["empty new Set", `${effect}export const f = () => new Set<string>()`, "no-native-collection"],
  [
    "Map.groupBy",
    `${effect}export const f = (xs: number[]) => Map.groupBy(xs, (x) => x % 2)`,
    "no-native-collection",
  ],
  [
    "Object.groupBy",
    `${effect}export const f = (xs: number[]) => Object.groupBy(xs, (x) => String(x % 2))`,
    "no-native-collection",
  ],
  [
    "HashSet and Record",
    `import { HashSet, Record } from 'effect'\nexport const f = (xs: string[]) => [HashSet.fromIterable(xs), Record.fromIterableWith(xs, (x) => [x, 1])]`,
    null,
  ],
  ["WeakMap", `${effect}export const f = () => new WeakMap<object, number>()`, null],
  ["new Map outside Effect code", "export const f = () => new Map<string, number>()", null],
  [
    "spread concatenation",
    `${effect}export const f = (a: number[], b: number[]) => [...a, ...b]`,
    "no-array-spread",
  ],
  ["spread append", `${effect}export const f = (xs: number[]) => [...xs, 1]`, "no-array-spread"],
  ["spread prepend", `${effect}export const f = (xs: number[]) => [0, ...xs]`, "no-array-spread"],
  [
    "Array.from an iterable",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = (xs: Iterable<number>) => Array.from(xs)",
    "no-array-spread",
  ],
  [
    "Array.of",
    "import { Effect } from 'effect'\nexport const g = Effect.void\nexport const f = () => Array.of(1, 2)",
    "no-array-spread",
  ],
  [
    "Array.appendAll",
    `${effect}export const f = (a: number[], b: number[]) => Array.appendAll(a, b)`,
    null,
  ],
  [
    "spread call arguments and objects",
    `${effect}export const f = (xs: number[], o: { a: number }) => [Math.max(...xs), { ...o, b: 1 }]`,
    null,
  ],
  [
    "spread outside Effect code",
    "export const f = (a: number[], b: number[]) => [...a, ...b]",
    null,
  ],
  [
    "counting for loop",
    `${effect}export const f = (xs: number[]) => { let n = 0; for (let i = 0; i < xs.length; i++) n += 1; return n }`,
    "no-native-loop",
  ],
  [
    "for-of without effects",
    `${effect}export const f = (xs: number[]) => { let n = 0; for (const x of xs) n += x; return n }`,
    "no-native-loop",
  ],
  [
    "for-in",
    `${effect}export const f = (o: Record<string, number>) => { let n = 0; for (const k in o) n += k.length; return n }`,
    "no-native-loop",
  ],
  [
    "do-while",
    `${effect}export const f = () => { let n = 0; do n += 1; while (n < 3); return n }`,
    "no-native-loop",
  ],
  [
    "marked plain loop",
    `${effect}export const f = (xs: number[]) => {\n  let i = 0\n  // loop: walks back to the first non-blank line\n  while (i < xs.length && xs[i] === 0) i += 1\n  return i\n}`,
    null,
  ],
  [
    "marker two lines above",
    `${effect}export const f = (xs: number[]) => {\n  // loop: too far away\n  let n = 0\n  for (const x of xs) n += x\n  return n\n}`,
    "no-native-loop",
  ],
  [
    "Array.reduce",
    `${effect}export const f = (xs: number[]) => Array.reduce(xs, 0, (n, x) => n + x)`,
    null,
  ],
  [
    "loop outside Effect code",
    "export const f = (xs: number[]) => { let n = 0; for (const x of xs) n += x; return n }",
    null,
  ],
  [
    "switch statement",
    `${effect}export const f = (x: 'a' | 'b') => { switch (x) { case 'a': return 1; default: return 2 } }`,
    "no-switch",
  ],
  [
    "Match.value",
    `import { Match } from 'effect'\nexport const f = (x: 'a' | 'b') => Match.value(x).pipe(Match.when('a', () => 1), Match.orElse(() => 2))`,
    null,
  ],
  [
    "switch outside Effect code",
    "export const f = (x: 'a' | 'b') => { switch (x) { case 'a': return 1; default: return 2 } }",
    null,
  ],
  [
    "length === 0",
    `${effect}export const f = (xs: number[]) => xs.length === 0`,
    "no-length-check",
  ],
  [
    "0 === length",
    `${effect}export const f = (xs: number[]) => 0 === xs.length`,
    "no-length-check",
  ],
  ["length > 0", `${effect}export const f = (xs: number[]) => xs.length > 0`, "no-length-check"],
  ["length >= 1", `${effect}export const f = (xs: number[]) => xs.length >= 1`, "no-length-check"],
  ["length < 1", `${effect}export const f = (xs: number[]) => xs.length < 1`, "no-length-check"],
  ["negated length", `${effect}export const f = (xs: number[]) => !xs.length`, "no-length-check"],
  [
    "length compared with a count",
    `${effect}export const f = (xs: number[], s: string) => [xs.length === 2, xs.length > 1, s.length > 140]`,
    null,
  ],
  [
    "Array.isReadonlyArrayNonEmpty",
    `${effect}export const f = (xs: number[]) => Array.isReadonlyArrayNonEmpty(xs)`,
    null,
  ],
  ["length check outside Effect code", "export const f = (xs: number[]) => xs.length === 0", null],
  [
    "typeof string",
    `${effect}export const f = (x: unknown) => typeof x === 'string'`,
    "no-typeof-check",
  ],
  [
    "typeof on the right",
    `${effect}export const f = (x: unknown) => 'number' !== typeof x`,
    "no-typeof-check",
  ],
  ["typeof as a value", `${effect}export const f = (x: unknown) => typeof x`, null],
  [
    "Predicate.isString",
    `import { Predicate } from 'effect'\nexport const f = (x: unknown) => Predicate.isString(x)`,
    null,
  ],
  ["typeof outside Effect code", "export const f = (x: unknown) => typeof x === 'string'", null],
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
  [
    "tsconfig.base.json",
    "native array method",
    `${effect}export const f = (xs: number[]) => xs.map((x) => x + 1)`,
    "preferEffectArray",
  ],
  [
    "tsconfig.base.json",
    "Effect Array.map",
    `${effect}export const f = (xs: number[]) => Array.map(xs, (x) => x + 1)`,
    null,
  ],
  [
    "tsconfig.base.json",
    "native string method",
    "export const f = (s: string) => s.trim()",
    "preferEffectString",
  ],
  [
    "tsconfig.base.json",
    "Object.keys",
    "export const f = (r: Record<string, number>) => Object.keys(r)",
    "preferEffectRecord",
  ],
  [
    "tsconfig.base.json",
    "Object.entries",
    "export const f = (r: Record<string, number>) => Object.entries(r)",
    "preferEffectRecord",
  ],
  [
    "tsconfig.base.json",
    "number in a condition",
    "export const f = (xs: number[]) => (xs.length ? 1 : 0)",
    "strictBooleanExpressions",
  ],
  [
    "tsconfig.base.json",
    "string in a condition",
    "export const f = (s: string) => { if (s) return 1; return 0 }",
    "strictBooleanExpressions",
  ],
  [
    "tsconfig.base.json",
    "boolean condition",
    "export const f = (xs: number[], s: string) => (xs.length > 0 && s !== '' ? 1 : 0)",
    null,
  ],
  [
    "tsconfig.base.json",
    "file-level directive",
    `// @effect-diagnostics preferEffectArray:off -- a plain script\n${effect}export const f = (xs: number[]) => xs.map((x) => x + 1)`,
    null,
  ],
  [
    "packages/cli/tsconfig.json",
    "cli: native array method",
    `${effect}export const f = (xs: number[]) => xs.map((x) => x + 1)`,
    "preferEffectArray",
  ],
  [
    "tsconfig.json",
    "scripts: native array method",
    `${effect}export const f = (xs: number[]) => xs.map((x) => x + 1)`,
    "preferEffectArray",
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
        const core = new Set(lintFound.get(name).filter((code) => code.startsWith("core(")));
        const want = new Set([expected ?? []].flat().map((rule) => `core(${rule})`));
        assert.deepEqual(core, want);
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
