import { LinkFromPath, Manifest, SpecSectionId, TaskId, decodeLink } from "@cairn/contract";
import type { Sha } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Result,
  Schema,
  String,
} from "effect";
import { TestConsole } from "effect/testing";

import { DEFAULT_BASE, link } from "../src/commands/link.ts";
import { Git, GitHistory } from "../src/git.ts";
import { LinkArgError, pathOfArgs, stepsOfArgs } from "../src/link-args.ts";
import type { LinkPlan } from "../src/link-args.ts";
import { MainCheckout } from "../src/main-checkout.ts";

const PRD = "# Product {#prd.product}\n\n## Code view {#prd.code-view}\n\n## Store {#prd.store}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const section = Schema.decodeSync(SpecSectionId)("spec.store");
const taskId = Schema.decodeSync(TaskId);
const decodePath = Schema.decodeUnknownSync(LinkFromPath);

/** A lone surrogate, which `encodeURIComponent` throws on. */
const LONE_SURROGATE = globalThis.String.fromCharCode(0xd800);

const branchOf = (id: string) => `plan/${String.slice(1)(id)}-task`;

const taskOf = (id: string, parent: string | null) => ({
  branch: branchOf(id),
  commits: [],
  dependsOn: [],
  files: ["src/store.ts"],
  humanGate: { reasons: [], required: false },
  id,
  model: "sonnet",
  parent,
  prdSections: ["prd.store"],
  reasoning: "high",
  sessions: [],
  specSections: ["spec.store"],
  status: "pending",
  title: `Title of ${id}`,
  worktree: null,
});

/** t74 with t75 on top of it, and t76 with no commits. */
const MANIFEST = {
  baseBranch: "main",
  feature: "product",
  tasks: [taskOf("t74", null), taskOf("t75", "t74"), taskOf("t76", null)],
  version: 1,
};

/** A fresh main checkout holding the plan, on an in-memory Git with two commits of t74 and one of t75. */
const inCheckout = <A, E>(
  body: (shas: {
    readonly first: Sha;
    readonly newest: Sha;
    readonly other: Sha;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git | MainCheckout>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(
        Record.toEntries({
          "manifest.json": encodeJson(MANIFEST),
          "prd.md": PRD,
          "spec.md": SPEC,
        }),
        ([name, content]) => fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      const git = yield* Layer.build(Git.memory());
      const shas = yield* Effect.gen(function* () {
        const history = yield* GitHistory;
        const commit = (branch: string, id: string, subject: string) =>
          history.commit(branch, {
            files: ["src/store.ts"],
            sections: [section],
            session: null,
            subject,
            taskId: taskId(id),
          });
        yield* history.branch(branchOf("t74"), "main");
        yield* history.branch(branchOf("t75"), branchOf("t74"));
        const first = yield* commit(branchOf("t74"), "t74", "First");
        const newest = yield* commit(branchOf("t74"), "t74", "Newest");
        const other = yield* commit(branchOf("t75"), "t75", "Other");
        return { first, newest, other };
      }).pipe(Effect.provideContext(git));
      return yield* body(shas).pipe(
        Effect.provide(MainCheckout.fixed(root)),
        Effect.provideContext(git),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** A sha no commit has. */
const UNKNOWN = String.repeat(40)("0");

/** The message `cairn link` fails with for `tokens`. */
const refusal = (tokens: ReadonlyArray<string>) =>
  link({ base: DEFAULT_BASE, tokens }).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

/** Runs the command and returns the last line it printed. */
const printed = (tokens: ReadonlyArray<string>, base = DEFAULT_BASE) =>
  link({ base, tokens }).pipe(
    Effect.andThen(TestConsole.logLines),
    Effect.map((lines) => Array.last(lines)),
  );

it.effect("the PRD's example prints the path with the task's newest commit as the head", () =>
  inCheckout(({ newest }) =>
    Effect.gen(function* () {
      const line = yield* printed([
        "prd.code-view",
        "t74",
        "--file",
        "packages/cli/src/api.ts",
        "--line",
        "40",
      ]);
      const path = `/section/prd.code-view/task/t74/diff/${newest}/file/packages%2Fcli%2Fsrc%2Fapi.ts/lines/n40`;
      expect(line).toEqual(Option.some(`${DEFAULT_BASE}${path}`));
      expect(decodePath(path)).toEqual([
        { id: "prd.code-view", kind: "section" },
        { id: "t74", kind: "task" },
        { head: newest, kind: "diff" },
        { kind: "file", path: "packages/cli/src/api.ts" },
        { end: 40, kind: "lines", side: "new", start: 40 },
      ]);
    }),
  ),
);

it.effect('prints steps in the order given, and --base "" prints the path alone', () =>
  inCheckout(() =>
    Effect.gen(function* () {
      const reversed = yield* printed(["t74", "prd.code-view"], "");
      const given = yield* printed(["prd.code-view", "t74"], "");
      expect([reversed, given]).toEqual([
        Option.some("/task/t74/section/prd.code-view"),
        Option.some("/section/prd.code-view/task/t74"),
      ]);
    }),
  ),
);

it.effect("--passage turns its section into a passage, with the text collapsed", () =>
  inCheckout(() =>
    Effect.gen(function* () {
      const line = yield* printed(
        ["prd.code-view", "--passage", "  a   quoted\n text ", "t74"],
        "",
      );
      expect(line).toEqual(Option.some("/passage/prd.code-view/a%20quoted%20text/task/t74"));
    }),
  ),
);

it.effect("--old puts the lines on the old side, and a range is kept", () =>
  inCheckout(({ first }) =>
    Effect.gen(function* () {
      const line = yield* printed(
        ["--commit", first, "--file", "a.ts", "--old", "--line", "3-5"],
        "",
      );
      expect(line).toEqual(Option.some(`/commit/${first}/file/a.ts/lines/o3-5`));
    }),
  ),
);

it.effect("--stack and --segment take a root, --turn its session and turn", () =>
  inCheckout(() =>
    Effect.gen(function* () {
      const line = yield* printed(
        ["--stack", "t74", "--segment", "t76", "--turn", "s_abcdef/turn 1"],
        "",
      );
      expect(line).toEqual(Option.some("/stack/t74/segment/t76/turn/s_abcdef/turn%201"));
    }),
  ),
);

it.effect("refuses what it can check, naming the token", () =>
  inCheckout(({ first, other }) =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
        [["prd.code-veiw"], "unknown section prd.code-veiw"],
        [["t999"], "unknown task t999"],
        [["prd.code-view", "--line", "4"], "--line must follow --file"],
        [["t76", "--file", "a.ts"], "t76 has no commits, so it has no diff yet"],
        [["--commit", UNKNOWN], `unknown commit ${UNKNOWN}`],
        [["t74", "--commit", other], `commit ${other} does not carry t74's Cairn-Task trailer`],
        [["--stack", "t75"], "t75 is not the root of a stack, its parent is t74"],
        [["prd.code-view", "--passage"], "--passage needs a value"],
        [["--passage", "x"], "--passage must follow a section"],
        [["--commit", first, "--old"], "--old must be followed by --line"],
      ];
      const messages = yield* Effect.forEach(cases, ([tokens]) => refusal(tokens));
      expect(messages).toEqual(Array.map(cases, ([, message]) => message));
      const range = yield* refusal(["--commit", first, "--file", "a.ts", "--line", "2-1"]);
      expect(range).toContain("step 2 (lines)");
      const lines = yield* TestConsole.logLines;
      expect(lines).toEqual([]);
    }),
  ),
);

const SHA = String.repeat(40)("a");

const PLAN: LinkPlan = {
  commits: { [SHA]: null },
  sections: ["prd.code-view"],
  tasks: { t74: { commits: [], parent: null } },
};

it.prop(
  "text of any kind in a passage, a file or a turn is a link that reads back, or a refusal, never a throw",
  [Schema.String, Schema.Int, Schema.Int],
  ([text, start, end]) => {
    Array.forEach(
      [
        ["prd.code-view", "--passage", text],
        ["--commit", SHA, "--file", text],
        ["--commit", SHA, "--file", "a.ts", "--line", `${start}-${end}`],
        ["--turn", `s_abcdef/${text}`],
      ],
      (tokens) => {
        Result.match(pathOfArgs(tokens, PLAN), {
          onFailure: () => undefined,
          onSuccess: (written) => {
            expect(decodeLink(written)).toEqual(stepsOfArgs(tokens, PLAN));
          },
        });
      },
    );
  },
);

it("an option reads the same as --name value and as --name=value", () => {
  const spaced = pathOfArgs(["--commit", SHA, "--file", "a b.ts", "--old", "--line", "3-5"], PLAN);
  const equals = pathOfArgs(["--commit=" + SHA, "--file=a b.ts", "--old", "--line=3-5"], PLAN);
  expect(Result.isSuccess(spaced)).toBe(true);
  expect(equals).toEqual(spaced);
  // A value that looks like an option is a value, not read again.
  const odd = pathOfArgs(["prd.code-view", "--passage", "--base=x"], PLAN);
  expect(odd).toEqual(Result.succeed("/passage/prd.code-view/--base%3Dx"));
});

it("a step the schema refuses is an error, not an invalid path or a throw", () => {
  const commit = ["--commit", SHA];
  Array.forEach(
    [
      Array.appendAll(commit, ["--file", "a.ts", "--line", "2-1"]),
      Array.appendAll(commit, ["--file", LONE_SURROGATE]),
      Array.appendAll(commit, ["--file", ".."]),
      Array.appendAll(commit, ["--file", "a.ts", "--line", "0"]),
      Array.appendAll(commit, ["--file", "a.ts", "--line", "x"]),
      ["prd.code-view", "--file", "a.ts"],
      ["prd.code-view", "--passage", LONE_SURROGATE],
    ],
    (tokens) => {
      expect(Result.isFailure(pathOfArgs(tokens, PLAN))).toBe(true);
    },
  );
  expect(Result.getFailure(stepsOfArgs(["--bogus", "x"], PLAN))).toMatchObject({
    value: expect.any(LinkArgError),
  });
  expect(decodeManifest(MANIFEST).tasks).toHaveLength(3);
});
