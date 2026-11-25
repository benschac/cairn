import { expect, it } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Redacted,
} from "effect";

import { environmentLayer } from "../src/environment.ts";

const withEnvironment = (fileSystem: FileSystem.FileSystem, shell: Record<string, string> = {}) =>
  environmentLayer.pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(shell))),
  );

it.effect("loads a redacted token from .env and treats empty optional keys as missing", () =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CAIRN_AI_GATEWAY_TOKEN");
    expect(Redacted.value(token)).toBe("file-token");
    const judgeKey = yield* Config.String("TYPESAFE_API_KEY").pipe(Config.option);
    expect(judgeKey).toEqual(Option.none());
  }).pipe(
    Effect.provide(
      withEnvironment(
        FileSystem.makeNoop({
          readFileString: (path) => {
            expect(path).toBe(".env");
            return Effect.succeed("CAIRN_AI_GATEWAY_TOKEN=file-token\nTYPESAFE_API_KEY=\n");
          },
        }),
      ),
    ),
  ),
);

it.effect("shell values override .env values", () =>
  Effect.gen(function* () {
    const port = yield* Config.Port("CAIRN_PRESENCE_PORT");
    expect(port).toBe(4567);
  }).pipe(
    Effect.provide(
      withEnvironment(
        FileSystem.makeNoop({ readFileString: () => Effect.succeed("CAIRN_PRESENCE_PORT=4310") }),
        { CAIRN_PRESENCE_PORT: "4567" },
      ),
    ),
  ),
);

it.effect("a missing .env preserves shell values and config defaults", () =>
  Effect.gen(function* () {
    const token = yield* Config.String("TOKEN");
    const port = yield* Config.Port("CAIRN_PRESENCE_PORT").pipe(Config.withDefault(4310));
    expect(token).toBe("shell-token");
    expect(port).toBe(4310);
  }).pipe(Effect.provide(withEnvironment(FileSystem.makeNoop({}), { TOKEN: "shell-token" }))),
);

it.effect("unreadable .env errors are not silently ignored", () => {
  const error = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: ".env",
  });
  return Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Effect.void.pipe(
        Effect.provide(
          withEnvironment(FileSystem.makeNoop({ readFileString: () => Effect.fail(error) })),
        ),
      ),
    );
    expect(failure).toEqual(error);
  });
});
