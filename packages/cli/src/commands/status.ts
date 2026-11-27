import { TaskId, Trace } from "@cairn/contract";
import type { Manifest, ManifestTask, TraceTask } from "@cairn/contract";
import { stacksOf, traceOf } from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Record,
  Schema,
  String,
  Struct,
} from "effect";
import { Command, Flag } from "effect/cli";

import { replaceFile } from "../atomic-write.ts";
import { loadServedTraceInput, loadTraceInput } from "../load-trace.ts";
import { layer as gitLayer } from "../git-live.ts";
import { MainCheckout } from "../main-checkout.ts";
import { stackLines } from "../print-stack.ts";
import { TraceStore } from "../trace-store.ts";
import { CAIRN_DIRECTORY } from "../workspace.ts";

const MANIFEST_FILE = "manifest.json";

/** The width oxfmt breaks a line at. */
const WIDTH = 100;

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Properties = Schema.Record(Schema.String, Schema.Unknown);
const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(Properties));
const isProperties = Schema.is(Properties);
const isTasks = Schema.is(Schema.Array(Properties));

const indentOf = (depth: number) => String.repeat(2 * depth)(" ");

const isScalar = (value: unknown): boolean => !Predicate.isObject(value);

/**
 * JSON as oxfmt prints it: an object is always one property per line, an array of scalars stays on
 * one line while the line fits in 100 columns, and any other array is one item per line. `lead` is
 * the text before the value on its line and `tail` how many characters a comma may add after it.
 */
const formatJson = (value: unknown, depth: number, lead: string, tail: number): string => {
  const inner = indentOf(depth + 1);
  const expanded = (open: string, close: string, items: ReadonlyArray<string>) =>
    `${open}\n${Array.join(items, ",\n")}\n${indentOf(depth)}${close}`;
  return Match.value(value).pipe(
    Match.when(Array.isArray, (items: ReadonlyArray<unknown>) => {
      const inline = `[${Array.join(
        Array.map(items, (item) => quote(item)),
        ", ",
      )}]`;
      return Array.isReadonlyArrayEmpty(items)
        ? "[]"
        : Array.every(items, isScalar) && lead.length + inline.length + tail <= WIDTH
          ? inline
          : expanded(
              "[",
              "]",
              Array.map(
                items,
                (item, at) =>
                  `${inner}${formatJson(item, depth + 1, inner, at < items.length - 1 ? 1 : 0)}`,
              ),
            );
    }),
    Match.when(isProperties, (object) => {
      const entries = Record.toEntries(object);
      return Array.isReadonlyArrayEmpty(entries)
        ? "{}"
        : expanded(
            "{",
            "}",
            Array.map(entries, ([key, item], at) => {
              const head = `${inner}${quote(key)}: `;
              return `${head}${formatJson(item, depth + 1, head, at < entries.length - 1 ? 1 : 0)}`;
            }),
          );
    }),
    Match.orElse(() => quote(value)),
  );
};

const shasOf = <S extends string>(commits: ReadonlyArray<{ readonly sha: S }>): ReadonlyArray<S> =>
  Array.map(commits, ({ sha }) => sha);

/** Whether the manifest's snapshot of a task, its status and commits, is not what git and the events derive. */
const isStale = (snapshot: Manifest["tasks"][number], derived: TraceTask) =>
  snapshot.status !== derived.status || !Equal.equals(snapshot.commits, shasOf(derived.commits));

/**
 * `manifest.json` with each task's `status` and `commits` set to the derived ones, every other
 * byte of its content and its key order kept, printed as oxfmt prints it.
 */
export const snapshotText = (raw: string, tasks: ReadonlyArray<TraceTask>): string => {
  const derived = Record.fromIterableBy(tasks, (task) => task.id);
  const document = decodeDocument(raw);
  const patched = Record.map(document, (value, key) =>
    key === "tasks" && isTasks(value)
      ? Array.map(value, (task) =>
          Option.match(
            Option.flatMap(Option.liftPredicate(task["id"], Schema.is(TaskId)), (id) =>
              Record.get(derived, id),
            ),
            {
              onNone: () => task,
              onSome: (fresh) => ({
                ...task,
                commits: shasOf(fresh.commits),
                status: fresh.status,
              }),
            },
          ),
        )
      : value,
  );
  return `${formatJson(patched, 0, "", 0)}\n`;
};

/**
 * Writes the derived status and commits into `manifest.json` in the main checkout when they differ
 * from its snapshot, and says so. A manifest that already matches is not touched.
 */
export const refreshSnapshot = Effect.fn("status.refreshSnapshot")(function* (
  manifest: Manifest,
  tasks: ReadonlyArray<TraceTask>,
) {
  const stale = Array.filter(manifest.tasks, (snapshot) =>
    Array.some(tasks, (task) => task.id === snapshot.id && isStale(snapshot, task)),
  );
  if (Array.isReadonlyArrayEmpty(stale)) {
    return false;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const file = path.join(root, CAIRN_DIRECTORY, MANIFEST_FILE);
  const raw = yield* fs.readFileString(file);
  yield* replaceFile(file, snapshotText(raw, tasks));
  return true;
});

/** The tasks a task waits on that sit in another stack and have not landed: it cannot start until they do. */
const waitsFor = (tasks: ReadonlyArray<ManifestTask>) => {
  const stackOfTask = Record.fromEntries(
    Array.flatMap(stacksOf(tasks), (stack) =>
      Array.map(Record.keys(stack.cells), (id) => [id, stack.root] as const),
    ),
  );
  const statuses = Record.fromIterableWith(tasks, (task) => [task.id, task.status] as const);
  return (task: ManifestTask): Option.Option<string> => {
    const blocking = Array.filter(
      task.dependsOn,
      (id) =>
        !Equal.equals(Record.get(stackOfTask, id), Record.get(stackOfTask, task.id)) &&
        Option.exists(Record.get(statuses, id), (status) => status !== "landed"),
    );
    return Array.match(blocking, {
      onEmpty: Option.none,
      onNonEmpty: (ids) => Option.some(`waits for ${Array.join(ids, ", ")} to land`),
    });
  };
};

const encodeTrace = Schema.encodeSync(Schema.fromJsonString(Trace, { space: 2 }));

/** The text of `cairn status`: each stack as a tree, then one line per warning. */
export const statusLines = (trace: Trace): ReadonlyArray<string> => {
  const tasks = Array.map(trace.tasks, (task) =>
    // The effective gate: `derive` finds gates a manifest's `humanGate` does not have.
    Struct.assign(task, { commits: shasOf(task.commits), humanGate: task.gate }),
  );
  return Array.appendAll(
    stackLines(tasks, { branch: true, note: waitsFor(tasks) }),
    Array.map(trace.warnings, (warning) => `warning: ${warning.message}`),
  );
};

/**
 * `cairn status`: each stack as a tree, one line per task with its status, branch, model and gate,
 * then the warnings; or with `json` the Trace. Both bring the manifest's snapshot up to date.
 */
export const status = Effect.fn("status")(function* (options: { readonly json: boolean }) {
  // The JSON is the Trace the server serves, notes and all; the tree shows no notes.
  const input = yield* options.json ? loadServedTraceInput : loadTraceInput;
  const trace = traceOf(input);
  yield* refreshSnapshot(input.manifest, trace.tasks);
  if (options.json) {
    yield* Console.log(encodeTrace(trace));
  } else {
    yield* Effect.forEach(statusLines(trace), (line) => Console.log(line), { discard: true });
  }
  return trace;
});

export const statusCommand = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the Trace the server serves as JSON"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    // Git is read in the main checkout, and only a command that reads it needs a repository.
    status({ json }).pipe(
      Effect.asVoid,
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const root = yield* (yield* MainCheckout).root;
            return Layer.merge(gitLayer(root), TraceStore.layer);
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("Print each stack with its tasks' status, then the warnings"));
