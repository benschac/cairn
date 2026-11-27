export { EventOrder, GitCommit, derive, type Derived, type DerivedTask } from "./derive.ts";
export {
  changesOf,
  conflictOrder,
  conflictsOf,
  historyOf,
  hotspotsOf,
  orderingOf,
  orderingsOf,
  pairKey,
  scoreOf,
  togetherOf,
  type ChangedFiles,
  type Conflict,
  type History,
  type Hotspot,
  type Orderings,
  type Reason,
  type ReasonKind,
  type Score,
  type ScoreConfig,
} from "./conflicts.ts";
export { drawsOf, mermaidBlocksOf, withoutMermaidBlocks, type MermaidBlock } from "./diagrams.ts";
export {
  FileJudgingInput,
  SectionJudgingInput,
  SectionText,
  fileQuestions,
  StackJudgingInput,
  TaskJudgingInput,
  inputsOf,
  sectionQuestions,
  stackQuestions,
  taskQuestions,
  taskQuestionsWithoutModel,
  type JudgingInputs,
} from "./judging/questions.ts";
export {
  routeOf,
  verdictOf,
  type Answer,
  type Route,
  type RouteThresholds,
  type RoutedTask,
  type Thresholds,
  type Verdicted,
} from "./judging/verdicts.ts";
export {
  STACKS_CLOSE,
  STACKS_OPEN,
  stackDiagramOf,
  withStackDiagram,
  type DiagramManifest,
  type DiagramTask,
} from "./stack-diagram.ts";
export { roomMachine } from "./room-machine.ts";
export {
  gateOf,
  matchesPath,
  patternsMatching,
  type GateConfig,
  type GateItem,
  type GateTask,
} from "./gates.ts";
export { Finding, LintFile, LintRule, Severity, lint } from "./lint.ts";
export { Replan, bodyHashOf, replanOf, scopeOf, uncoveredItemsOf, uncoveredOf } from "./replan.ts";
export {
  partOf,
  refusalOf,
  type Part,
  type UnknownPartIds,
  type UnknownPartReason,
} from "./part.ts";
export {
  indexOf,
  type IndexTask,
  type RelationIndex,
  type RelationSource,
  type StatusOf,
} from "./relation-index.ts";
export { rollupOf, type RolledSection, type RollupItem, type RollupTask } from "./rollup.ts";
export { itemsOf, type Item } from "./items.ts";
export { assignItemIds, assignSectionIds, sectionIdsOf } from "./section-ids.ts";
export { keyEntriesOf, sectionsOf } from "./sections.ts";
export {
  DraftAnswer,
  assignStatementIds,
  numberStatements,
  settle,
  statementsOf,
  taskStatementsOf,
  traceStatementsOf,
  withDrafts,
  type Drafted,
  type Statement,
  type TaskStatement,
  type TestedSection,
} from "./statements.ts";
export {
  derivedOf,
  identifiedOf,
  type DerivedInput,
  type IdentifiedSection,
} from "./spec-index.ts";
export { sessionOf, type StoredSession } from "./session.ts";
export { Stack, StackPosition, TaskIdOrder, labelOf, stacksOf } from "./stacks.ts";
export {
  StackOrderError,
  StackProblem,
  parentOf,
  stackOf,
  stackedOn,
  worktreesOf,
  type Ordering,
  type StackLink,
  type StackTask,
} from "./stack.ts";
export { TaskInput, statusOf, taskMachine } from "./task-machine.ts";
export { PRD_PATH, SPEC_PATH, traceOf, type Rollup, type TraceInput } from "./trace.ts";
