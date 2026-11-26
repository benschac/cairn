import { Array, Effect, Layer, Option, Ref, Terminal } from "effect";

/**
 * A terminal that answers each question with the next of `answers`, then ends its input, and hands
 * everything it shows to `display`. Nothing reads the real terminal.
 */
export const scriptedTerminal = <R = never>(
  answers: ReadonlyArray<string>,
  display: (text: string) => Effect.Effect<void, never, R> = () => Effect.void,
): Layer.Layer<Terminal.Terminal, never, R> =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const services = yield* Effect.context<R>();
      const remaining = yield* Ref.make(answers);
      return Terminal.make({
        columns: Effect.succeed(80),
        display: (text) => display(text).pipe(Effect.provideContext(services)),
        readInput: Effect.never,
        readLine: Ref.modify(remaining, (left) =>
          Array.match(left, {
            onEmpty: () => [Option.none<string>(), left] as const,
            onNonEmpty: ([first, ...rest]) => [Option.some(first), rest] as const,
          }),
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Terminal.QuitError({})),
              onSome: Effect.succeed,
            }),
          ),
        ),
        rows: Effect.succeed(24),
        size: Effect.never,
      });
    }),
  );
