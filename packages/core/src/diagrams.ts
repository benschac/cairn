import { Option, Predicate, Result, pipe } from "effect";
import { parse } from "pele";

/**
 * The parser's error for a Mermaid block, or nothing when it draws.
 *
 * `pele` parses synchronously and needs no DOM, so this runs in Node, in lint and in tests.
 * It parses with the same library the viewer draws with, so a block that passes here draws there.
 */
export const drawsOf = (mermaid: string): Option.Option<string> =>
  pipe(
    Result.try({
      catch: (error) => (Predicate.isError(error) ? error.message : "The diagram did not parse"),
      try: () => parse(mermaid),
    }),
    Result.getFailure,
  );
