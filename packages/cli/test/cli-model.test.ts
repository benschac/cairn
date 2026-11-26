import { Config, defaultConfig } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Option, Path, Result, Schema, String } from "effect";
import {
  AiError,
  AnthropicStructuredOutput,
  LanguageModel,
  OpenAiStructuredOutput,
} from "effect/ai";
import { HttpClient } from "effect/http";

import { CliNotFound, layer as cliModel } from "../src/cli-model.ts";
import type { CliName } from "../src/cli-model.ts";
import { SmallLanguageModel, languageModelFor, plannerModels } from "../src/models.ts";
import type { PlannerCall } from "../src/models.ts";
import { Planner, PlannerError, TaskDrafts } from "../src/planner.ts";

/**
 * No test here runs a real CLI or reads a key. `claude` and `codex` are stub scripts in a
 * temporary directory that the CLI's `PATH` points to. A stub records what it was run with next to
 * itself (`<name>.argv`, `.stdin`, `.pwd`, `.ls` and, for codex, `.schema`) and prints the answer
 * the test left in `<name>.stdout`, `.stderr` and `.exit`. It also counts its runs in
 * `<name>.runs`, keeps run N's stdin in `.stdin.N` and prints `.stdout.N` for run N when there is
 * one, so a test can script a bad answer followed by a good one. Each call spawns a process, and CI runs
 * every package's tests at once, so the tests are few and each stub serves several assertions.
 */
const STUB = Array.join(
  [
    "#!/bin/sh",
    'dir="$(cd "$(dirname "$0")" && pwd)"',
    'name="$(basename "$0")"',
    'if [ "$1" = "--version" ]; then echo "9.9.9 (stub)"; exit 0; fi',
    'printf \'%s\\n\' "$@" > "$dir/$name.argv"',
    'echo run >> "$dir/$name.runs"',
    'n="$(wc -l < "$dir/$name.runs" | tr -d " ")"',
    'cat > "$dir/$name.stdin"',
    'cp "$dir/$name.stdin" "$dir/$name.stdin.$n"',
    'pwd -P > "$dir/$name.pwd"',
    'ls -A > "$dir/$name.ls"',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--output-schema" ]; then cat "$arg" > "$dir/$name.schema"; fi',
    '  prev="$arg"',
    "done",
    'cat "$dir/$name.stderr" >&2',
    'if [ -f "$dir/$name.stdout.$n" ]; then cat "$dir/$name.stdout.$n"; else cat "$dir/$name.stdout"; fi',
    'exit "$(cat "$dir/$name.exit")"',
    "",
  ],
  "\n",
);

interface Answer {
  readonly exit?: number;
  /** The answers of run 1, 2, ... in place of `stdout`. */
  readonly replies?: ReadonlyArray<string>;
  readonly stderr?: string;
  readonly stdout?: string;
}

/** A directory holding a stub `name` that answers with `answer`. */
const stubbed = Effect.fn("stubbed")(function* (
  name: CliName,
  { exit = 0, replies = [], stderr = "", stdout = "" }: Answer,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cairn-stub-" });
  yield* fs.writeFileString(path.join(dir, name), STUB, { mode: 0o755 });
  yield* fs.writeFileString(path.join(dir, `${name}.stdout`), stdout);
  yield* fs.writeFileString(path.join(dir, `${name}.stderr`), stderr);
  yield* fs.writeFileString(path.join(dir, `${name}.exit`), `${exit}`);
  yield* Effect.forEach(replies, (reply, index) =>
    fs.writeFileString(path.join(dir, `${name}.stdout.${index + 1}`), reply),
  );
  return dir;
});

const recorded = Effect.fn("recorded")(function* (dir: string, name: CliName, kind: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(dir, `${name}.${kind}`));
});

/** How many times the stub ran a call, not counting `--version`. */
const runsOf = (dir: string, name: CliName) =>
  recorded(dir, name, "runs").pipe(
    Effect.map((text) => Array.length(String.split(String.trimEnd(text), "\n"))),
  );

/** What the stub was run with, one argument per line. */
const argvOf = (dir: string, name: CliName) =>
  recorded(dir, name, "argv").pipe(Effect.map((text) => String.split(String.trimEnd(text), "\n")));

/** The argument after `flag`. */
const after = (argv: ReadonlyArray<string>, flag: string) =>
  Array.findFirstIndex(argv, (arg) => arg === flag).pipe(
    Option.flatMap((index) => Array.get(argv, index + 1)),
  );

/** The CLI model with `PATH` set to `dir` and the system's own tools the stub needs. */
const modelIn = (dir: string, cli: CliName, model?: string) =>
  cliModel({ cli, environment: { PATH: `${dir}:/usr/bin:/bin` }, model }).pipe(
    Layer.provide(NodeServices.layer),
  );

/** Only the failure of one type: an error of another type is a defect in the test. */
const only =
  <T>(is: (input: unknown) => input is T) =>
  (error: unknown) =>
    is(error) ? Effect.succeed(error) : Effect.die(error);

/** The source is cli, so nothing may use the network. */
const noNetwork = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("the cli source does not use the network")),
);

const Colour = Schema.Struct({ colour: Schema.String });
const pick = (prompt: string) =>
  LanguageModel.generateObject({ objectName: "Colour", prompt, schema: Colour });

const JsonValue = Schema.fromJsonString(Schema.Unknown);

const CLAUDE_STRUCTURED =
  '{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"colour":"red"}}';

it.effect(
  "claude gets the prompt on stdin and the call's schema, no tools, none of the person's setup, and --model only when one is set",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stubbed("claude", { stdout: CLAUDE_STRUCTURED });
      const picked = yield* pick("pick a colour").pipe(
        Effect.provide(modelIn(dir, "claude", "model-a")),
      );
      expect(picked.value).toEqual({ colour: "red" });
      const argv = yield* argvOf(dir, "claude");
      expect(Array.take(argv, 6)).toEqual([
        "-p",
        "--safe-mode",
        "--tools",
        "",
        "--output-format",
        "json",
      ]);
      expect(after(argv, "--model")).toEqual(Option.some("model-a"));
      const sentSchema = Option.getOrElse(after(argv, "--json-schema"), () => "");
      const schema = yield* Schema.decodeEffect(JsonValue)(sentSchema);
      expect(schema).toMatchObject({ properties: { colour: { type: "string" } }, type: "object" });
      const stdin = yield* recorded(dir, "claude", "stdin");
      expect(stdin).toBe("pick a colour");

      // It ran in a directory of its own, empty, and gone once the call ended.
      const pwd = yield* recorded(dir, "claude", "pwd");
      const cwd = String.trim(pwd);
      const repository = yield* path.fromFileUrl(new URL("../../..", import.meta.url));
      expect(String.startsWith(repository)(cwd)).toBe(false);
      expect(String.startsWith("cairn-planner-")(path.basename(cwd))).toBe(true);
      const listing = yield* recorded(dir, "claude", "ls");
      expect(listing).toBe("");
      const lingering = yield* fs.exists(cwd);
      expect(lingering).toBe(false);

      // No model configured: the CLI chooses, and no flag is passed.
      yield* pick("again").pipe(Effect.provide(modelIn(dir, "claude")));
      const againArgv = yield* argvOf(dir, "claude");
      expect(Option.isNone(after(againArgv, "--model"))).toBe(true);

      // A text call asks for no schema and reads the result text.
      yield* fs.writeFileString(
        path.join(dir, "claude.stdout"),
        '{"type":"result","is_error":false,"result":"plain words"}',
      );
      const text = yield* LanguageModel.generateText({ prompt: "say it" }).pipe(
        Effect.provide(modelIn(dir, "claude")),
      );
      expect(text.text).toBe("plain words");
      const textArgv = yield* argvOf(dir, "claude");
      expect(Option.isNone(after(textArgv, "--json-schema"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "codex gets the prompt on stdin and the call's schema in a file, with the person's config, rules and every tool switched off",
  () =>
    Effect.gen(function* () {
      const dir = yield* stubbed("codex", { stdout: '{"colour":"blue"}' });
      const picked = yield* pick("pick a colour").pipe(
        Effect.provide(modelIn(dir, "codex", "model-b")),
      );
      expect(picked.value).toEqual({ colour: "blue" });
      const argv = yield* argvOf(dir, "codex");
      // The person's own config (MCP servers, hooks, plugins), rules and session files are left out.
      expect(Array.take(argv, 7)).toEqual([
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
      ]);
      expect(Array.contains(argv, 'web_search="disabled"')).toBe(true);
      expect(after(argv, "-c")).toEqual(Option.some('web_search="disabled"'));
      // Each tool of codex, or way to reach tools, is switched off by its feature name.
      const disabled = Array.filterMap(argv, (arg, index) =>
        Option.match(Array.get(argv, index + 1), {
          onNone: () => Result.failVoid,
          onSome: (feature) => (arg === "--disable" ? Result.succeed(feature) : Result.failVoid),
        }),
      );
      expect(disabled).toContain("shell_tool");
      expect(disabled).toEqual([
        "shell_tool",
        "unified_exec",
        "view_image",
        "computer_use",
        "browser_use",
        "code_mode_host",
        "apps",
        "plugins",
        "hooks",
        "memories",
        "image_generation",
        "tool_suggest",
        "skill_search",
      ]);
      expect(after(argv, "--model")).toEqual(Option.some("model-b"));
      const sentSchema = yield* recorded(dir, "codex", "schema");
      const schema = yield* Schema.decodeEffect(JsonValue)(sentSchema);
      expect(schema).toMatchObject({ properties: { colour: { type: "string" } }, type: "object" });
      const stdin = yield* recorded(dir, "codex", "stdin");
      expect(stdin).toBe("pick a colour");
      const listing = yield* recorded(dir, "codex", "ls");
      expect(listing).toBe("schema.json\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a failed run is an error that carries the CLI's stderr, and a flag it lacks names its version",
  () =>
    Effect.gen(function* () {
      const failure = Effect.fn("failure")(function* (cli: CliName, answer: Answer) {
        const dir = yield* stubbed(cli, answer);
        return yield* Effect.flip(pick("x").pipe(Effect.provide(modelIn(dir, cli))));
      });
      const exited = yield* failure("claude", { exit: 3, stderr: "not signed in" });
      expect(exited.message).toContain("not signed in");
      expect(exited.message).toContain("exited with code 3");
      const prose = yield* failure("claude", { stderr: "warning: slow", stdout: "Sure, red!" });
      expect(prose.message).toContain("warning: slow");
      expect(prose.message).toContain("did not print a JSON result");
      const refused = yield* failure("claude", {
        stdout: '{"is_error":true,"result":"credit balance too low"}',
      });
      expect(refused.message).toContain("credit balance too low");
      const unknown = yield* failure("codex", {
        exit: 2,
        stderr: "error: unexpected argument '--output-schema'",
      });
      expect(unknown.message).toContain("codex 9.9.9 (stub) does not accept a flag");
      expect(unknown.message).toContain("unexpected argument '--output-schema'");
      expect(Schema.is(AiError.AiError)(unknown)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "the cli source passes planner.small to the small calls and planner.model to the others",
  () =>
    Effect.gen(function* () {
      const dir = yield* stubbed("claude", { stdout: CLAUDE_STRUCTURED });
      const config = yield* Schema.decodeEffect(Config)({
        planner: { model: "big-model", small: "small-model" },
      });
      const environment = { PATH: `${dir}:/usr/bin:/bin` };
      const modelOf = Effect.fn("modelOf")(function* (call: PlannerCall) {
        yield* pick("x").pipe(
          Effect.provide(
            languageModelFor(config, call, environment).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, noNetwork)),
            ),
          ),
        );
        const argv = yield* argvOf(dir, "claude");
        return after(argv, "--model");
      });
      const small = yield* modelOf("index");
      const big = yield* modelOf("spec");
      expect(small).toEqual(Option.some("small-model"));
      expect(big).toEqual(Option.some("big-model"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a plan run's models are planner.model, and planner.small for the small calls when it is set",
  () =>
    Effect.gen(function* () {
      const dir = yield* stubbed("claude", { stdout: CLAUDE_STRUCTURED });
      const environment = { PATH: `${dir}:/usr/bin:/bin` };
      const modelsOf = Effect.fn("modelsOf")(function* (planner: {
        readonly model: string;
        readonly small?: string;
      }) {
        const config = yield* Schema.decodeEffect(Config)({ planner });
        return plannerModels(config, environment).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, noNetwork)),
        );
      });
      /** The `--model` the stub was given by a call to the small model, when there is one. */
      const smallModelOf = Effect.gen(function* () {
        const small = yield* Effect.serviceOption(SmallLanguageModel);
        return yield* Option.match(small, {
          onNone: () => Effect.succeed("no small model"),
          onSome: (model) =>
            pick("x").pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
              Effect.andThen(argvOf(dir, "claude")),
              Effect.map((argv) => Option.getOrElse(after(argv, "--model"), () => "no --model")),
            ),
        });
      });
      const both = yield* modelsOf({ model: "big-model", small: "small-model" });
      yield* pick("x").pipe(Effect.provide(both));
      const argv = yield* argvOf(dir, "claude");
      const small = yield* smallModelOf.pipe(Effect.provide(both));
      const one = yield* modelsOf({ model: "big-model" });
      const none = yield* smallModelOf.pipe(Effect.provide(one));
      expect([after(argv, "--model"), small, none]).toEqual([
        Option.some("big-model"),
        "small-model",
        "no small model",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a missing binary fails the layer, before any call, with the message that names the setting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const empty = yield* fs.makeTempDirectoryScoped();
      const failure = yield* Effect.flip(
        Layer.build(cliModel({ cli: "claude", environment: { PATH: empty }, model: undefined })),
      );
      expect(Schema.is(CliNotFound)(failure)).toBe(true);
      expect(failure.message).toBe(
        "claude was not found. Install Claude Code, or set planner.cli or planner.source in .cairn/config.json.",
      );
      expect(new CliNotFound({ cli: "codex" }).message).toBe(
        "codex was not found. Install Codex, or set planner.cli or planner.source in .cairn/config.json.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a planner over the CLI model returns its answer, and a CLI failure is a PlannerError with its stderr",
  () =>
    Effect.gen(function* () {
      // The model answers in the encoded form of the schema it was sent, so the stub does too.
      const { codec } = AnthropicStructuredOutput.toCodecAnthropic(TaskDrafts);
      const value = yield* Schema.decodeEffect(TaskDrafts)({
        drafts: [
          {
            category: "feature",
            dependsOn: [],
            files: ["packages/cli/src/a.ts"],
            model: "sonnet",
            prdSections: ["prd.goal"],
            reasoning: "high",
            specSections: ["spec.models"],
            title: "Add a",
          },
        ],
      });
      const answer = yield* Schema.encodeEffect(Schema.fromJsonString(codec))(value);
      const dir = yield* stubbed("claude", {
        stdout: `{"is_error":false,"result":"","structured_output":${answer}}`,
      });
      const planner = Planner.layerWith(defaultConfig).pipe(
        Layer.provide(modelIn(dir, "claude")),
        Layer.provide(NodeServices.layer),
      );
      const drafts = yield* Planner.use((p) => p.tasks("prd", "spec", [], [])).pipe(
        Effect.provide(planner),
      );
      expect(Array.map(drafts, (d) => d.title)).toEqual(["Add a"]);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(dir, "claude.exit"), "1");
      yield* fs.writeFileString(path.join(dir, "claude.stderr"), "the CLI said no");
      const error = yield* Effect.flip(
        Planner.use((p) => p.spec("prd")).pipe(Effect.provide(planner)),
      ).pipe(Effect.flatMap(only(Schema.is(PlannerError))));
      expect(error.call).toBe("spec");
      expect(error.reason).toContain("the CLI said no");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const DRAFTS = {
  drafts: [
    {
      category: "feature",
      dependsOn: [],
      files: ["packages/cli/src/a.ts"],
      model: "sonnet",
      prdSections: ["prd.goal"],
      reasoning: "high",
      specSections: ["spec.models"],
      title: "Add a",
    },
  ],
};

const encodedAs = Effect.fn("encodedAs")(function* (
  transformer: typeof AnthropicStructuredOutput.toCodecAnthropic,
) {
  const value = yield* Schema.decodeUnknownEffect(TaskDrafts)(DRAFTS);
  return yield* Schema.encodeEffect(Schema.fromJsonString(transformer(TaskDrafts).codec))(value);
});

const planning = (dir: string, cli: CliName) =>
  Planner.layerWith(defaultConfig).pipe(
    Layer.provide(modelIn(dir, cli)),
    Layer.provide(NodeServices.layer),
  );

const tasks = Planner.use((p) => p.tasks("prd", "spec", [], []));

/** A claude result with no `structured_output`: the answer is in the `result` text. */
const claudeSaying = (text: string) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ is_error: false, result: text });

it.effect(
  "a structured answer that does not decode is retried once with the decode error in the prompt, then fails",
  () =>
    Effect.gen(function* () {
      // codex: prose first, then the answer. Two runs, and the second prompt says what was wrong.
      const fromCodex = yield* encodedAs(OpenAiStructuredOutput.toCodecOpenAI);
      const codex = yield* stubbed("codex", { replies: ["Sure, here are the tasks.", fromCodex] });
      const drafts = yield* tasks.pipe(Effect.provide(planning(codex, "codex")));
      expect(Array.map(drafts, (d) => d.title)).toEqual(["Add a"]);
      const codexRuns = yield* runsOf(codex, "codex");
      expect(codexRuns).toBe(2);
      const first = yield* recorded(codex, "codex", "stdin.1");
      const second = yield* recorded(codex, "codex", "stdin.2");
      expect(second).toContain(first);
      // The refused reply is in the second prompt, so the CLI sees what it is asked to fix.
      expect(second).toContain("Your previous reply:\n\nSure, here are the tasks.");
      expect(second).toContain("Your previous reply was refused");
      expect(second).toContain("Structured output validation failed");

      // claude with no structured_output: the same, from the result text.
      const fromClaude = yield* encodedAs(AnthropicStructuredOutput.toCodecAnthropic);
      const claude = yield* stubbed("claude", {
        replies: [yield* claudeSaying("Sure!"), yield* claudeSaying(fromClaude)],
      });
      const again = yield* tasks.pipe(Effect.provide(planning(claude, "claude")));
      expect(Array.map(again, (d) => d.title)).toEqual(["Add a"]);
      const claudeRuns = yield* runsOf(claude, "claude");
      expect(claudeRuns).toBe(2);
      const claudeSecond = yield* recorded(claude, "claude", "stdin.2");
      expect(claudeSecond).toContain("Your previous reply:\n\nSure!");

      // Two bad answers: a PlannerError after exactly two runs, not a third.
      const bad = yield* claudeSaying("Still prose.");
      const hopeless = yield* stubbed("claude", { stdout: bad });
      const error = yield* Effect.flip(
        tasks.pipe(Effect.provide(planning(hopeless, "claude"))),
      ).pipe(Effect.flatMap(only(Schema.is(PlannerError))));
      expect(error.call).toBe("tasks");
      const hopelessRuns = yield* runsOf(hopeless, "claude");
      expect(hopelessRuns).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
