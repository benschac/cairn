import type { ManifestTask, TaskId } from "@cairn/contract";
import { Array, Option, Order, Record, String } from "effect";

/** A task and every task below it through parent links. It stops at a task it does not know or one it has seen. */
const lineOf = (
  parents: Record.ReadonlyRecord<string, TaskId | null>,
  id: TaskId,
): ReadonlyArray<TaskId> =>
  Array.unfold({ next: Option.some(id), seen: Array.empty<TaskId>() }, ({ next, seen }) =>
    Option.filter(next, (at) => !Array.contains(seen, at)).pipe(
      Option.map(
        (at) =>
          [
            at,
            {
              next: Option.flatMap(Record.get(parents, at), (parent) => Option.fromNullOr(parent)),
              seen: Array.append(seen, at),
            },
          ] as const,
      ),
    ),
  );

/** What `stackLines` says about a task besides its place in a stack: whether to mark it `new`. */
export interface StackOptions {
  readonly isNew?: (task: ManifestTask) => boolean;
}

const lineOfTask = (task: ManifestTask, depth: number, isNew: boolean) =>
  Array.join(
    Array.getSomes([
      Option.some(`${String.repeat(2 + 2 * depth)(" ")}${task.id}`),
      Option.some(task.status),
      Option.some(task.title),
      Option.some(`${task.model}/${task.reasoning}`),
      Option.liftPredicate("GATE", () => task.humanGate.required),
      Option.liftPredicate("new", () => isNew),
    ]),
    "  ",
  );

/**
 * The plan's tasks as `cairn status` prints them: a tree per stack, each task under its parent and its children together,
 * with its status, title, model and reasoning, `GATE` when a human gates it, and `new` when
 * `isNew` says so. Stacks are numbered in the order of their first task. Every task is printed
 * once, under the first task of the chain of its parents that is in the manifest.
 */
export const stackLines = (
  tasks: ReadonlyArray<ManifestTask>,
  { isNew = () => false }: StackOptions = {},
): ReadonlyArray<string> => {
  const parents = Record.fromIterableWith(tasks, (task) => [task.id, task.parent] as const);
  const positions = Record.fromEntries(Array.map(tasks, (task, at) => [task.id, at] as const));
  const placed = Array.map(tasks, (task) => {
    const line = lineOf(parents, task.id);
    return {
      depth: Array.length(line) - 1,
      // Where each task from the root down to this one sits in the manifest: sorting by it lists a
      // task's children right after it, whatever order `stackOf` placed them in.
      path: Array.map(Array.reverse(line), (id) =>
        Option.getOrElse(Record.get(positions, id), () => -1),
      ),
      root: Option.getOrElse(Array.last(line), () => task.id),
      task,
    };
  });
  const stackOf = (root: TaskId) =>
    Array.sortWith(
      Array.filter(placed, (candidate) => candidate.root === root),
      (candidate: (typeof placed)[number]) => candidate.path,
      Order.Array(Order.Number),
    );
  return Array.flatMap(Array.dedupe(Array.map(placed, ({ root }) => root)), (root, at) =>
    Array.prepend(
      Array.map(stackOf(root), ({ depth, task }) => lineOfTask(task, depth, isNew(task))),
      `Stack ${at + 1}`,
    ),
  );
};
