import type {
  Event,
  IndexedSection,
  Manifest,
  ManifestTask,
  Section,
  SectionId,
  SectionStatus,
  Trace,
  TraceDocument,
  TraceJudgment,
  TraceSection,
} from "@cairn/contract";
import { Array, HashMap, Option, pipe } from "effect";

import { derive } from "./derive.ts";
import type { GitCommit } from "./derive.ts";
import type { GateConfig } from "./gates.ts";
import { sectionsOf } from "./sections.ts";

export const PRD_PATH = ".cairn/prd.md";
export const SPEC_PATH = ".cairn/spec.md";

/**
 * Rolls task statuses up to sections (`spec.status.section-rollup`): one entry for every section
 * with an ID in the PRD and the spec, in the order given. `traceOf` takes it as an argument so the
 * Trace does not depend on how the rollup is built.
 */
export type Rollup = (
  prd: ReadonlyArray<Section>,
  spec: ReadonlyArray<Section>,
  tasks: ReadonlyArray<Pick<ManifestTask, "prdSections" | "specSections" | "status">>,
) => ReadonlyArray<{ readonly id: SectionId; readonly status: SectionStatus }>;

/** What `traceOf` reads: the files, git and the judgments, all already loaded. */
export interface TraceInput {
  readonly commits: ReadonlyArray<GitCommit>;
  readonly config: GateConfig;
  readonly events: ReadonlyArray<Event>;
  /** Each judgment with `stale` already decided by the caller, who recomputes `inputsOf`. */
  readonly judgments: ReadonlyArray<TraceJudgment>;
  readonly manifest: Manifest;
  readonly prd: string;
  readonly rollup: Rollup;
  readonly spec: string;
  /** The sections of `spec.json`; empty when there is no index. */
  readonly specIndex: ReadonlyArray<Pick<IndexedSection, "id" | "summary">>;
}

/** A section with an ID as the Trace shows it; a heading with no ID yet is left out. */
const traceSectionOf = (
  section: Section,
  summaries: HashMap.HashMap<string, string>,
  isSpec: boolean,
): Option.Option<TraceSection> =>
  pipe(
    Option.fromUndefinedOr(section.id),
    Option.map((id): TraceSection => ({
      human: section.human,
      id,
      keys: isSpec
        ? section.keys
        : { context: [], defers: [], dependsOn: [], files: [], implements: [] },
      level: section.level,
      line: section.line,
      parent: Option.getOrNull(Option.fromUndefinedOr(section.parent)),
      summary: isSpec ? Option.getOrNull(HashMap.get(summaries, id)) : null,
      title: section.title,
    })),
  );

const documentOf = (
  path: string,
  markdown: string,
  sections: ReadonlyArray<Section>,
  summaries: HashMap.HashMap<string, string>,
  isSpec: boolean,
): TraceDocument => ({
  items: [],
  markdown,
  path,
  sections: Array.getSomes(
    Array.map(sections, (section) => traceSectionOf(section, summaries, isSpec)),
  ),
  statements: [],
});

/**
 * Builds the `Trace` the server sends and `cairn status --json` prints (`spec.server`): both
 * documents with their sections, the tasks and warnings `derive` recomputes from the manifest,
 * events and commits (`spec.status.derivation`), the section statuses `rollup` gives and the
 * judgments as given. Tasks are in manifest order. A PRD section never has keys or a summary.
 */
export const traceOf = (input: TraceInput): Trace => {
  const prdSections = sectionsOf(input.prd);
  const specSections = sectionsOf(input.spec);
  const derived = derive(
    input.manifest,
    Array.appendAll(prdSections, specSections),
    input.config,
    input.events,
    input.commits,
  );
  const summaries = HashMap.fromIterable(
    Array.map(input.specIndex, ({ id, summary }): readonly [string, string] => [id, summary]),
  );
  return {
    baseBranch: input.manifest.baseBranch,
    feature: input.manifest.feature,
    judgments: input.judgments,
    prd: documentOf(PRD_PATH, input.prd, prdSections, summaries, false),
    sections: input.rollup(prdSections, specSections, derived.tasks),
    spec: documentOf(SPEC_PATH, input.spec, specSections, summaries, true),
    tasks: derived.tasks,
    version: 1,
    warnings: derived.warnings,
  };
};
