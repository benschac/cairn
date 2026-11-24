// Pure reporting for scripts/tasks/tasks.ts: sort the manifest's tasks into finished, drifted, active, claimed,
// ready and blocked from what main, GitHub, the worktrees and the board say, and print them.

import type { IndexedSection, Manifest, ManifestTask, SpecIndex } from "@cairn/contract";
import {
  Array,
  DateTime,
  Duration,
  HashSet,
  Number,
  Option,
  Order,
  pipe,
  Predicate,
  Record,
  Schema,
  String,
} from "effect";

// The fields of `gh pr list --json` that the report reads.
export const Pull = Schema.Struct({
  number: Schema.Int,
  headRefName: Schema.String,
  headRefOid: Schema.String,
});
export type Pull = typeof Pull.Type;

export const PULL_FIELDS = Array.join(Record.keys(Pull.fields), ",");

const BoardMessage = Schema.Struct({
  text: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

// One thread of `vercel board read <channel> --json`: its first message and its latest reply.
export const Thread = Schema.Struct({
  message: Schema.Struct({
    text: Schema.String,
    createdAt: Schema.DateTimeUtcFromString,
    labels: Schema.Record(Schema.String, Schema.Unknown),
  }),
  last: Schema.NullOr(BoardMessage),
});
export type Thread = typeof Thread.Type;

export const BoardRead = Schema.Struct({ threads: Schema.Array(Thread) });

export type Worktree = { readonly path: string; readonly branch: string };

// What follows `prefix` on the first line that starts with it.
const after = (prefix: string) => (lines: ReadonlyArray<string>) =>
  Option.map(Array.findFirst(lines, String.startsWith(prefix)), String.slice(prefix.length));

// The worktrees of `git worktree list --porcelain` that have a branch checked out.
export const parseWorktrees = (porcelain: string): Array<Worktree> =>
  Array.getSomes(
    Array.map(String.split(porcelain, "\n\n"), (block) => {
      const lines = String.split(block, "\n");
      return Option.all({
        path: after("worktree ")(lines),
        branch: after("branch refs/heads/")(lines),
      });
    }),
  );

const TRAILER = /^Cairn-Task:[ \t]*(\S+)/u;

// The task ids on the Cairn-Task lines of `git log --format=%B`. It reads lines as the contract's parseTrailers does,
// not git's trailer block: a commit with a blank line between its Cairn lines and Co-Authored-By has no trailers for git.
export const trailerTasks = (log: string): Array<string> =>
  Array.dedupe(
    Array.getSomes(
      Array.map(String.split(log, "\n"), (line) =>
        Option.flatMap(String.match(TRAILER)(line), (match) => Array.get(match, 1)),
      ),
    ),
  );

const TASK_IDS = /\bt(\d+)(?:\s*[-–]\s*t?(\d+))?\b/gu;
// A range longer than this is read as its first id only: it is more likely a typo than a claim.
const LONGEST_RANGE = 100;

// Every task id that `text` names, with a range such as "t82-t96" or "t82–96" spelled out.
export const taskIds = (text: string): Array<string> =>
  pipe(
    Array.fromIterable(String.matchAll(TASK_IDS)(text)),
    Array.flatMap((match) => {
      const number = (group: number) =>
        pipe(
          Array.get(match, group),
          Option.flatMap(Option.fromUndefinedOr),
          Option.flatMap(Number.parse),
        );
      return Option.match(number(1), {
        onNone: () => [],
        onSome: (first) => {
          const last = Option.getOrElse(number(2), () => first);
          return last >= first && last - first <= LONGEST_RANGE
            ? Array.range(first, last)
            : [first];
        },
      });
    }),
    Array.map((number) => `t${number}`),
    Array.dedupe,
  );

const label = (thread: Thread, key: string): Option.Option<string> =>
  Option.filter(Record.get(thread.message.labels, key), Predicate.isString);

// The tasks a thread claims: its `tasks` label when it has one, otherwise its `task` label and every id or range
// its first message names.
export const threadTasks = (thread: Thread): Array<string> =>
  taskIds(
    Option.getOrElse(
      label(thread, "tasks"),
      () => `${Option.getOrElse(label(thread, "task"), () => "")} ${thread.message.text}`,
    ),
  );

// A sentence that opens with one of these words, capitalised. "t30 landed; continuing on t31" is progress, not an end.
const STOPPED = /(?:^|[.!?;:]\s+)(?:Stopping|Stopped|Landed|Abandoned)\b/u;

// A thread is open until a sentence of its latest reply starts with Stopping, Stopped, Landed or Abandoned.
export const isOpen = (thread: Thread): boolean =>
  Option.match(Option.fromNullOr(thread.last), {
    onNone: () => true,
    onSome: (last) => Option.isNone(String.match(STOPPED)(last.text)),
  });

// How long ago `from` was, as minutes, hours or days.
export const age = (from: DateTime.Utc, now: DateTime.Utc): string => {
  const minutes = Math.floor(Duration.toMinutes(DateTime.distance(from, now)));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
};

// What the report knows besides the manifest.
export type Evidence = {
  // The Cairn-Task ids on main's commits: see trailerTasks.
  readonly trailers: ReadonlyArray<string>;
  // Merged pull requests whose head commit is on main.
  readonly merged: ReadonlyArray<Pull>;
  readonly open: ReadonlyArray<Pull>;
  readonly worktrees: ReadonlyArray<Worktree>;
  readonly threads: ReadonlyArray<Thread>;
  readonly now: DateTime.Utc;
};

// finished: the manifest says done or landed. drifted: the manifest says otherwise, but the task is on main.
// active: the manifest gives it a status other than pending. claimed: pending, with an open pull request, a worktree
// or an open board thread. ready: pending, unclaimed, and nothing it depends on is unfinished. blocked: the rest.
export const TaskState = Schema.Literals([
  "finished",
  "drifted",
  "active",
  "claimed",
  "ready",
  "blocked",
]);
export type TaskState = typeof TaskState.Type;

export type Row = {
  readonly task: ManifestTask;
  readonly state: TaskState;
  // Why the task is drifted, or what claims it.
  readonly evidence: ReadonlyArray<string>;
  // The tasks it depends on that are neither finished nor drifted.
  readonly waitsOn: ReadonlyArray<string>;
  // How many unfinished tasks depend on it, directly or through others.
  readonly unlocks: number;
};

const isFinished = Schema.is(Schema.Literals(["done", "landed"]));

// The last segment of a path.
const baseName = (path: string) => Array.lastNonEmpty(String.split(path, "/"));

// The items on a task's branch.
const onBranch = <A>(items: ReadonlyArray<A>, branch: (item: A) => string, task: ManifestTask) =>
  Array.filter(items, (item) => branch(item) === task.branch);

export const classify = (manifest: Manifest, evidence: Evidence): Array<Row> => {
  const trailers = HashSet.fromIterable(evidence.trailers);
  const openThreads = Array.map(Array.filter(evidence.threads, isOpen), (thread) => ({
    thread,
    ids: HashSet.fromIterable(threadTasks(thread)),
  }));
  const landed = (task: ManifestTask): Array<string> =>
    Array.appendAll(
      HashSet.has(trailers, task.id) ? ["Cairn-Task trailer on main"] : [],
      Array.map(
        onBranch(evidence.merged, (pull) => pull.headRefName, task),
        (pull) => `#${pull.number} merged`,
      ),
    );
  const claims = (task: ManifestTask): Array<string> =>
    Array.flatten([
      Array.map(
        onBranch(evidence.open, (pull) => pull.headRefName, task),
        (pull) => `PR #${pull.number}`,
      ),
      Array.map(
        onBranch(evidence.worktrees, (worktree) => worktree.branch, task),
        (worktree) => `worktree ${baseName(worktree.path)}`,
      ),
      Array.map(
        Array.filter(openThreads, ({ ids }) => HashSet.has(ids, task.id)),
        ({ thread }) => `board ${age(thread.message.createdAt, evidence.now)} ago`,
      ),
    ]);

  // Everything but ready and blocked, which need to know what the other tasks came to.
  const first = Array.map(manifest.tasks, (task) => {
    const proof = landed(task);
    const held = claims(task);
    const state = (): Option.Option<TaskState> => {
      if (isFinished(task.status)) return Option.some("finished");
      if (Array.isReadonlyArrayNonEmpty(proof)) return Option.some("drifted");
      if (task.status !== "pending") return Option.some("active");
      if (Array.isReadonlyArrayNonEmpty(held)) return Option.some("claimed");
      return Option.none();
    };
    const known = state();
    return { task, known, evidence: Option.contains(known, "drifted") ? proof : held };
  });

  const settled = HashSet.fromIterable(
    Array.map(
      Array.filter(
        first,
        ({ known }) => Option.contains(known, "finished") || Option.contains(known, "drifted"),
      ),
      ({ task }) => task.id as string,
    ),
  );
  const dependents = Record.map(
    Array.groupBy(
      Array.flatMap(manifest.tasks, (task) =>
        Array.map(task.dependsOn, (dependency) => ({
          dependency: dependency as string,
          id: task.id as string,
        })),
      ),
      ({ dependency }) => dependency,
    ),
    Array.map(({ id }) => id),
  );
  // Adds every task that depends on `id`, directly or through others, to `seen`.
  const reach = (seen: HashSet.HashSet<string>, id: string): HashSet.HashSet<string> =>
    Array.reduce(
      Option.getOrElse(Record.get(dependents, id), Array.empty<string>),
      seen,
      (found, next) => (HashSet.has(found, next) ? found : reach(HashSet.add(found, next), next)),
    );

  return Array.map(first, ({ task, known, evidence: reasons }) => {
    const waitsOn = Array.filter(task.dependsOn, (dependency) => !HashSet.has(settled, dependency));
    return {
      task,
      state: Option.getOrElse(known, () =>
        Array.isReadonlyArrayEmpty(waitsOn) ? "ready" : "blocked",
      ),
      evidence: reasons,
      waitsOn,
      unlocks: Array.countBy(reach(HashSet.empty(), task.id), (id) => !HashSet.has(settled, id)),
    };
  });
};

const inState = (rows: ReadonlyArray<Row>, state: TaskState) =>
  Array.filter(rows, (row) => row.state === state);

// A titled block of lines, or nothing when there are none.
const block = (title: string, lines: ReadonlyArray<string>): Array<string> =>
  Array.match(lines, {
    onEmpty: () => [],
    onNonEmpty: (some) => Array.appendAll(["", title], some),
  });

const listed = (items: ReadonlyArray<string>) => Array.join(items, ", ");

// A task on one line: its id, the model it is planned for, GATE for a human gate, its title and a note.
const line = (row: Row, note: string): string => {
  const { task } = row;
  const gate = task.humanGate.required ? "GATE " : "";
  return `  ${String.padEnd(6)(task.id)}${String.padEnd(15)(`${task.model}/${task.reasoning}`)}${gate}${task.title} (${note})`;
};

// Every unfinished task under what it is waiting for, most useful first.
export const renderOverview = (
  manifest: Manifest,
  rows: ReadonlyArray<Row>,
  evidence: Evidence,
): string => {
  const counts = Array.getSomes(
    Array.map(TaskState.literals, (state) => {
      const count = inState(rows, state).length;
      return count > 0 ? Option.some(`${count} ${state}`) : Option.none();
    }),
  );
  const unfinished = HashSet.fromIterable(
    Array.map(
      Array.filter(rows, (row) => row.state !== "finished" && row.state !== "drifted"),
      (row) => row.task.id as string,
    ),
  );
  const claimsUnfinished = (thread: Thread) =>
    isOpen(thread) && Array.some(threadTasks(thread), (id) => HashSet.has(unfinished, id));
  const ready = Array.sortWith(
    inState(rows, "ready"),
    (row) => row.unlocks,
    Order.flip(Order.Number),
  );
  return Array.join(
    Array.flatten([
      [`${manifest.feature}: ${rows.length} tasks: ${listed(counts)}`],
      block(
        "Drifted: on main, but the manifest does not say done",
        Array.map(inState(rows, "drifted"), (row) =>
          line(row, `${listed(row.evidence)}; manifest says ${row.task.status}`),
        ),
      ),
      block(
        "Board threads that claim unfinished tasks (a thread closes when a sentence of its last reply starts with Stopping or Landed)",
        Array.map(Array.filter(evidence.threads, claimsUnfinished), (thread) => {
          const branch = Option.getOrElse(label(thread, "branch"), () => "no branch");
          return `  ${String.padEnd(5)(age(thread.message.createdAt, evidence.now))}${branch}: ${thread.message.text}`;
        }),
      ),
      block(
        "Active",
        Array.map(inState(rows, "active"), (row) =>
          line(row, listed(Array.prepend(row.evidence, row.task.status))),
        ),
      ),
      block(
        "Claimed",
        Array.map(inState(rows, "claimed"), (row) => line(row, listed(row.evidence))),
      ),
      block(
        "Ready: nothing unfinished below it and nobody on it, most unlocking first",
        Array.map(ready, (row) => line(row, `unlocks ${row.unlocks}`)),
      ),
      block(
        "Blocked",
        Array.map(inState(rows, "blocked"), (row) => line(row, `waits on ${listed(row.waitsOn)}`)),
      ),
      ["", "One task with its files and spec line ranges: pnpm tasks <id>"],
    ]),
    "\n",
  );
};

// A spec section and the last line of its text, counting the sections under it: the line before the next section
// at its level or above, or `lastLine` for the last one.
export const sectionRange = (
  sections: ReadonlyArray<IndexedSection>,
  id: string,
  lastLine: number,
): Option.Option<{ section: IndexedSection; end: number }> =>
  Option.flatMap(
    Array.findFirstIndex(sections, (section) => section.id === id),
    (index) =>
      Option.map(Array.get(sections, index), (section) => ({
        section,
        end: pipe(
          Array.drop(sections, index + 1),
          Array.findFirst((next) => next.level <= section.level),
          Option.match({ onNone: () => lastLine, onSome: (next) => next.line - 1 }),
        ),
      })),
  );

// One task: what it waits on, what waits on it, its files, and where its spec sections are in the spec.
export const renderTask = (
  row: Row,
  rows: ReadonlyArray<Row>,
  index: SpecIndex,
  specLines: number,
): string => {
  const { task } = row;
  const stateOf = (id: string) =>
    Option.match(
      Array.findFirst(rows, (other) => other.task.id === id),
      { onNone: () => `${id} (not in the manifest)`, onSome: (other) => `${id} (${other.state})` },
    );
  const why = Array.appendAll(
    row.evidence,
    Array.match(row.waitsOn, {
      onEmpty: () => [],
      onNonEmpty: (ids) => [`waits on ${listed(ids)}`],
    }),
  );
  const dependents = Array.filter(rows, (other) => Array.contains(other.task.dependsOn, task.id));
  const orNone = (items: ReadonlyArray<string>) =>
    Array.match(items, { onEmpty: () => "none", onNonEmpty: listed });
  const indented = Array.map((item: string) => `    ${item}`);
  return Array.join(
    Array.flatten([
      [
        `${task.id}  ${task.title}`,
        `  state     ${row.state}${Array.isReadonlyArrayNonEmpty(why) ? `: ${listed(why)}` : ""}`,
        `  manifest  ${task.status}, ${task.model}/${task.reasoning}, ${task.humanGate.required ? `GATE (${listed(task.humanGate.reasons)})` : "no gate"}`,
        `  branch    ${task.branch}, parent ${Option.getOrElse(Option.fromNullOr(task.parent), () => "none")}, worktree ${Option.getOrElse(Option.fromNullOr(task.worktree), () => "none")}`,
        `  depends   ${orNone(Array.map(task.dependsOn, stateOf))}`,
        `  unlocks   ${orNone(Array.map(dependents, (other) => stateOf(other.task.id)))}`,
      ],
      block("  files", indented(task.files)),
      block(
        "  spec",
        indented(
          Array.map(task.specSections, (id) =>
            Option.match(sectionRange(index.sections, id, specLines), {
              onNone: () => `${id} (not in ${index.source})`,
              onSome: ({ section, end }) =>
                `${index.source}:${section.line}-${end}  ${id}  ${section.summary}`,
            }),
          ),
        ),
      ),
      block("  prd", indented(task.prdSections)),
      block("  commits", indented(task.commits)),
    ]),
    "\n",
  );
};
