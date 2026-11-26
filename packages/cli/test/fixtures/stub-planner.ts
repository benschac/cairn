import { Context, Effect, Option } from "effect";

import { Planner } from "../../src/planner.ts";

type Calls = Context.Service.Shape<typeof Planner>;

/** A call no test of this planner expects: it dies with the call's name, so the test fails loudly. */
const unexpected = (call: keyof Calls) => () => Effect.die(`Planner.${call} was not expected`);

/** `given` when the test scripted the call, and the unscripted call otherwise. */
const scriptedOr = <A>(given: A | undefined, unscripted: A) =>
  Option.getOrElse(Option.fromUndefinedOr(given), () => unscripted);

/**
 * A planner that answers the calls in `calls` and leaves the rest unscripted: `index` and
 * `statements` answer with nothing, and any other call dies.
 */
export const stubPlanner = (calls: Partial<Calls>): Calls =>
  Planner.of({
    index: scriptedOr(calls.index, () =>
      Effect.succeed({ artifacts: [], decisions: [], requirements: [], summary: "", tests: [] }),
    ),
    sections: scriptedOr(calls.sections, unexpected("sections")),
    spec: scriptedOr(calls.spec, unexpected("spec")),
    splitSection: scriptedOr(calls.splitSection, unexpected("splitSection")),
    splitTask: scriptedOr(calls.splitTask, unexpected("splitTask")),
    statements: scriptedOr(calls.statements, () => Effect.succeed([])),
    tasks: scriptedOr(calls.tasks, unexpected("tasks")),
  });
