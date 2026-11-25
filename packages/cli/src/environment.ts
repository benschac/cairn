import { ConfigProvider, Effect, Predicate } from "effect";

/** Load the working directory's .env as a fallback to the shell environment. */
export const environmentLayer = ConfigProvider.layerAdd(
  ConfigProvider.fromDotEnv().pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged("NotFound")(error.reason),
      () => Effect.succeed(ConfigProvider.fromUnknown({})),
    ),
  ),
);
