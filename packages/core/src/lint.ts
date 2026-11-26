import { IndexedSection, SectionPrefix, ownerOf } from "@cairn/contract";
import type {
  HumanGate,
  Manifest,
  ManifestTask,
  Section,
  SpecIndex,
  TaskId,
} from "@cairn/contract";
import {
  Array,
  Equal,
  Equivalence,
  HashSet,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schema,
  String,
} from "effect";

import { drawsOf, mermaidBlocksOf } from "./diagrams.ts";
import { gateOf } from "./gates.ts";
import type { GateConfig } from "./gates.ts";
import { itemsOf } from "./items.ts";
import type { Item } from "./items.ts";
import { stalenessOf, uncoveredItemsOf, uncoveredOf } from "./replan.ts";
import { linesOf } from "./section-ids.ts";
import { keyEntriesOf, sectionsOf } from "./sections.ts";
import { statementsOf, taskStatementsOf } from "./statements.ts";
import type { Statement } from "./statements.ts";
import { parentOf } from "./stack.ts";
import { derivedOf } from "./spec-index.ts";
import type { DerivedSection } from "./spec-index.ts";
import { withStackDiagram } from "./stack-diagram.ts";

/** The rules `lint` checks (see `spec.lint`). */
export const LintRule = Schema.Literals([
  "unknown-section",
  "unmapped-section",
  "unmapped-item",
  "missing-id",
  "duplicate-id",
  "wrong-prefix",
  "bad-parent",
  "parent-mismatch",
  "worktree-clash",
  "gate-mismatch",
  "index-drift",
  "statement-owner",
  "draft-statement",
  "unproved-statement",
  "task-without-statement",
  "no-commits-landed",
  "bad-diagram",
  "diagram-drift",
  "stale-section",
  "stale-task",
  "unknown-category",
  "missing-category",
]);
export type LintRule = typeof LintRule.Type;

export const Severity = Schema.Literals(["error", "warning"]);
export type Severity = typeof Severity.Type;

/** The file a finding is in, relative to `.cairn/`. */
export const LintFile = Schema.Literals(["prd.md", "spec.md", "manifest.json", "spec.json"]);
export type LintFile = typeof LintFile.Type;

/**
 * One thing `lint` found. `line` is 1-based; a finding about a task in `manifest.json` has none,
 * since `lint` reads the decoded manifest, and its message names the task.
 */
export const Finding = Schema.Struct({
  file: LintFile,
  line: Schema.Option(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  message: Schema.String,
  rule: LintRule,
  severity: Severity,
});
export type Finding = typeof Finding.Type;

const SEVERITY: { readonly [Rule in LintRule]: Severity } = {
  "bad-diagram": "error",
  "bad-parent": "error",
  "diagram-drift": "error",
  "draft-statement": "warning",
  "duplicate-id": "error",
  "gate-mismatch": "error",
  "index-drift": "warning",
  "missing-id": "error",
  "no-commits-landed": "warning",
  "parent-mismatch": "error",
  "stale-section": "warning",
  "stale-task": "warning",
  "missing-category": "warning",
  "unknown-category": "error",
  "statement-owner": "error",
  "task-without-statement": "warning",
  "unknown-section": "error",
  "unmapped-item": "error",
  "unmapped-section": "error",
  "unproved-statement": "warning",
  "worktree-clash": "error",
  "wrong-prefix": "error",
};

const findingOf = (
  rule: LintRule,
  file: LintFile,
  line: Option.Option<number>,
  message: string,
): Finding => ({ file, line, message, rule, severity: SEVERITY[rule] });

/** A markdown file of the plan, parsed. */
interface Document {
  readonly file: LintFile;
  readonly items: ReadonlyArray<Item>;
  readonly prefix: SectionPrefix;
  readonly sections: ReadonlyArray<Section>;
}

/** A heading or a list item that has an ID, with where it is. */
interface Identified {
  readonly file: LintFile;
  readonly id: string;
  readonly line: number;
}

/** The headings and the list items of a document that have an ID, headings first. */
const identifiedOf = (document: Document): ReadonlyArray<Identified> =>
  Array.getSomes(
    Array.appendAll(
      Array.map(document.sections, (section) =>
        Option.map(Option.fromUndefinedOr(section.id), (id) => ({
          file: document.file,
          id,
          line: section.line,
        })),
      ),
      Array.map(document.items, (item) =>
        Option.map(Option.fromUndefinedOr(item.id), (id) => ({
          file: document.file,
          id,
          line: item.line,
        })),
      ),
    ),
  );

const missingIds = (document: Document): ReadonlyArray<Finding> =>
  Array.filterMap(document.sections, (section) =>
    Predicate.isUndefined(section.id)
      ? Result.succeed(
          findingOf(
            "missing-id",
            document.file,
            Option.some(section.line),
            `The heading "${section.title}" has no ID. Run cairn ids to add one.`,
          ),
        )
      : Result.failVoid,
  );

/** Mermaid blocks of a file that do not draw, each with the parser's error. */
const badDiagrams = (file: LintFile, markdown: string): ReadonlyArray<Finding> =>
  Array.filterMap(mermaidBlocksOf(markdown), (block) =>
    Option.match(drawsOf(block.source), {
      onNone: () => Result.failVoid,
      onSome: (error) =>
        Result.succeed(
          findingOf(
            "bad-diagram",
            file,
            Option.some(block.start + 1),
            `The Mermaid diagram does not draw: ${error}`,
          ),
        ),
    }),
  );

/**
 * The stack diagram of `spec.md` when it is not what `stackDiagramOf` draws from the manifest:
 * what is between the markers differs, or there are no markers to hold it. It points at the first
 * line that `withStackDiagram` would change. Without a manifest there is nothing to draw.
 */
const diagramDrift = (spec: string, manifest: Option.Option<Manifest>): ReadonlyArray<Finding> =>
  Option.match(manifest, {
    onNone: () => [],
    onSome: (plan) => {
      const drawn = withStackDiagram(spec, plan);
      const lines = linesOf(spec);
      return drawn === spec
        ? []
        : [
            findingOf(
              "diagram-drift",
              "spec.md",
              Option.some(
                Order.min(Order.Number)(
                  Array.length(lines),
                  1 +
                    Option.getOrElse(
                      Array.findFirstIndex(
                        Array.zipWith(lines, linesOf(drawn), (line, other) => line === other),
                        (same) => !same,
                      ),
                      () => Array.length(lines),
                    ),
                ),
              ),
              "The stack diagram does not match manifest.json. Run cairn plan to draw it again.",
            ),
          ];
    },
  });

/** Every heading after the first with a given ID, in either file, pointing at the first. */
const duplicateIds = (headings: ReadonlyArray<Identified>): ReadonlyArray<Finding> =>
  Array.flatMap(Record.values(Array.groupBy(headings, (heading) => heading.id)), (group) => {
    const [first, ...later] = group;
    return Array.map(later, (heading) =>
      findingOf(
        "duplicate-id",
        heading.file,
        Option.some(heading.line),
        `${heading.id} is already the ID of the heading at ${first.file}:${first.line}.`,
      ),
    );
  });

const wrongPrefixes = (document: Document): ReadonlyArray<Finding> =>
  Array.filterMap(identifiedOf(document), (heading) =>
    String.startsWith(`${document.prefix}.`)(heading.id)
      ? Result.failVoid
      : Result.succeed(
          findingOf(
            "wrong-prefix",
            document.file,
            Option.some(heading.line),
            `${heading.id} is in ${document.file}, where every ID starts with ${document.prefix}.`,
          ),
        ),
  );

/** The file whose headings each key names. A `Files` key names paths. */
const KEY_TARGETS: Record.ReadonlyRecord<string, LintFile> = {
  Context: "prd.md",
  Defers: "prd.md",
  "Depends on": "spec.md",
  Implements: "prd.md",
};

/**
 * Values a spec section's own keys name that no heading has. Keys are read as written, so a value
 * with the other file's prefix is reported too; an inherited value is reported where it is written.
 */
const unknownInKeys = (
  spec: Document,
  prdIds: HashSet.HashSet<string>,
  specIds: HashSet.HashSet<string>,
): ReadonlyArray<Finding> =>
  Array.flatMap(spec.sections, (section) =>
    Array.flatMap(keyEntriesOf(String.split(section.body, "\n")), ([name, values]) =>
      Option.match(Record.get(KEY_TARGETS, name), {
        onNone: () => [],
        onSome: (file) =>
          Array.filterMap(values, (id) =>
            HashSet.has(file === "prd.md" ? prdIds : specIds, id)
              ? Result.failVoid
              : Result.succeed(
                  findingOf(
                    "unknown-section",
                    spec.file,
                    Option.some(section.line),
                    `${name} names ${id}, which no heading in ${file} has.`,
                  ),
                ),
          ),
      }),
    ),
  );

/** IDs a task names that no heading has, including a heading that was deleted. */
const unknownInTasks = (
  manifest: Manifest,
  prdIds: HashSet.HashSet<string>,
  specIds: HashSet.HashSet<string>,
): ReadonlyArray<Finding> =>
  Array.flatMap(manifest.tasks, (task) => {
    const unknown = (ids: ReadonlyArray<string>, known: HashSet.HashSet<string>, file: LintFile) =>
      Array.filterMap(ids, (id) =>
        HashSet.has(known, id)
          ? Result.failVoid
          : Result.succeed(
              findingOf(
                "unknown-section",
                "manifest.json",
                Option.none(),
                `${task.id} names ${id}, which no heading in ${file} has.`,
              ),
            ),
      );
    return Array.appendAll(
      unknown(task.prdSections, prdIds, "prd.md"),
      unknown(task.specSections, specIds, "spec.md"),
    );
  });

/** PRD sections no spec section covers (see `spec.format`). */
const unmapped = (prd: Document, spec: Document): ReadonlyArray<Finding> =>
  Array.map(uncoveredOf(prd.sections, spec.sections, prd.items), ({ id, section }) =>
    findingOf(
      "unmapped-section",
      prd.file,
      Option.some(section.line),
      `${id} is not implemented, deferred or given as context by any spec section.`,
    ),
  );

/** PRD items with an ID that no spec section covers (see `spec.sections.item-coverage`). */
const unmappedItems = (prd: Document, spec: Document): ReadonlyArray<Finding> =>
  Array.map(uncoveredItemsOf(prd.sections, spec.sections, prd.items), ({ id, line }) =>
    findingOf(
      "unmapped-item",
      prd.file,
      Option.some(line),
      `${id} is not implemented, deferred or given as context by any spec section. An Implements that names the section around it does not cover it.`,
    ),
  );

/** Spec sections and tasks that went out of date (see `spec.planning.again`). */
const staleFindings = (
  prd: Document,
  spec: Document,
  index: SpecIndex,
  tasks: ReadonlyArray<ManifestTask>,
): ReadonlyArray<Finding> => {
  const staleness = stalenessOf(prd.sections, spec.sections, index, tasks);
  return Array.appendAll(
    Array.map(staleness.sections, ({ changed, id, section }) =>
      findingOf(
        "stale-section",
        spec.file,
        Option.some(section.line),
        `${id} implements ${Array.join(changed, ", ")}, which changed after ${id} was written. Update the section if it needs it, then run cairn plan --accept ${id}.`,
      ),
    ),
    Array.flatMap(staleness.tasks, ({ edited, stale, task }) =>
      Array.appendAll(
        Array.map(stale, (id) =>
          taskFinding("stale-task", `${task.id} builds ${id}, which is stale.`),
        ),
        Array.map(edited, (id) =>
          taskFinding(
            "stale-task",
            `${task.id} builds ${id}, which was edited after ${task.id} was planned.`,
          ),
        ),
      ),
    ),
  );
};

/** Every node reachable from `start` along `edges`; `start` is in it only when a cycle leads back. */
const reachableFrom = <A>(edges: (node: A) => ReadonlyArray<A>, start: A): HashSet.HashSet<A> => {
  const visit = (seen: HashSet.HashSet<A>, node: A): HashSet.HashSet<A> =>
    Array.reduce(edges(node), seen, (found, next) =>
      HashSet.has(found, next) ? found : visit(HashSet.add(found, next), next),
    );
  return visit(HashSet.empty(), start);
};

const taskFinding = (rule: LintRule, message: string): Finding =>
  findingOf(rule, "manifest.json", Option.none(), message);

/** What `lint` reads from the config: the high-trust paths and the task categories. */
export interface LintConfig extends GateConfig {
  /** Without it, no task's category is checked. */
  readonly categories?: ReadonlyArray<{ readonly name: string }>;
}

/** A task with a category the config lacks, or with none (`spec.planning.task-categories`). */
const categoryFindings = (
  tasks: ReadonlyArray<ManifestTask>,
  categories: ReadonlyArray<{ readonly name: string }>,
): ReadonlyArray<Finding> => {
  const known = HashSet.fromIterable(Array.map(categories, ({ name }) => name));
  return Array.flatMap(tasks, (task) =>
    Option.match(Option.fromUndefinedOr(task.category), {
      onNone: () => [taskFinding("missing-category", `${task.id} has no category.`)],
      onSome: (category) =>
        HashSet.has(known, category)
          ? []
          : [
              taskFinding(
                "unknown-category",
                `${task.id}'s category ${category} is not in config.categories.`,
              ),
            ],
    }),
  );
};

const placeOf = (parent: TaskId | null): string =>
  Option.match(Option.fromNullOr(parent), { onNone: () => "the base branch", onSome: (id) => id });

const checkoutOf = (worktree: string | null): string =>
  Option.match(Option.fromNullOr(worktree), {
    onNone: () => "the repo's own checkout",
    onSome: (name) => `worktree ${name}`,
  });

/**
 * The fields of an entry in `spec.json` that code derives from `spec.md` and `manifest.json`, so
 * that they can drift from them (see `spec.contract.spec-index`). `writtenFrom` is recorded, not derived.
 */
const DERIVED_KEYS = [
  "children",
  "context",
  "defers",
  "dependsOn",
  "files",
  "human",
  "implements",
  "level",
  "line",
  "parent",
  "tasks",
  "title",
] as const;
type DerivedKey = (typeof DERIVED_KEYS)[number];

/** Whether two values of the derived field `key` are equal, by the field's schema. */
const SAME_BY_KEY: { readonly [K in DerivedKey]: Equivalence.Equivalence<DerivedSection[K]> } = {
  children: Schema.toEquivalence(IndexedSection.fields.children),
  context: Schema.toEquivalence(IndexedSection.fields.context),
  defers: Schema.toEquivalence(IndexedSection.fields.defers),
  dependsOn: Schema.toEquivalence(IndexedSection.fields.dependsOn),
  files: Schema.toEquivalence(IndexedSection.fields.files),
  human: Schema.toEquivalence(IndexedSection.fields.human),
  implements: Schema.toEquivalence(IndexedSection.fields.implements),
  level: Schema.toEquivalence(IndexedSection.fields.level),
  line: Schema.toEquivalence(IndexedSection.fields.line),
  parent: Schema.toEquivalence(IndexedSection.fields.parent),
  tasks: Schema.toEquivalence(IndexedSection.fields.tasks),
  title: Schema.toEquivalence(IndexedSection.fields.title),
};

/** Whether one value and another of the derived field `key` are equal. */
const sameField = <K extends DerivedKey>(
  key: K,
  one: DerivedSection[K],
  other: DerivedSection[K],
): boolean => SAME_BY_KEY[key](one, other);

/** The derived fields whose values in `entry` differ from `expected`, in `DERIVED_KEYS` order. */
const driftedKeys = (entry: DerivedSection, expected: DerivedSection): ReadonlyArray<DerivedKey> =>
  Array.filter(DERIVED_KEYS, (key) => !sameField(key, entry[key], expected[key]));

/** An `index-drift` finding about `spec.json`, which has no line of its own. */
const drift = (message: string): Finding =>
  findingOf("index-drift", "spec.json", Option.none(), message);

/**
 * What `spec.json` gets wrong about `spec.md` and `manifest.json`: a section with no entry, an
 * entry for no section, and a derived field of an entry that the files do not give.
 */
const indexDrift = (
  prd: string,
  spec: string,
  tasks: ReadonlyArray<ManifestTask>,
  index: SpecIndex,
): ReadonlyArray<Finding> => {
  const expected = derivedOf({
    manifest: { tasks },
    prd,
    previous: Option.none(),
    spec,
    written: [],
  });
  const entries = Record.fromEntries(
    Array.map(index.sections, (entry) => [entry.id, entry] as const),
  );
  const expectedIds = HashSet.fromIterable(Array.map(expected, (section) => section.id));
  return Array.flatten([
    Array.flatMap(expected, (section) =>
      Option.match(Record.get(entries, section.id), {
        onNone: () => [drift(`spec.json has no entry for ${section.id}. Run cairn plan.`)],
        onSome: (entry) =>
          Array.map(driftedKeys(entry, section), (key) =>
            drift(
              `${section.id}'s ${key} in spec.json differs from spec.md or manifest.json. Run cairn plan.`,
            ),
          ),
      }),
    ),
    Array.filterMap(index.sections, (entry) =>
      HashSet.has(expectedIds, entry.id)
        ? Result.failVoid
        : Result.succeed(
            drift(
              `spec.json has an entry for ${entry.id}, which spec.md does not have. Run cairn plan.`,
            ),
          ),
    ),
  ]);
};

const gateText = (gate: HumanGate): string =>
  gate.required ? `required (${Array.join(gate.reasons, ", ")})` : "not required";

const sameGate = (one: HumanGate, other: HumanGate): boolean =>
  one.required === other.required &&
  Equal.equals(HashSet.fromIterable(one.reasons), HashSet.fromIterable(other.reasons));

/** A landed task with no commits: its landing was never recorded. */
const unrecorded = (task: ManifestTask): ReadonlyArray<Finding> =>
  task.status === "landed" && Array.isReadonlyArrayEmpty(task.commits)
    ? [taskFinding("no-commits-landed", `${task.id} is landed but has no commits.`)]
    : [];

/**
 * What is wrong with the manifest's stacks: parents and dependencies that are not tasks or that
 * form a cycle, parents `parentOf` would not give, worktrees shared by tasks that could run at the
 * same time, gates plan-time detection would not give, and landed tasks with no commits.
 */
const stackFindings = (
  manifest: Manifest,
  sections: ReadonlyArray<Section>,
  items: ReadonlyArray<Item>,
  config: GateConfig,
): ReadonlyArray<Finding> => {
  const tasks: ReadonlyArray<ManifestTask> = manifest.tasks;
  const known = HashSet.fromIterable(Array.map(tasks, (task) => task.id));
  const byId = Record.fromEntries(Array.map(tasks, (task) => [task.id, task] as const));
  const linksOf = (pick: (task: ManifestTask) => ReadonlyArray<TaskId>) => (id: TaskId) =>
    Option.match(Record.get(byId, id), {
      onNone: () => [],
      onSome: (task) => Array.filter(pick(task), (link) => HashSet.has(known, link)),
    });
  const tableOf = (pick: (task: ManifestTask) => ReadonlyArray<TaskId>) =>
    Record.fromEntries(
      Array.map(tasks, (task) => [task.id, reachableFrom(linksOf(pick), task.id)] as const),
    );
  const below = tableOf((task) =>
    Array.appendAll(task.dependsOn, Option.toArray(Option.fromNullOr(task.parent))),
  );
  const needs = tableOf((task) => task.dependsOn);
  const lookup = (table: typeof needs, id: TaskId) =>
    Option.getOrElse(Record.get(table, id), () => HashSet.empty<TaskId>());

  const badParents = (task: ManifestTask): ReadonlyArray<Finding> => {
    const strays = Array.appendAll(
      Option.match(Option.fromNullOr(task.parent), {
        onNone: () => [],
        onSome: (parent) =>
          HashSet.has(known, parent)
            ? []
            : [`${task.id}'s parent ${parent} is not in the manifest.`],
      }),
      Array.filterMap(task.dependsOn, (id) =>
        HashSet.has(known, id)
          ? Result.failVoid
          : Result.succeed(`${task.id} depends on ${id}, which is not in the manifest.`),
      ),
    );
    const cycle = HashSet.has(lookup(below, task.id), task.id)
      ? [
          Array.match(
            Array.filter(
              tasks,
              (other) =>
                other.id !== task.id &&
                HashSet.has(lookup(below, task.id), other.id) &&
                HashSet.has(lookup(below, other.id), task.id),
            ),
            {
              onEmpty: () => `${task.id} depends on itself.`,
              onNonEmpty: (others) =>
                `${task.id} is in a cycle with ${Array.join(
                  Array.map(others, (other) => other.id),
                  ", ",
                )}.`,
            },
          ),
        ]
      : [];
    return Array.map(Array.appendAll(strays, cycle), (message) =>
      taskFinding("bad-parent", message),
    );
  };

  const parentMismatch = (task: ManifestTask): ReadonlyArray<Finding> => {
    const expected = Option.getOrNull(parentOf(task.dependsOn, tasks));
    return expected === task.parent
      ? []
      : [
          taskFinding(
            "parent-mismatch",
            `${task.id} sits on ${placeOf(task.parent)}, but its dependencies put it on ${placeOf(expected)}.`,
          ),
        ];
  };

  const clashes = (task: ManifestTask, earlier: ReadonlyArray<ManifestTask>) =>
    Array.filterMap(earlier, (other) =>
      other.worktree === task.worktree &&
      !HashSet.has(lookup(needs, task.id), other.id) &&
      !HashSet.has(lookup(needs, other.id), task.id)
        ? Result.succeed(
            taskFinding(
              "worktree-clash",
              `${other.id} and ${task.id} share ${checkoutOf(task.worktree)}, and neither depends on the other.`,
            ),
          )
        : Result.failVoid,
    );

  const gateMismatch = (task: ManifestTask): ReadonlyArray<Finding> => {
    const detected = gateOf(task, sections, config, [], items);
    return sameGate(task.humanGate, detected)
      ? []
      : [
          taskFinding(
            "gate-mismatch",
            `${task.id}'s gate is ${gateText(task.humanGate)}, but plan-time detection finds ${gateText(detected)}.`,
          ),
        ];
  };

  return Array.flatMap(tasks, (task, at) =>
    Array.flatten([
      badParents(task),
      parentMismatch(task),
      clashes(task, Array.take(tasks, at)),
      gateMismatch(task),
      unrecorded(task),
    ]),
  );
};

/** A statement whose ID names a section or item other than the one it sits under. */
const statementOwners = (statements: ReadonlyArray<Statement>): ReadonlyArray<Finding> =>
  Array.filterMap(statements, (statement) =>
    Predicate.isNotUndefined(statement.id) && ownerOf(statement.id) !== statement.owner
      ? Result.succeed(
          findingOf(
            "statement-owner",
            "prd.md",
            Option.some(statement.line),
            `The statement ${statement.id} sits under ${statement.owner}, which is not the owner its ID names. Give it an ID of its own.`,
          ),
        )
      : Result.failVoid,
  );

const statementName = (statement: Statement): string =>
  Option.match(Option.fromUndefinedOr(statement.id), {
    onNone: () => `on line ${statement.line}`,
    onSome: (id) => id,
  });

/** A statement that is still a draft: Cairn wrote it and no person has confirmed it. */
const draftStatements = (statements: ReadonlyArray<Statement>): ReadonlyArray<Finding> =>
  Array.filterMap(statements, (statement) =>
    statement.draft
      ? Result.succeed(
          findingOf(
            "draft-statement",
            "prd.md",
            Option.some(statement.line),
            `The statement ${statementName(statement)} is a draft. Confirm it in prd.md, or run cairn plan to be asked.`,
          ),
        )
      : Result.failVoid,
  );

/**
 * A statement with an ID, not tagged for a person, that is in no test's `proves` in any spec
 * section that implements its owner.
 */
const unprovedStatements = (
  statements: ReadonlyArray<Statement>,
  index: SpecIndex,
): ReadonlyArray<Finding> =>
  Array.filterMap(statements, (statement) => {
    const id = statement.id;
    return Predicate.isUndefined(id) ||
      statement.human ||
      Array.some(
        Array.filter(index.sections, (section) =>
          Array.contains(section.implements, statement.owner),
        ),
        (section) => Array.some(section.tests, (test) => Array.contains(test.proves, id)),
      )
      ? Result.failVoid
      : Result.succeed(
          findingOf(
            "unproved-statement",
            "prd.md",
            Option.some(statement.line),
            `The statement ${id} is in no test's proves in a spec section that implements ${statement.owner}.`,
          ),
        );
  });

/** A task none of whose PRD sections has a statement with an ID. */
const tasksWithoutStatements = (
  statements: ReadonlyArray<Statement>,
  tasks: ReadonlyArray<ManifestTask>,
): ReadonlyArray<Finding> =>
  Array.filterMap(tasks, (task) =>
    Array.isReadonlyArrayEmpty(taskStatementsOf(task, statements, []))
      ? Result.succeed(
          findingOf(
            "task-without-statement",
            "manifest.json",
            Option.none(),
            `${task.id} carries no done-when statement: none of ${Array.join(task.prdSections, ", ")} has one.`,
          ),
        )
      : Result.failVoid,
  );

const FILE_ORDER: ReadonlyArray<LintFile> = ["prd.md", "spec.md", "manifest.json", "spec.json"];

/** By file, then by line; a finding with no line comes last in its file. */
const byPlace: Order.Order<Finding> = Order.combine(
  Order.mapInput(Order.Number, (finding: Finding) =>
    Option.getOrElse(
      Array.findFirstIndex(FILE_ORDER, (file) => file === finding.file),
      () => 0,
    ),
  ),
  Order.mapInput(Order.Number, (finding: Finding) =>
    Option.getOrElse(finding.line, () => Number.POSITIVE_INFINITY),
  ),
);

/**
 * What is wrong with a plan (see `spec.lint`): its section IDs and coverage, its stacks and
 * gates, and what went out of date. `prd` and `spec` are the markdown of `prd.md` and
 * `spec.md`; there is no manifest before the tasks are planned. `config` gives the high-trust
 * paths gate detection reads. `index` is `spec.json`; without it nothing is reported stale.
 */
export const lint = (
  prd: string,
  spec: string,
  manifest: Option.Option<Manifest>,
  config: LintConfig,
  index: Option.Option<SpecIndex> = Option.none(),
): ReadonlyArray<Finding> => {
  const prdSections = sectionsOf(prd);
  const specSections = sectionsOf(spec);
  const prdDocument: Document = {
    file: "prd.md",
    items: itemsOf(prd, prdSections),
    prefix: "prd",
    sections: prdSections,
  };
  const specDocument: Document = {
    file: "spec.md",
    items: itemsOf(spec, specSections),
    prefix: "spec",
    sections: specSections,
  };
  const prdIds = HashSet.fromIterable(Array.map(identifiedOf(prdDocument), ({ id }) => id));
  const specIds = HashSet.fromIterable(Array.map(identifiedOf(specDocument), ({ id }) => id));
  const tasks = Option.match(manifest, { onNone: () => [], onSome: (plan) => plan.tasks });
  const statements = statementsOf(prd, prdSections, prdDocument.items);
  const findings = Array.flatten([
    missingIds(prdDocument),
    missingIds(specDocument),
    duplicateIds(Array.appendAll(identifiedOf(prdDocument), identifiedOf(specDocument))),
    wrongPrefixes(prdDocument),
    wrongPrefixes(specDocument),
    unknownInKeys(specDocument, prdIds, specIds),
    unmapped(prdDocument, specDocument),
    statementOwners(statements),
    draftStatements(statements),
    tasksWithoutStatements(statements, tasks),
    unmappedItems(prdDocument, specDocument),
    badDiagrams("prd.md", prd),
    badDiagrams("spec.md", spec),
    diagramDrift(spec, manifest),
    Option.match(manifest, {
      onNone: () => [],
      onSome: (plan) =>
        Array.flatten([
          unknownInTasks(plan, prdIds, specIds),
          stackFindings(
            plan,
            Array.appendAll(prdDocument.sections, specDocument.sections),
            prdDocument.items, // the spec's items gate nothing and are read for their IDs only
            config,
          ),
          Option.match(Option.fromUndefinedOr(config.categories), {
            onNone: () => [],
            onSome: (categories) => categoryFindings(plan.tasks, categories),
          }),
        ]),
    }),
    Option.match(index, {
      onNone: () => [],
      onSome: (written) => indexDrift(prd, spec, tasks, written),
    }),
    Option.match(index, {
      onNone: () => [],
      onSome: (written) => unprovedStatements(statements, written),
    }),
    Option.match(index, {
      onNone: () => [],
      onSome: (written) => staleFindings(prdDocument, specDocument, written, tasks),
    }),
  ]);
  return Array.sort(findings, byPlace);
};
