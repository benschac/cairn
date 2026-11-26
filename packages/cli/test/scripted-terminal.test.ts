import { expect, it } from "@effect/vitest";
import { Array, Effect, Ref, Terminal } from "effect";

import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";

// `display` is stored when the layer is built and run on each call. A display that acquires must
// release before the next one runs, not when the layer closes (see spec.refactors.carrying-context).
it.effect("each display releases what it acquired before the next one runs", () =>
  Effect.gen(function* () {
    const log = yield* Ref.make(Array.empty<string>());
    const note = (line: string) => Ref.update(log, Array.append(line));
    yield* Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      yield* terminal.display("first");
      yield* terminal.display("second");
    }).pipe(
      Effect.provide(
        scriptedTerminal([], (text) =>
          Effect.acquireRelease(note(`open ${text}`), () => note(`close ${text}`)),
        ),
      ),
    );
    const logged = yield* Ref.get(log);
    expect(logged).toStrictEqual(["open first", "close first", "open second", "close second"]);
  }),
);
