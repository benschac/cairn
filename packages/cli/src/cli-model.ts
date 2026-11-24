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
 * on claude 2.1.331 (Claude Code) and codex-cli 0.171.0. Both CLIs change often. A flag an
 * installed CLI no longer has makes it exit non-zero with a usage error, which this module turns
 * into a failure that names the CLI's version.
 *
 * - claude: `claude -p --tools "" --output-format json`, the prompt on stdin, and the call's JSON
 *   Schema as `--json-schema` for a structured answer, which comes back as `structured_output`.
 * - codex: `codex exec --skip-git-repo-check --sandbox read-only --disable shell_tool ...`, the
 *   prompt on stdin, and the call's JSON Schema in a file given to `--output-schema`. Codex prints
 *   its last message on stdout.
 *
 * Codex's isolation is weaker than claude's `--tools ""`. Codex 0.171.0 documents no single switch
 * for every tool, so each is switched off by its feature name with `--disable` (the same as
 * `-c features.<name>=false`): `shell_tool` and `unified_exec` (running commands), `view_image`
 * (reading image files), and `computer_use` and `browser_use` (driving the machine). These are the
 * stable features of `codex features list` that plainly act on the machine. What stays on: MCP
 * servers, apps and plugins from the person's own codex config are not switched off, and the
 * read-only sandbox and the empty temporary directory only limit what the shell would have done.
 * Nothing here has been checked against a real codex run.
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

/** What a message says. The planner sends system and user messages; the others say nothing here. */
const said = Match.type<Prompt.Message>().pipe(
  Match.when({ role: "system" }, (message) => message.content),
  Match.when({ role: "user" }, (message) =>
    Array.join(
      Array.filterMap(message.content, (part) =>
        part.type === "text" ? Result.succeed(part.text) : Result.failVoid,
      ),
      "",
    ),
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

/** The codex features switched off, because each is a tool that acts on the machine. */
const CODEX_DISABLED = ["shell_tool", "unified_exec", "view_image", "computer_use", "browser_use"];

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
                ["-p", "--tools", "", "--output-format", "json"],
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
                ["exec", "--skip-git-repo-check", "--sandbox", "read-only"],
                Array.flatMap(CODEX_DISABLED, (feature) => ["--disable", feature]),
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
