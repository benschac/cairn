import type { PrdSectionId, SpecSectionId } from "@cairn/contract";
import { Array, Option, String } from "effect";

import { keyEntriesOf, keyLineIndexesOf, sectionsOf } from "./sections.ts";

/** The line of a key list that holds a section's own `Implements`. */
const IMPLEMENTS = /^- Implements:/u;

/** An `Implements` line with `item` added after the IDs it names. */
const appended = (line: string, item: PrdSectionId) => {
  const kept = String.trimEnd(line);
  return `${kept}${String.endsWith(":")(kept) ? "" : ","} \`${item}\``;
};

/**
 * `spec` with `item` added to the `Implements` line of spec section `section`
 * (`spec.planning.again.mapping-items`). Every other line stays as it was. The spec is unchanged
 * when the section is not there, has no `Implements` line of its own, or already names the item
 * there. Pure.
 */
export const withImplements = (
  spec: string,
  section: SpecSectionId,
  item: PrdSectionId,
): string => {
  const lines = String.split(spec, "\n");
  const target: string = section;
  return Option.getOrElse(
    Array.findFirst(sectionsOf(spec), (found) => found.id === target).pipe(
      Option.flatMap((found) => {
        const body = String.split(found.body, "\n");
        return Array.findFirst(keyLineIndexesOf(body), (at) =>
          Option.exists(Array.get(body, at), (line) => IMPLEMENTS.test(line)),
        ).pipe(
          Option.filter((at) =>
            Array.every(
              keyEntriesOf(Option.toArray(Array.get(body, at))),
              ([, values]) => !Array.contains(values, item),
            ),
          ),
          // The body starts on the line after the heading, which is line `found.line` (1-based).
          Option.flatMap((at) =>
            Array.modify(lines, found.line + at, (line) => appended(line, item)),
          ),
        );
      }),
      Option.map(Array.join("\n")),
    ),
    () => spec,
  );
};
