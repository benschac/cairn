import { Context, Effect, Stream } from "effect";

/**
 * Whether the viewer runs in a browser page. Its subscriptions listen to the document, the window,
 * the room's socket and the trace poll only then, so a host with no page, such as a test's
 * `TestHost`, hears none of them. `entry.ts` provides `true`; the default is `false`.
 */
export const InPage = Context.Reference<boolean>("@cairn/viewer/subscription/InPage", {
  defaultValue: () => false,
});

/** A stream that runs only in a browser page, and is empty anywhere else. */
export const inPage = <A>(stream: Stream.Stream<A>): Stream.Stream<A> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const isInPage = yield* InPage;
      return isInPage ? stream : Stream.empty;
    }),
  );
