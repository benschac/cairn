import {
  Array,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
  Stream,
  String,
} from "effect";
import {
  AiError,
  AnthropicStructuredOutput,
  LanguageModel,
  OpenAiStructuredOutput,
  Tool,
} from "effect/ai";
import type { Prompt } from "effect/ai";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * The `cli` planner source (`spec.models`): a `LanguageModel` that runs the person's agent CLI once
 * per call and reads its answer, so planning uses that CLI's own sign-in and Cairn reads no key.
 *
 * The flags below are what `claude --help` and `codex exec --help` documented when this was written,
 * on claude 2.1.331 (Claude Code) and codex-cli 0.172.0. Both CLIs change often. A flag an
 * installed CLI no longer has makes it exit non-zero with a usage error, which this module turns
 * into a failure that names the CLI's version.
 *
 * - claude: `claude -p --safe-mode --tools "" --output-format json`, the prompt on stdin, and the
 *   call's JSON Schema as `--json-schema` for a structured answer, which comes back as
 *   `structured_output`.
 * - codex: `codex exec`, the prompt on stdin, and the call's JSON Schema in a file given to
 *   `--output-schema`. Codex prints its last message on stdout and its progress on stderr.
 *
 * `--safe-mode` starts claude without the person's CLAUDE.md, skills, plugins, hooks, MCP servers
 * and custom agents; their sign-in and model selection still apply. The planner's prompt holds
 * everything a call needs, and without the flag each call also sent all of that to the model: on
 * claude 2.1.332, a one-word prompt from a machine with a full Claude Code setup carried about
 * 226,000 tokens, none of them read from the prompt cache, and took 10 seconds, against 2,700
 * tokens and 6 seconds with the flag.
 *
 * Codex has no `--tools ""`, so its isolation is several switches, each checked against a real
 * codex-cli 0.172.0 run in an empty directory (a prompt that asked it to run `ls ~`, call any
 * MCP, app, plugin, browser, web or image tool and read `/etc/hosts`; none of it ran):
 *
 * - `--ignore-user-config` does not load `~/.codex/config.toml`, so none of the person's MCP
 *   servers, hooks, notify program or marketplaces exist (auth still comes from `CODEX_HOME`).
 *   Without it the same prompt ran `ls` in the person's home and listed their MCP tools.
 * - `--ignore-rules` loads no execpolicy `.rules`; `--ephemeral` writes no session files.
 * - `--sandbox read-only` and the empty temporary directory only limit what a shell would have
 *   done: a read-only sandbox still lets `ls ~` run, so the shell is switched off as well.
 * - `--disable <feature>` (the same as `-c features.<feature>=false`) switches off each tool by
 *   its name: `shell_tool` and `unified_exec` (commands), `view_image`, `computer_use`,
 *   `browser_use`, `apps`, `plugins`, `hooks`, `memories`, `image_generation`, `tool_suggest`
 *   and `skill_search`. `code_mode_host` is off too: with it on, codex's code-mode tool runs
 *   scripts that reach every tool the person's account has, with it off the tool fails closed
 *   ("code-mode host is disabled").
 * - `-c web_search="disabled"` switches off web search.
 *
 * What stays: the person's global `~/.codex/AGENTS.md` and skill list are still sent to the model
 * as instructions (no flag drops them; `CODEX_HOME` cannot be swapped without copying the sign-in,
 * whose refresh token rotates), and codex's built-in `list_mcp_resources`, which answers with an
 * empty list because no server is configured. Neither acts on the machine.
 *
 * `--model` is passed only when a model is configured.
 */

/** The agent CLIs the planner can run (`planner.cli`). */
export const CliName = Schema.Literals(["claude", "codex"]);
export type CliName = typeof CliName.Type;

const productOf = Match.type<CliName>().pipe(
  Match.when("claude", () => "Claude Code"),
  Match.when("codex", () => "Codex"),
  Match.exhaustive,
);

/**
 * The CLI is not on `PATH`. Raised when the layer is built, so `cairn plan` stops before it
 * changes a file.
 */
export class CliNotFound extends Schema.TaggedError<
  CliNotFound,
  { readonly brand: unique symbol }
>()("CliNotFound", {
  cli: CliName,
}) {
  override get message() {
    return `${this.cli} was not found. Install ${productOf(this.cli)}, or set planner.cli or planner.source in .cairn/config.json.`;
  }
}

export interface CliModelOptions {
  readonly cli: CliName;
  /** `planner.model` or `planner.small`. Without one, the CLI chooses. */
  readonly model: string | undefined;
  /** Variables for the CLI's environment on top of this process's own; a test sets `PATH`. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

/** What a finished CLI run left behind. */
interface Finished {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const MODULE = "CliLanguageModel";

const failure = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ method, module: MODULE, reason });

const withStderr = (description: string, stderr: string) =>
  String.isNonEmpty(stderr) ? `${description}\n${stderr}` : description;

/** The text parts of a message, one after another. */
const textOf = (parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>) =>
  Array.join(
    Array.filterMap(parts, (part) =>
      part.type === "text" ? Result.succeed(part.text) : Result.failVoid,
    ),
    "",
  );

/**
 * What a message says. The planner sends system and user messages, and when it asks again in the
 * same chat, the model's refused reply as an assistant message, marked so the CLI can tell its own
 * reply from the instructions around it. Tool messages say nothing here.
 */
const said = Match.type<Prompt.Message>().pipe(
  Match.when({ role: "system" }, (message) => message.content),
  Match.when({ role: "user" }, (message) => textOf(message.content)),
  Match.when({ role: "assistant" }, (message) =>
    Option.match(Option.liftPredicate(textOf(message.content), String.isNonEmpty), {
      onNone: () => "",
      onSome: (text) => `Your previous reply:\n\n${text}`,
    }),
  ),
  Match.orElse(() => ""),
);

const promptText = (prompt: Prompt.Prompt) =>
  Array.join(Array.filter(Array.map(prompt.content, said), String.isNonEmpty), "\n\n");

/** A usage error from the CLI's argument parser: Commander says "unknown option", clap "unexpected argument". */
const USAGE_ERROR = /unknown option|unexpected argument|unrecognized (option|argument)/iu;

const isNotFound = (error: PlatformError) => Predicate.isTagged("NotFound")(error.reason);

const collect = (bytes: Stream.Stream<Uint8Array, PlatformError>) =>
  Stream.mkString(Stream.decodeText(bytes));

const optionally = (flag: string, value: Option.Option<string>) =>
  Option.match(value, { onNone: () => [], onSome: (text) => [flag, text] });

/** The `--version` line, used in the message of a CLI that rejects a flag. */
const versionOf = Effect.fn("CliLanguageModel.version")(function* (
  cli: CliName,
  environment: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(cli, ["--version"], {
          env: environment,
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      const stdout = yield* collect(handle.stdout);
      yield* handle.exitCode;
      return String.trim(stdout);
    }),
  ).pipe(
    // Not on PATH is the one failure that matters here. Anything else is left to the call itself
    // to report, with the CLI's own words.
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.fail(new CliNotFound({ cli }))
        : Effect.succeed("an unknown version"),
    ),
  );
});

const SchemaJson = Schema.fromJsonString(Schema.Unknown);

/** Claude Code's `--output-format json` result: the fields this reads. */
const ClaudeResult = Schema.fromJsonString(
  Schema.Struct({
    is_error: Schema.optionalKey(Schema.Boolean),
    result: Schema.optionalKey(Schema.String),
    structured_output: Schema.optionalKey(Schema.Unknown),
  }),
);

/**
 * The answer's text from what each CLI printed. It is not checked here: a structured answer that is
 * prose or does not fit the schema is for `generateObject` to decode, so it fails with a decode
 * failure the Planner retries once. What fails here is what is not an answer at all: claude's
 * `--output-format json` envelope not being JSON, or claude saying it failed.
 */
const answerOf = (cli: CliName, finished: Finished) =>
  Match.value(cli).pipe(
    Match.when("codex", () => Effect.succeed(String.trim(finished.stdout))),
    Match.when("claude", () =>
      Schema.decodeEffect(ClaudeResult)(finished.stdout).pipe(
        Effect.mapError(() =>
          failure(
            "generateText",
            new AiError.InvalidResponseError({
              description: withStderr(
                "claude did not print a JSON result: " + String.slice(0, 200)(finished.stdout),
                finished.stderr,
              ),
            }),
          ),
        ),
        Effect.flatMap((result) =>
          result.is_error === true
            ? Effect.fail(
                failure(
                  "generateText",
                  new AiError.InternalProviderError({
                    description: withStderr(
                      `claude reported an error: ${Option.getOrElse(Option.fromUndefinedOr(result.result), () => "no message")}`,
                      finished.stderr,
                    ),
                  }),
                ),
              )
            : Option.match(Option.fromUndefinedOr(result.structured_output), {
                onNone: () =>
                  Effect.succeed(Option.getOrElse(Option.fromUndefinedOr(result.result), () => "")),
                onSome: (value) =>
                  Schema.encodeEffect(SchemaJson)(value).pipe(
                    Effect.mapError(() =>
                      failure(
                        "generateObject",
                        new AiError.InvalidResponseError({
                          description: "claude's structured output is not JSON",
                        }),
                      ),
                    ),
                  ),
              }),
        ),
      ),
    ),
    Match.exhaustive,
  );

/** The codex features switched off, because each is a tool, or reaches tools, that act beyond the prompt. */
const CODEX_DISABLED = [
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
];

const codecOf = Match.type<CliName>().pipe(
  Match.when("claude", () => AnthropicStructuredOutput.toCodecAnthropic),
  Match.when("codex", () => OpenAiStructuredOutput.toCodecOpenAI),
  Match.exhaustive,
);

/**
 * A `LanguageModel` that runs `options.cli`. Building the layer looks for the CLI on `PATH` and
 * fails with a `CliNotFound` when it is not there; it runs nothing else, and reads no key.
 */
export const layer = (options: CliModelOptions) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cli } = options;
      const environment = Option.getOrElse(Option.fromUndefinedOr(options.environment), () => ({}));
      const model = Option.fromUndefinedOr(options.model);
      const version = yield* versionOf(cli, environment).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      /** The call's JSON Schema as text, in the form the CLI's provider accepts. */
      const jsonSchemaOf = (format: LanguageModel.ProviderOptions["responseFormat"]) =>
        Match.value(format).pipe(
          Match.when({ type: "text" }, () => Effect.succeed(Option.none<string>())),
          Match.when({ type: "json" }, ({ schema }) =>
            Effect.try({
              catch: (error) =>
                failure(
                  "generateObject",
                  new AiError.UnsupportedSchemaError({
                    description: Predicate.isError(error)
                      ? error.message
                      : "the schema has no JSON Schema",
                  }),
                ),
              try: () => Tool.getJsonSchemaFromSchema(schema, { transformer: codecOf(cli) }),
            }).pipe(
              Effect.flatMap(Schema.encodeEffect(SchemaJson)),
              Effect.asSome,
              Effect.mapError((error) =>
                AiError.isAiError(error)
                  ? error
                  : failure(
                      "generateObject",
                      new AiError.UnsupportedSchemaError({ description: error.message }),
                    ),
              ),
            ),
          ),
          Match.exhaustive,
        );

      /** The arguments for `cli`; codex needs the schema in a file, which goes in `directory`. */
      const argumentsFor = (directory: string, schema: Option.Option<string>) =>
        Match.value(cli).pipe(
          Match.when("claude", () =>
            Effect.succeed(
              Array.flatten([
                ["-p", "--safe-mode", "--tools", "", "--output-format", "json"],
                optionally("--model", model),
                optionally("--json-schema", schema),
              ]),
            ),
          ),
          Match.when("codex", () =>
            Effect.gen(function* () {
              const file = path.join(directory, "schema.json");
              yield* Option.match(schema, {
                onNone: () => Effect.void,
                onSome: (text) => fs.writeFileString(file, text),
              });
              return Array.flatten([
                [
                  "exec",
                  "--skip-git-repo-check",
                  "--ephemeral",
                  "--ignore-user-config",
                  "--ignore-rules",
                  "--sandbox",
                  "read-only",
                ],
                Array.flatMap(CODEX_DISABLED, (feature) => ["--disable", feature]),
                ["-c", 'web_search="disabled"'],
                optionally("--model", model),
                optionally(
                  "--output-schema",
                  Option.map(schema, () => file),
                ),
              ]);
            }),
          ),
          Match.exhaustive,
        );

      const run = (providerOptions: LanguageModel.ProviderOptions) =>
        Effect.scoped(
          Effect.gen(function* () {
            // Its own empty directory, so a CLI that looks around finds nothing of the repository.
            const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cairn-planner-" });
            const schema = yield* jsonSchemaOf(providerOptions.responseFormat);
            const args = yield* argumentsFor(directory, schema);
            const handle = yield* spawner.spawn(
              ChildProcess.make(cli, args, {
                cwd: directory,
                env: environment,
                extendEnv: true,
                stdin: Stream.encodeText(Stream.make(promptText(providerOptions.prompt))),
              }),
            );
            const [stdout, stderr] = yield* Effect.all(
              [collect(handle.stdout), collect(handle.stderr)],
              {
                concurrency: "unbounded",
              },
            );
            const exitCode = yield* handle.exitCode;
            return { exitCode, stderr: String.trim(stderr), stdout };
          }),
        ).pipe(
          Effect.mapError((error) =>
            AiError.isAiError(error)
              ? error
              : failure(
                  "generateText",
                  new AiError.InternalProviderError({ description: error.message }),
                ),
          ),
        );

      const generateText = Effect.fn("CliLanguageModel.generateText")(function* (
        providerOptions: LanguageModel.ProviderOptions,
      ) {
        const { exitCode, stderr, stdout } = yield* run(providerOptions);
        const finished = { exitCode, stderr, stdout };
        if (exitCode !== 0) {
          return yield* failure(
            "generateText",
            new AiError.InternalProviderError({
              description: withStderr(
                Option.isSome(String.match(USAGE_ERROR)(stderr))
                  ? `${cli} ${version} does not accept a flag Cairn passes. Update it, or set planner.cli or planner.source in .cairn/config.json.`
                  : `${cli} exited with code ${exitCode}`,
                stderr,
              ),
            }),
          );
        }
        const text = yield* answerOf(cli, finished);
        return [{ text, type: "text" as const }];
      });

      return yield* LanguageModel.make({
        codecTransformer: codecOf(cli),
        generateText,
        streamText: () =>
          Stream.fail(
            failure(
              "streamText",
              new AiError.InvalidRequestError({ description: "the cli source does not stream" }),
            ),
          ),
      });
    }),
  );
