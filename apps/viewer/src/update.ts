import {
  LinesStep,
  PrdSectionId,
  SectionId,
  Link,
  Step,
  type PassageStep,
  type Sha,
  type TaskId,
  type Trace,
  type TraceTask,
} from "@cairn/contract";
import { Command, UiStruct } from "@effect/ui";
import { Array, Boolean, Effect, Option, Record, Result, Schema, String } from "effect";

import {
  codeScreenOf,
  filesOf,
  ownerOf,
  patchPathOf,
  sessionCommitOf,
  shownCommitOf,
  taskOf,
} from "./codeView.ts";
import {
  FetchPatch,
  FetchSession,
  FocusSearchInput,
  ScrollSearchResult,
  ScrollTurn,
} from "./command.ts";
import {
  DETAIL_HEADING_ID,
  cutBackTo,
  endingOn,
  extendedBy,
  nodeShownBy,
  openedOn,
  wentBack,
} from "./detail.ts";
import {
  Needs,
  linkOf,
  linkTargetsOf,
  loadedOf,
  noticeOf,
  foundPassageOf,
  pathOfLink,
  resolveLink,
  sharedLengthOf,
  type Resolution,
} from "./links.ts";
import { focusElement, scrollElementIntoView, scrollElementIntoViewAfterPaint } from "./dom.ts";
import { describeTraceError, isDemoBuild, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import { keptReaders, readersOf } from "./readers.ts";
import { LoadUrl, PushUrl, ReplaceUrl, linkRoute } from "./route.ts";
import {
  HighlightedTurn,
  PatchData,
  PresenceConnection,
  Screen,
  SessionData,
  Shown,
  WHOLE_TASK,
  loadedTraceOf,
  settledTrace,
  type CodeScreen,
  type Model,
} from "./model.ts";
import {
  NO_SEARCH,
  chosen,
  moved,
  queried,
  refreshed,
  resultOf,
  type SearchState,
} from "./search.ts";
import { Resize, deltaOf, draggedTo, fittedTo, resized, stepOf } from "./panes.ts";
import type { Trail } from "./detail.ts";
import { ScrollTarget, isCardless, isOpenCard, isOpenPrdSection, targetsOf } from "./reader.ts";
import { Node } from "./trace.ts";
import { UrlRequest, hrefOfUrl } from "./url.ts";

// UPDATE

/**
 * What `update` makes of a Message: the next Model, and the Commands to run. `Viewer`'s `update`
 * sets the Model and runs each Command (`app.ts`).
 */
export interface Return {
  readonly commands?: ReadonlyArray<Command.Issued<Message, never, never, "Effect">>;
  readonly model: Model;
}

const nodeEquivalence = Schema.toEquivalence(Node);

const sameNode = Option.makeEquivalence(nodeEquivalence);

/** The trace, once it has loaded; the code view reads tasks and commits from it. */
const traceOf = (model: Model): Option.Option<Trace> => loadedTraceOf(model.trace);

/** The task the code view is on, and what is shown of it. */
const shownIn = (model: Model) =>
  Option.flatMap(Option.liftPredicate(model.screen, Screen.guards.Code), (code) =>
    Option.map(
      Option.flatMap(traceOf(model), (trace) => taskOf(trace, code.taskId)),
      (task) => ({ code, task }),
    ),
  );

/** The model with the fetches its code view needs started. */
interface Fetches {
  readonly commands: ReadonlyArray<
    ReturnType<typeof FetchPatch.make> | ReturnType<typeof FetchSession.make>
  >;
  readonly model: Model;
}

/**
 * The patch the code view is on must be in the model. A path that is loading or loaded is left
 * alone; one that is new, or failed before, is marked loading and fetched. The demo build has no
 * server, so it fetches nothing.
 */
const patchRequested = (model: Model, path: string): Fetches =>
  isDemoBuild() ||
  Option.exists(Record.get(model.patches, path), (data) => !PatchData.guards.Failed(data))
    ? { commands: Array.empty(), model }
    : {
        commands: [FetchPatch.make({ path })],
        model: UiStruct.evolve(model, { patches: Record.set(path, PatchData.Loading()) }),
      };

const withPatchRequested = (model: Model): Fetches =>
  Option.match(
    Option.flatMap(shownIn(model), ({ code, task }) => patchPathOf(task, code.shown)),
    {
      onNone: () => ({ commands: Array.empty(), model }),
      onSome: (path) => patchRequested(model, path),
    },
  );

/**
 * The session of the commit the code view shows must be in the model, as its patch must: one that
 * is loading or loaded is left alone, and one that is new, or failed before, is fetched.
 */
const sessionRequested = (model: Model, id: string): Fetches =>
  isDemoBuild() ||
  Option.exists(Record.get(model.sessions, id), (data) => !SessionData.guards.Failed(data))
    ? { commands: Array.empty(), model }
    : {
        commands: [FetchSession.make({ id })],
        model: UiStruct.evolve(model, { sessions: Record.set(id, SessionData.Loading()) }),
      };

/** The patch and the session of what the code view shows, each fetched when the model lacks it. */
const withCodeRequested = (model: Model): Fetches => {
  const patched = withPatchRequested(model);
  const sessioned = Option.match(
    Option.flatMapNullishOr(
      Option.flatMap(shownIn(patched.model), ({ code, task }) => shownCommitOf(task, code.shown)),
      (commit) => commit.session,
    ),
    {
      onNone: () => ({ commands: Array.empty(), model: patched.model }),
      onSome: (id) => sessionRequested(patched.model, id),
    },
  );
  return {
    commands: Array.appendAll(patched.commands, sessioned.commands),
    model: sessioned.model,
  };
};

/** The route of the whole diff of the task the detail panel is on; none for a section or a task without one. */
const detailPatchPathOf = (model: Model): Option.Option<string> =>
  Option.flatMap(nodeShownBy(model.detail), (node) =>
    Node.match(node, {
      section: () => Option.none(),
      task: ({ id }) =>
        Option.flatMap(
          Option.flatMap(traceOf(model), (trace) => taskOf(trace, id)),
          (task) => patchPathOf(task, WHOLE_TASK),
        ),
    }),
  );

/** The code view with what is shown of a task, when the trace has that task and commit. */
const codeOn = (model: Model, id: TaskId, maybeSha: Option.Option<Sha>): Return =>
  Option.match(
    Option.flatMap(traceOf(model), (trace) => codeScreenOf(trace, id, maybeSha)),
    {
      onNone: () => ({ model }),
      onSome: (screen) => {
        const requested = withCodeRequested(UiStruct.evolve(model, { screen: () => screen }));
        return Array.isReadonlyArrayEmpty(requested.commands)
          ? { model: requested.model }
          : requested;
      },
    },
  );

/**
 * The model with this trail. When the panel is open and its last node changed, focus moves to the
 * panel's heading; a trail that shows the same node, or none, moves no focus.
 */
const detailTrailed = (model: Model, trail: Trail): Return => {
  const trailed = UiStruct.evolve(model, { detail: () => trail });
  // A task with commits shows its whole diff, so it is fetched unless the model has it.
  const requested = Option.match(detailPatchPathOf(trailed), {
    onNone: (): Return => ({ model: trailed }),
    onSome: (path) => patchRequested(trailed, path),
  });
  return {
    commands: Array.appendAll(
      Option.isSome(nodeShownBy(trail)) && !sameNode(nodeShownBy(trail), nodeShownBy(model.detail))
        ? [FocusDetailHeading.make()]
        : [],
      Option.getOrElse(Option.fromNullishOr(requested.commands), () => []),
    ),
    model: requested.model,
  };
};

// OPENING A LINK

const isPrdSection = Schema.is(PrdSectionId);

/**
 * What a link holds is cleared before its steps apply: the pin, the passage, the focus, the trail,
 * the code view and its highlighted turn. A link opens on the reader unless a step opens code.
 */
const clearedForLink = (model: Model): Model =>
  UiStruct.evolve(model, {
    detail: () => [],
    maybeHighlightedTurn: () => Option.none(),
    reader: (reader) =>
      UiStruct.evolve(reader, {
        maybeFocus: () => Option.none(),
        maybePassage: () => Option.none(),
        maybePinned: () => Option.none(),
      }),
    screen: () => Screen.Reader(),
  });

const pinnedOn = (model: Model, id: PrdSectionId): Model =>
  UiStruct.evolve(model, {
    reader: (reader) => UiStruct.evolve(reader, { maybePinned: () => Option.some(id) }),
  });

const marked = (model: Model, passage: typeof PassageStep.Type): Model =>
  UiStruct.evolve(model, {
    reader: (reader) => UiStruct.evolve(reader, { maybePassage: () => Option.some(passage) }),
  });

const trailedOn = (model: Model, node: Node): Model =>
  UiStruct.evolve(model, { detail: (trail) => extendedBy(trail, node) });

/** The code view on one commit of a task, with the task at the end of the trail. */
const onCommit = (model: Model, task: TraceTask, sha: Sha): Model =>
  UiStruct.evolve(model, {
    detail: (trail) => endingOn(trail, { id: task.id, kind: "task" }),
    screen: () =>
      Screen.Code({
        maybeFile: Option.none(),
        maybeLines: Option.none(),
        shown: Shown.OneCommit({ sha }),
        taskId: task.id,
      }),
  });

/** The code view's screen changed; with no code view open there is nothing to change. */
const inCode = (model: Model, change: (code: CodeScreen) => CodeScreen): Model =>
  Option.match(Option.liftPredicate(model.screen, Screen.guards.Code), {
    onNone: () => model,
    onSome: (code) => UiStruct.evolve(model, { screen: () => change(code) }),
  });

/**
 * A spec passage: unless the pinned section is one its section implements, the first PRD section
 * it implements is pinned; then its card opens and the passage is marked. A spec section that
 * implements no PRD section has no card, so it opens in the detail panel, as search does.
 */
const specPassageOpened = (trace: Trace, model: Model, passage: typeof PassageStep.Type): Model => {
  const id = SectionId.make(passage.section);
  const implemented = Option.match(
    Array.findFirst(trace.spec.sections, (section) => section.id === id),
    { onNone: () => [], onSome: (section) => section.keys.implements },
  );
  return Array.match(implemented, {
    onEmpty: () => trailedOn(marked(model, passage), { id, kind: "section" }),
    onNonEmpty: (prds) =>
      UiStruct.evolve(marked(model, passage), {
        reader: (reader) =>
          UiStruct.evolve(reader, {
            maybePinned: (maybePinned) =>
              Option.exists(maybePinned, (pinned) => Array.contains(prds, pinned))
                ? maybePinned
                : Option.some(Array.headNonEmpty(prds)),
            opened: Record.set(id, true),
          }),
      }),
  });
};

/** A turn is highlighted as `ClickedTurn` opening it does. */
const turnHighlighted = (model: Model, id: string): Model =>
  UiStruct.evolve(model, {
    maybeHighlightedTurn: () => Option.some(HighlightedTurn.make({ from: "session", id })),
    openedTurns: Record.set(id, true),
  });

/** Applies one step of a link the way the click it stands for does. */
const appliedStep = (trace: Trace, model: Model, step: Step): Model =>
  Step.match(step, {
    commit: ({ sha }) =>
      Option.match(ownerOf(trace, sha), {
        onNone: () => model,
        onSome: (task) => onCommit(model, task, sha),
      }),
    // A diff follows its task's step, so the trail ends on that task.
    diff: ({ head }) =>
      Option.match(Option.filter(nodeShownBy(model.detail), Node.guards.task), {
        onNone: () => model,
        onSome: ({ id }) =>
          UiStruct.evolve(model, {
            screen: () =>
              Screen.Code({
                maybeFile: Option.none(),
                maybeLines: Option.none(),
                shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
                taskId: id,
              }),
          }),
      }),
    file: ({ path }) =>
      inCode(model, (code) =>
        UiStruct.evolve(code, {
          maybeFile: () => Option.some(path),
          maybeLines: () => Option.none(),
        }),
      ),
    lines: (lines) =>
      inCode(model, (code) => UiStruct.evolve(code, { maybeLines: () => Option.some(lines) })),
    note: () => model,
    passage: (passage) =>
      isPrdSection(passage.section)
        ? marked(pinnedOn(model, passage.section), passage)
        : specPassageOpened(trace, model, passage),
    section: ({ id }) =>
      isPrdSection(id)
        ? pinnedOn(model, id)
        : trailedOn(model, { id: SectionId.make(id), kind: "section" }),
    segment: (focus) =>
      UiStruct.evolve(model, {
        reader: (reader) => UiStruct.evolve(reader, { maybeFocus: () => Option.some(focus) }),
      }),
    stack: (focus) =>
      UiStruct.evolve(model, {
        reader: (reader) => UiStruct.evolve(reader, { maybeFocus: () => Option.some(focus) }),
      }),
    task: ({ id }) => trailedOn(model, { id, kind: "task" }),
    // With no code step before it, a turn opens the code view on its session's newest commit. A
    // code step whose commit is another session's counts as none: its session pane cannot show it.
    turn: ({ session, turn }) =>
      turnHighlighted(
        Option.exists(
          Option.flatMap(Option.liftPredicate(model.screen, Screen.guards.Code), (code) =>
            Option.flatMap(taskOf(trace, code.taskId), (task) => shownCommitOf(task, code.shown)),
          ),
          (commit) => commit.session === session,
        )
          ? model
          : Option.match(sessionCommitOf(trace, session), {
              onNone: () => model,
              onSome: ({ commit, task }) => onCommit(model, task, commit.sha),
            }),
        turn,
      ),
  });

/** The fetches started one after another, each on the model the one before it left. */
const requestedAll = (
  model: Model,
  requests: ReadonlyArray<(current: Model) => Fetches>,
): Fetches =>
  Array.reduce(requests, { commands: Array.empty(), model }, (fetched, request) => {
    const next = request(fetched.model);
    return { commands: Array.appendAll(fetched.commands, next.commands), model: next.model };
  });

/**
 * The patches and sessions an opened link shows, fetched through the code view's and the detail
 * panel's requests when the model has never asked for them. One that failed is not asked for
 * again here: the notice says why, and selecting it again retries.
 */
const linkRequested = (
  model: Model,
  steps: ReadonlyArray<Step>,
  waitedPaths: ReadonlyArray<string>,
): Fetches => {
  const shown = shownIn(model);
  const paths = Array.dedupe(
    Array.appendAll(
      Array.getSomes([
        Option.flatMap(shown, ({ code, task }) => patchPathOf(task, code.shown)),
        detailPatchPathOf(model),
      ]),
      waitedPaths,
    ),
  );
  const sessions = Array.dedupe(
    Array.appendAll(
      Array.fromOption(
        Option.flatMapNullishOr(
          Option.flatMap(shown, ({ code, task }) => shownCommitOf(task, code.shown)),
          (commit) => commit.session,
        ),
      ),
      Array.filterMap(steps, (step) =>
        Step.guards.turn(step) ? Result.succeed(step.session) : Result.failVoid,
      ),
    ),
  );
  return requestedAll(
    model,
    Array.appendAll(
      Array.map(
        Array.filter(paths, (path) => !Record.has(model.patches, path)),
        (path) => (current: Model) => patchRequested(current, path),
      ),
      Array.map(
        Array.filter(sessions, (id) => !Record.has(model.sessions, id)),
        (id) => (current: Model) => sessionRequested(current, id),
      ),
    ),
  );
};

/**
 * The patch a waiting file step reads to be checked: the one its diff or commit opened. A later
 * step can move the code view off that patch, as a turn of another session does, so it is fetched
 * whatever the screen ends on, or the link would wait for it forever.
 */
const waitedPathsOf = (link: Link, resolution: Resolution): ReadonlyArray<string> =>
  Option.match(
    Option.filter(
      Option.flatMap(resolution.waiting, (index) => Array.get(link, index)),
      Step.guards.file,
    ),
    {
      onNone: () => [],
      onSome: () =>
        Array.fromOption(
          Array.last(
            Array.filterMap(resolution.resolved, ({ needs }) =>
              Needs.guards.Patch(needs) ? Result.succeed(needs.path) : Result.failVoid,
            ),
          ),
        ),
    },
  );

/**
 * Opens a link. It is resolved against the trace and the data the model has, what a link holds is
 * cleared, and each step that resolves is applied the way its click is. A step still waiting for
 * its patch or session is applied too, with the steps after it, and the link stays pending until
 * the data arrives and it is resolved again; a step that is missing then is left out. The notice
 * says what did not open. The commands fetch what the steps show and bring into view each step
 * past the ones the old link and the new one share. Before the first trace the link only waits.
 */
export const openLink = (model: Model, link: Link): Return =>
  openedFrom(model, link, Option.none());

/**
 * Opens a link, and also brings into view its steps from index `maybeArrivedFrom` on that now
 * resolve: the ones that were waiting for data that has arrived. They were counted as open before
 * their elements were in the page, so the old link and the new one share them.
 */
const openedFrom = (model: Model, link: Link, maybeArrivedFrom: Option.Option<number>): Return =>
  Option.match(traceOf(model), {
    onNone: () => ({
      model: UiStruct.evolve(model, { maybePendingLink: () => Option.some(link) }),
    }),
    onSome: (trace) => {
      const resolution = resolveLink(trace, link, loadedOf(model));
      const steps: ReadonlyArray<Step> = Array.appendAll(
        Array.map(resolution.resolved, ({ step }) => step),
        Option.match(resolution.waiting, {
          onNone: () => [],
          onSome: (index) => Array.drop(link, index),
        }),
      );
      const walked: Model = Array.reduce(steps, clearedForLink(model), (current: Model, step) =>
        appliedStep(trace, current, step),
      );
      const applied = UiStruct.evolve(walked, {
        maybeLinkNotice: () => noticeOf(Result.succeed(resolution)),
        maybePendingLink: () => Option.as(resolution.waiting, link),
      });
      const requested = linkRequested(applied, steps, waitedPathsOf(link, resolution));
      const before = linkOf(model);
      const after = linkOf(requested.model);
      const arrived: ReadonlyArray<Step> = Option.match(maybeArrivedFrom, {
        onNone: () => [],
        onSome: (from) =>
          Array.filterMap(resolution.resolved, ({ index, step }) =>
            index >= from ? Result.succeed(step) : Result.failVoid,
          ),
      });
      const opened: ReadonlyArray<Step> = Array.appendAll(
        Array.drop(after, sharedLengthOf(before, after)),
        arrived,
      );
      const targets = Array.flatMap(opened, (step) => linkTargetsOf(trace, step));
      return {
        commands: Array.appendAll(
          requested.commands,
          Array.isReadonlyArrayNonEmpty(targets) ? [ScrollLinkTargets.make({ targets })] : [],
        ),
        model: requested.model,
      };
    },
  });

/**
 * Opens the selected passage of `section` as a step, pinning and marking it as a link does, and
 * copies the link up to that step. What else is open stays where it is, and nothing scrolls: the
 * passage is already in front of the reader. Without a trace, with no selection in that section or
 * with one its prose does not hold, nothing happens.
 */
const passageLinkCopied = (model: Model, section: SectionId): Return =>
  Option.match(
    Option.flatMap(traceOf(model), (trace) =>
      Option.map(
        Option.flatMap(
          Option.filter(model.maybeSelectedPassage, (selection) => selection.section === section),
          (selection) => foundPassageOf(trace, selection),
        ),
        (passage) => ({ passage, trace }),
      ),
    ),
    {
      onNone: () => ({ model }),
      onSome: ({ passage, trace }) => {
        const opened = UiStruct.evolve(appliedStep(trace, model, passage), {
          maybeCopiedLink: () => Option.none(),
        });
        const link = linkOf(opened);
        const upToPassage = Option.match(
          Array.findFirstIndex(link, (step) => step.kind === "passage"),
          { onNone: () => link, onSome: (index) => Array.take(link, index + 1) },
        );
        return { commands: [CopyLink.make({ path: pathOfLink(upToPassage) })], model: opened };
      },
    },
  );

const decodeLines = Schema.decodeUnknownOption(LinesStep);

/**
 * The lines a person selected in the diff, in the file they selected them in, which becomes the
 * code view's file: the link then names the file and the lines together, whether or not the file
 * was picked in the tree. A range that is not lines leaves the file with none. With no code view
 * open there is nothing to set.
 */
const linesSelected = (
  model: Model,
  path: string,
  maybeLines: Option.Option<typeof LinesStep.Type>,
): Model =>
  inCode(model, (code) =>
    UiStruct.evolve(code, {
      maybeFile: () => Option.some(path),
      maybeLines: () => maybeLines,
    }),
  );

/** The diff's selection was cleared: the file stays and its lines go. */
const linesCleared = (model: Model): Model =>
  inCode(model, (code) => UiStruct.evolve(code, { maybeLines: () => Option.none() }));

/**
 * A link waiting for its data is resolved again when a patch or a session arrives: `received` is
 * the model with it, and `model` the one before. The steps that were waiting are brought into view.
 */
const reopened = (model: Model, received: Model): Return =>
  Option.match(received.maybePendingLink, {
    onNone: () => ({ model: received }),
    onSome: (link) =>
      openedFrom(
        received,
        link,
        Option.flatMap(
          traceOf(model),
          (trace) => resolveLink(trace, link, loadedOf(model)).waiting,
        ),
      ),
  });

/** The messages that bring a pending link its data, which reopen it rather than cancel it. */
const isLinkData = Schema.is(
  Schema.Union([
    Message.cases.ReceivedPatch,
    Message.cases.ReceivedSession,
    Message.cases.SettledLoadTrace,
  ]),
);

/** Whether two screens are the same one of the reader and the code view. */
const isSameScreen = (self: Screen, that: Screen): boolean =>
  Screen.guards.Code(self) === Screen.guards.Code(that);

const pendingEquivalence = Option.makeEquivalence(Schema.toEquivalence(Link));

const linkEquivalence = Schema.toEquivalence(Link);

/**
 * A person who moves on while a link waits for its data cancels it: once the screen, the trail, the
 * pin, the passage, the focus, the file, the lines or the turn changed, a late patch or session only
 * fills its cache and never reapplies the link over the newer choice.
 */
const pendingCancelled = (model: Model, message: Message, result: Return): Return =>
  Option.isSome(result.model.maybePendingLink) &&
  !isLinkData(message) &&
  pendingEquivalence(model.maybePendingLink, result.model.maybePendingLink) &&
  (!isSameScreen(model.screen, result.model.screen) ||
    !linkEquivalence(linkOf(model), linkOf(result.model)))
    ? UiStruct.evolve(result, {
        model: (current) => UiStruct.evolve(current, { maybePendingLink: () => Option.none() }),
      })
    : result;

/** The resize this pointer is making; none while nothing is resized or another pointer resizes. */
const resizeByPointer = (resize: Resize, pointerId: number) =>
  Option.filter(
    Option.liftPredicate(resize, Resize.guards.Resizing),
    (resizing) => resizing.pointerId === pointerId,
  );

/**
 * A result chosen by Enter or a click in the reader: it is active, which makes its first PRD
 * section current while it stays so. Its place in each pane is brought into view. A spec section
 * that implements no PRD section has no card to go to, so it opens in the detail panel, the one
 * case where a result opens the panel. Nothing here moves focus: it stays in the search input.
 */
const selectedInReader = (model: Model, node: Node): Return => {
  const selected = UiStruct.evolve(model, {
    search: (search) => chosen(search, node),
  });
  return Option.match(
    Option.all({ result: resultOf(selected.search.results, node), trace: traceOf(model) }),
    {
      onNone: () => ({ model: selected }),
      onSome: ({ result, trace }) =>
        isCardless(trace, node)
          ? { model: UiStruct.evolve(selected, { detail: () => openedOn(node) }) }
          : {
              commands: [ScrollSearchTargets.make({ targets: targetsOf(result) })],
              model: selected,
            },
    },
  );
};

/** A result chosen by Enter or a click: it is active; only the reader has results to scroll to. */
const selectedResult = (model: Model, node: Node): Return =>
  Screen.guards.Reader(model.screen)
    ? selectedInReader(model, node)
    : { model: UiStruct.evolve(model, { search: (search) => chosen(search, node) }) };

/** The model with this search, and the list scrolled to its active result so it is not offscreen. */
const searchedWith = (model: Model, search: SearchState) => ({
  commands: Array.map(Array.fromOption(search.maybeActive), (node) =>
    ScrollSearchResult.make({ node }),
  ),
  model: UiStruct.evolve(model, { search: () => search }),
});

/** A pinned section is unpinned by a second click on its status line; any other becomes the pin. */
const pinToggled = (maybePinned: Option.Option<PrdSectionId>, id: PrdSectionId) =>
  Option.contains(maybePinned, id) ? Option.none() : Option.some(id);

/** Nothing is marked by a spec card's chip any more. */
const unmarked = (model: Model): Model =>
  UiStruct.evolve(model, {
    reader: (reader) => UiStruct.evolve(reader, { maybeMarked: () => Option.none() }),
  });

/**
 * A PRD section's status line or an item's annotation: the pin moves to it, or goes when it was the
 * pin. Pinning keeps the pane where it is. A PRD passage a link opened belongs to the pin it
 * replaces, so it goes with it.
 */
const pinClicked = (model: Model, id: PrdSectionId): Return => ({
  model: UiStruct.evolve(unmarked(model), {
    maybeCopied: () => Option.none(),
    maybeCopiedLink: () => Option.none(),
    reader: (reader) =>
      UiStruct.evolve(reader, {
        maybePassage: Option.filter((passage) => !isPrdSection(passage.section)),
        maybePinned: (maybePinned) => pinToggled(maybePinned, id),
      }),
  }),
});

/** The model with the section holding the item opened, so the item is in the PRD pane. A heading is already. */
const shownInPrd = (model: Model, id: PrdSectionId): Model =>
  UiStruct.evolve(model, {
    reader: (reader) =>
      UiStruct.evolve(reader, {
        prdOpened: (opened) =>
          Option.match(
            Option.flatMap(traceOf(model), (trace) =>
              Array.findFirst(trace.prd.items, (item) => String.Equivalence(item.id, id)),
            ),
            { onNone: () => opened, onSome: (item) => Record.set(opened, item.section, true) },
          ),
      }),
  });

/**
 * A spec card's chip: the PRD pane scrolls to the section or item it names and it is marked. An
 * item inside a folded section opens that section first, so there is something to scroll to.
 */
const chipClicked = (model: Model, id: PrdSectionId): Return => ({
  commands: [ScrollPrdSection.make({ id })],
  model: UiStruct.evolve(shownInPrd(model, id), {
    reader: (reader) => UiStruct.evolve(reader, { maybeMarked: () => Option.some(id) }),
  }),
});

/** No buttons held: the pointer is up, whether or not its release was heard. */
const NO_BUTTONS = 0;

export const update = (model: Model, message: Message): Return =>
  pendingCancelled(model, message, updated(model, message));

// THE ADDRESS

/** The messages that resolve a waiting link again, so a step that went missing is replaced. */
const isLinkArrival = Message.isAnyOf(["ReceivedPatch", "ReceivedSession"]);

const isTraceSettled = Message.is("SettledLoadTrace");

const isUrlChange = Message.is("ChangedUrl");

/**
 * A link's history written one entry per step: `replaceUrl` with its first step, then `pushUrl`
 * for each longer prefix, so Back walks a link opened in a new window one step at a time.
 */
const stepByStep = (link: Link) =>
  Array.map(
    Array.getSomes(Array.map(link, (_, index) => linkRoute.print(Array.take(link, index + 1)))),
    (path, index) => (index === 0 ? ReplaceUrl.make({ path }) : PushUrl.make({ path })),
  );

/**
 * What an update writes to the address, from the model before it and after it:
 *
 * - A `ChangedUrl` came from the address, so it writes nothing.
 * - The first trace opens the link that waited for it, written one entry per step.
 * - A patch or session that leaves a waiting link's step missing replaces the address.
 * - Any other message that changes `linkOf` pushes the new link.
 */
const addressWritten = (model: Model, message: Message, next: Model) => {
  const link = linkOf(next);
  const isFirstTrace =
    isTraceSettled(message) &&
    Option.isNone(traceOf(model)) &&
    Option.isSome(model.maybePendingLink) &&
    Option.isSome(traceOf(next));
  const written = (write: typeof PushUrl | typeof ReplaceUrl) =>
    Array.fromOption(Option.map(linkRoute.print(link), (path) => write.make({ path })));
  return isUrlChange(message)
    ? []
    : isFirstTrace
      ? stepByStep(link)
      : linkEquivalence(linkOf(model), link)
        ? []
        : written(isLinkArrival(message) ? ReplaceUrl : PushUrl);
};

/**
 * Keeps the address bar and the browser history in step with what is open: the application's
 * update is `withAddress(update)`. Pinning, opening a task or a spec section, moving along the
 * trail, Escape, opening the code view and selecting in it each become one history entry, so Back
 * undoes them one at a time.
 */
export const withAddress =
  (inner: (model: Model, message: Message) => Return) =>
  (model: Model, message: Message): Return => {
    const result = inner(model, message);
    return {
      commands: Array.appendAll(
        Option.getOrElse(Option.fromUndefinedOr(result.commands), () => []),
        addressWritten(model, message, result.model),
      ),
      model: result.model,
    };
  };

const updated = (model: Model, message: Message) =>
  Message.match(message, {
    // Back, Forward or a hash change opens the address's link without writing history. The address
    // of what is already open, such as the viewer's own entry, does nothing, except that it drops a
    // different link still waiting for the first trace. A path that is not a link opens nothing and
    // says why.
    ChangedUrl: ({ url }) =>
      Result.match(linkRoute.parse(url), {
        onFailure: (error) => ({
          model: UiStruct.evolve(clearedForLink(model), {
            maybeLinkNotice: () => noticeOf(Result.fail(error)),
            maybePendingLink: () => Option.none(),
          }),
        }),
        onSuccess: (link) =>
          linkEquivalence(link, linkOf(model))
            ? {
                model: Option.exists(
                  model.maybePendingLink,
                  (pending) => !linkEquivalence(pending, link),
                )
                  ? UiStruct.evolve(model, { maybePendingLink: () => Option.none() })
                  : model,
              }
            : openLink(model, link),
      }),
    // An anchor goes where the browser would take it without routing.
    ClickedLink: ({ request }) => ({
      commands: [
        LoadUrl.make({
          href: UrlRequest.match(request, {
            External: ({ href }) => href,
            Internal: ({ url }) => hrefOfUrl(url),
          }),
        }),
      ],
      model,
    }),
    CompletedNavigation: () => ({ model }),
    // Back to the plan changes only the screen: what the reader holds stayed.
    ClickedBackToPlan: () => ({ model: UiStruct.evolve(model, { screen: () => Screen.Reader() }) }),
    // A card opens or closes alone, to the opposite of what it shows now.
    ClickedCardHeader: ({ id }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, { opened: Record.set(id, !isOpenCard(reader, id)) }),
      }),
    }),
    // The control sets every card to its density, so the cards opened apart from it are forgotten.
    ClickedDensity: ({ density }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) => UiStruct.evolve(reader, { density: () => density, opened: () => ({}) }),
      }),
    }),
    // A PRD section opens or closes alone, to the opposite of what it shows now.
    ClickedPrdHeading: ({ id }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, { prdOpened: Record.set(id, !isOpenPrdSection(reader, id)) }),
      }),
    }),
    // A finished trunk folds or unfolds on its own: it sends no command and is not in the link.
    ClickedSegment: ({ root }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, {
            unfolded: Record.set(
              root,
              !Option.getOrElse(Record.get(reader.unfolded, root), () => false),
            ),
          }),
      }),
    }),
    // Collapsing or expanding every section forgets the sections opened or closed on their own.
    ClickedCondensePrd: () => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, { isPrdCondensed: Boolean.not, prdOpened: () => ({}) }),
      }),
    }),
    // A task row or a chip starts a new trail on that task.
    ClickedTask: ({ id }) => detailTrailed(unmarked(model), openedOn({ id, kind: "task" })),
    ClickedDetailNode: ({ node }) => detailTrailed(model, extendedBy(model.detail, node)),
    ClickedTrailStep: ({ index }) => detailTrailed(model, cutBackTo(model.detail, index)),
    ClickedCloseDetail: () => ({ model: UiStruct.evolve(model, { detail: () => [] }) }),
    ClickedDismissLinkNotice: () => ({
      model: UiStruct.evolve(model, { maybeLinkNotice: () => Option.none() }),
    }),
    // An item in a folded section is shown first, so there is something to scroll to.
    ClickedTraceSection: ({ id }) => ({
      commands: [ScrollPrdSection.make({ id })],
      model: shownInPrd(model, id),
    }),
    // "Open code" and a detail panel commit open the code view; a task or commit the trace lacks opens nothing.
    ClickedOpenCode: ({ id, maybeSha }) => codeOn(model, id, maybeSha),
    // The tree selects within the code view; with the reader showing there is no tree to click.
    ClickedTreeCommit: ({ sha }) =>
      Option.match(shownIn(model), {
        onNone: () => ({ model }),
        onSome: () =>
          Option.match(
            Option.flatMap(traceOf(model), (trace) => ownerOf(trace, sha)),
            {
              onNone: () => ({ model }),
              onSome: (task) => codeOn(model, task.id, Option.some(sha)),
            },
          ),
      }),
    ClickedTreeFile: ({ path }) => ({
      model: Option.match(
        Option.filter(shownIn(model), ({ code, task }) =>
          Array.contains(filesOf(task, code.shown), path),
        ),
        {
          onNone: () => model,
          onSome: ({ code }) =>
            UiStruct.evolve(model, {
              screen: () =>
                UiStruct.evolve(code, {
                  maybeFile: () => Option.some(path),
                  maybeLines: () => Option.none(),
                }),
            }),
        },
      ),
    }),
    ClickedTreeTask: ({ id }) =>
      Option.match(shownIn(model), {
        onNone: () => ({ model }),
        onSome: () => codeOn(model, id, Option.none()),
      }),
    ClickedCopyLink: ({ path }) => ({
      commands: [CopyLink.make({ path })],
      model: UiStruct.evolve(model, { maybeCopiedLink: () => Option.none() }),
    }),
    ClickedCopyPassageLink: ({ section }) => passageLinkCopied(model, section),
    ClickedSectionId: ({ id }) => ({ commands: [CopySectionId.make({ id })], model }),
    // The pinned section stays current while the PRD scrolls.
    ClickedStatusLine: ({ id }) => pinClicked(model, id),
    ClickedItemAnnotation: ({ id }) => pinClicked(model, id),
    ClickedImplementsChip: ({ id }) => chipClicked(model, id),
    ClickedLinkedSection: ({ id }) => chipClicked(model, id),
    ClickedLinks: ({ id }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, { maybeLinksOpen: (maybeOpen) => pinToggled(maybeOpen, id) }),
      }),
    }),
    ClickedLinksTransitiveSwitch: () => ({
      model: UiStruct.evolve(model, {
        reader: (reader) =>
          UiStruct.evolve(reader, { isLinksTransitive: (isTransitive) => !isTransitive }),
      }),
    }),
    // A click takes focus from the input, so it goes back: the keyboard stays in search.
    ClickedSearchResult: ({ node }) => {
      const selected = selectedResult(model, node);
      return {
        commands: Array.append(
          Option.getOrElse(Option.fromNullishOr(selected.commands), () => []),
          FocusSearchInput.make(),
        ),
        model: selected.model,
      };
    },
    // A turn opens and closes; a turn that was never opened counts as closed. Opening it marks
    // its hunks in the diff, which scrolls to the first; closing the marked turn clears the marks.
    ClickedTurn: ({ id }) => {
      const isOpening = Boolean.not(
        Option.getOrElse(Record.get(model.openedTurns, id), () => false),
      );
      return {
        model: UiStruct.evolve(model, {
          maybeHighlightedTurn: (current) =>
            isOpening
              ? Option.some(HighlightedTurn.make({ from: "session", id }))
              : Option.filter(current, (turn) => turn.id !== id),
          openedTurns: Record.set(id, isOpening),
        }),
      };
    },
    // A hunk's mark opens its turn in the session pane, scrolls to it and marks the turn's hunks.
    ClickedHunkMark: ({ id }) => ({
      commands: [ScrollTurn.make({ id })],
      model: UiStruct.evolve(model, {
        maybeHighlightedTurn: () => Option.some(HighlightedTurn.make({ from: "diff", id })),
        openedTurns: Record.set(id, true),
      }),
    }),
    ClickedMoreOfTurn: ({ id }) => ({
      model: UiStruct.evolve(model, { fullTurns: Record.set(id, true) }),
    }),
    ClickedDiffStyle: ({ style }) => ({
      model: UiStruct.evolve(model, { diffStyle: () => style }),
    }),
    ClickedModelsSwitch: () => ({
      model: UiStruct.evolve(model, { isShowingModels: Boolean.not }),
    }),
    // The room is unknown once the socket is gone, so nobody is shown and you are no one.
    // A new query makes the first result active, so the list goes back to it.
    ChangedSearchQuery: ({ query }) =>
      searchedWith(model, queried(model.search, loadedTraceOf(model.trace), query)),
    ClosedPresence: () => ({
      model: UiStruct.evolve(model, {
        maybeYou: () => Option.none(),
        participants: () => [],
        readers: () => [],
        presenceConnection: () => PresenceConnection.Disconnected(),
      }),
    }),
    ClearedPassageSelection: () => ({
      model: UiStruct.evolve(model, { maybeSelectedPassage: () => Option.none() }),
    }),
    SelectedPassage: ({ quote, section }) => ({
      model: UiStruct.evolve(model, {
        maybeSelectedPassage: () => Option.some({ quote, section }),
      }),
    }),
    ClearedDiffLines: () => ({ model: linesCleared(model) }),
    SelectedDiffLines: ({ end, path, side, start }) => ({
      model: linesSelected(model, path, decodeLines({ end, kind: "lines", side, start })),
    }),
    // A refused copy leaves the button as it was.
    CompletedCopyLink: ({ isCopied, path }) => ({
      model: UiStruct.evolve(model, {
        maybeCopiedLink: () => (isCopied ? Option.some(path) : Option.none()),
      }),
    }),
    CompletedCopySectionId: ({ id, isCopied }) => ({
      model: UiStruct.evolve(model, {
        maybeCopied: () => (isCopied ? Option.some(id) : Option.none()),
      }),
    }),
    CompletedFocusDetailHeading: () => ({ model }),
    CompletedScrollPrdSection: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedScrollSearchResult: () => ({ model }),
    CompletedScrollSearchTargets: () => ({ model }),
    CompletedScrollLinkTargets: () => ({ model }),
    // Until a person moves its divider, the stacks pane is as wide as its chart.
    CompletedScrollStacks: ({ maybeChartWidth }) => ({
      model: Option.match(
        Option.filter(maybeChartWidth, () => !model.hasChosenStacksWidth),
        {
          onNone: () => model,
          onSome: (width) =>
            UiStruct.evolve(model, { widths: (widths) => fittedTo(widths, "stacks", width) }),
        },
      ),
    }),
    CompletedRenderDiff: () => ({ model }),
    CompletedDrawDiagram: () => ({ model }),
    CompletedScrollTurn: () => ({ model }),
    HoveredNode: ({ node }) => ({
      model: UiStruct.evolve(unmarked(model), { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: UiStruct.evolve(model, { maybeHovered: () => Option.none() }) }),
    MeasuredWires: ({ measured }) => ({
      model: UiStruct.evolve(model, { maybeMeasuredWires: () => Option.some(measured) }),
    }),
    OpenedPresence: () => ({
      model: UiStruct.evolve(model, { presenceConnection: () => PresenceConnection.Connected() }),
    }),
    PressedArrowOnDivider: ({ key, pane }) => ({
      model: UiStruct.evolve(model, {
        hasChosenStacksWidth: (hasChosen) => hasChosen || pane === "stacks",
        widths: (widths) => resized(widths, pane, deltaOf(pane, stepOf(key))),
      }),
    }),
    // One resize at a time: a second finger cannot take it over.
    PressedDivider: ({ maybeWidth, pane, pointerId, x }) => ({
      model: Resize.guards.Resizing(model.resize)
        ? model
        : UiStruct.evolve(model, {
            hasChosenStacksWidth: (hasChosen) => hasChosen || pane === "stacks",
            resize: () =>
              Resize.Resizing({
                pane,
                pointerId,
                // The rendered width, which the grid may hold below the chosen one.
                startWidth: Option.getOrElse(maybeWidth, () => model.widths[pane]),
                startX: x,
              }),
          }),
    }),
    // A move with no button held means the release was missed: the resize ends there.
    MovedResizePointer: ({ buttons, pointerId, x }) => ({
      model: Option.match(resizeByPointer(model.resize, pointerId), {
        onNone: () => model,
        onSome: (resizing) =>
          buttons === NO_BUTTONS
            ? UiStruct.evolve(model, { resize: () => Resize.Idle() })
            : UiStruct.evolve(model, { widths: (widths) => draggedTo(widths, resizing, x) }),
      }),
    }),
    ReleasedResizePointer: ({ pointerId }) => ({
      model: Option.match(resizeByPointer(model.resize, pointerId), {
        onNone: () => model,
        onSome: () => UiStruct.evolve(model, { resize: () => Resize.Idle() }),
      }),
    }),
    // It is the reader's key: on any other screen it does nothing. With the detail panel open it
    // goes back one step, which closes the panel at the first; then an open links list closes;
    // otherwise it unpins, which takes a linked PRD passage with the pin, and clears a linked
    // stack's focus.
    PressedEscape: () =>
      Screen.guards.Reader(model.screen)
        ? Array.match(model.detail, {
            onEmpty: () =>
              Option.isSome(model.reader.maybeLinksOpen)
                ? {
                    model: UiStruct.evolve(model, {
                      reader: (reader) =>
                        UiStruct.evolve(reader, { maybeLinksOpen: () => Option.none() }),
                    }),
                  }
                : {
                    model: UiStruct.evolve(unmarked(model), {
                      maybeCopied: () => Option.none(),
                      maybeCopiedLink: () => Option.none(),
                      reader: (reader) =>
                        UiStruct.evolve(reader, {
                          maybeFocus: () => Option.none(),
                          maybePassage: Option.filter((passage) => !isPrdSection(passage.section)),
                          maybePinned: () => Option.none(),
                        }),
                    }),
                  },
            onNonEmpty: (trail) => detailTrailed(model, wentBack(trail)),
          })
        : { model },
    PressedSearchArrowDown: () => searchedWith(model, moved(model.search, 1)),
    PressedSearchArrowUp: () => searchedWith(model, moved(model.search, -1)),
    PressedSearchEnter: () =>
      Option.match(model.search.maybeActive, {
        onNone: () => ({ model }),
        onSome: (node) => selectedResult(model, node),
      }),
    PressedSearchEscape: () => ({ model: UiStruct.evolve(model, { search: () => NO_SEARCH }) }),
    // A patch that arrived stays in the model, loaded or failed, so selecting it again draws it
    // without a fetch, or fetches it again after a failure. A link waiting for data is resolved again.
    ReceivedPatch: ({ path, result }) =>
      reopened(
        model,
        UiStruct.evolve(model, {
          patches: Record.set(
            path,
            Result.match(result, {
              onFailure: (reason) => PatchData.Failed({ message: reason }),
              onSuccess: (text) => PatchData.Loaded({ text }),
            }),
          ),
        }),
      ),
    ReceivedSession: ({ id, result }) =>
      reopened(
        model,
        UiStruct.evolve(model, {
          sessions: Record.set(
            id,
            Result.match(result, {
              onFailure: (reason) => SessionData.Failed({ message: reason }),
              onSuccess: (session) => SessionData.Loaded({ session }),
            }),
          ),
        }),
      ),
    ReceivedPresence: ({ presence }) => ({
      model: UiStruct.evolve(model, {
        participants: () => presence.participants,
        maybeYou: () => Option.some(presence.you),
        readers: (current) =>
          keptReaders(current, readersOf(presence.participants, Option.some(presence.you))),
      }),
    }),
    // Only the section at the top changes on a scroll.
    ScrolledPrd: ({ id }) => ({
      model: UiStruct.evolve(model, {
        reader: (reader) => UiStruct.evolve(reader, { maybeAtTop: () => Option.some(id) }),
      }),
    }),
    // A refreshed trace is searched again: a result that is gone loses its marks and its chain.
    // The first trace opens the link that was waiting for it.
    SettledLoadTrace: ({ result }) => {
      const settled = UiStruct.evolve(model, { trace: settledTrace(result) });
      const searched = UiStruct.evolve(settled, {
        search: (search) => refreshed(search, loadedTraceOf(settled.trace)),
      });
      return Option.match(
        Option.filter(model.maybePendingLink, () => Option.isNone(traceOf(model))),
        { onNone: () => ({ model: searched }), onSome: (link) => openLink(searched, link) },
      );
    },
  });

// COMMAND

/** Moves focus to the heading of the detail panel that just opened or changed its node. */
export const FocusDetailHeading = Command.make("FocusDetailHeading", { args: {} }, () =>
  focusElement(`#${DETAIL_HEADING_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusDetailHeading()),
  ),
);

/** The heading of a PRD section in the PRD pane, or the list item with that ID; the document's own title is not one. */
const prdHeadingSelector = (id: PrdSectionId): string =>
  `[data-section="${id}"]:not([data-title]), [data-item="${id}"]`;

/** Scrolls the PRD pane so a section's heading, or an item, is at its top. */
export const ScrollPrdSection = Command.make(
  "ScrollPrdSection",
  { args: { id: PrdSectionId } },
  ({ id }) =>
    scrollElementIntoView(prdHeadingSelector(id), "start").pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollPrdSection()),
    ),
);

/** Scrolls to each target in turn: the first of its selectors that matches, or none. */
const scrolledTo = (targets: ReadonlyArray<ScrollTarget>) =>
  Effect.forEach(
    targets,
    ({ block, selectors }) =>
      Effect.firstSuccessOf(
        Array.map(selectors, (selector) => scrollElementIntoViewAfterPaint(selector, block)),
      ).pipe(Effect.ignore),
    { discard: true },
  );

/**
 * Brings what a selected result points at into view, each target in its own pane. A target whose
 * element is not in the page, such as a prose block still to be rendered, falls back to the next
 * selector; one that has none is left alone.
 */
export const ScrollSearchTargets = Command.make(
  "ScrollSearchTargets",
  { args: { targets: Schema.Array(ScrollTarget) } },
  ({ targets }) => scrolledTo(targets).pipe(Effect.as(Message.CompletedScrollSearchTargets())),
);

/**
 * Brings each step a link opened into view, in the link's order, so a pane that holds several ends
 * on the deepest. A step whose element is not in the page falls back as a search target does.
 */
export const ScrollLinkTargets = Command.make(
  "ScrollLinkTargets",
  { args: { targets: Schema.Array(ScrollTarget) } },
  ({ targets }) => scrolledTo(targets).pipe(Effect.as(Message.CompletedScrollLinkTargets())),
);

/** Writes a section's ID to the clipboard, and says whether the browser took it. */
export const CopySectionId = Command.make(
  "CopySectionId",
  { args: { id: PrdSectionId } },
  ({ id }) =>
    Effect.tryPromise({
      catch: () => "The browser refused to copy",
      try: () => navigator.clipboard.writeText(id),
    }).pipe(
      Effect.result,
      Effect.map((result) =>
        Message.CompletedCopySectionId({ id, isCopied: Result.isSuccess(result) }),
      ),
    ),
);

/** Writes a link to the clipboard, with the page's origin in front of its path, and says whether the browser took it. */
export const CopyLink = Command.make("CopyLink", { args: { path: Schema.String } }, ({ path }) =>
  Effect.tryPromise({
    catch: () => "The browser refused to copy",
    try: () => navigator.clipboard.writeText(`${location.origin}${path}`),
  }).pipe(
    Effect.result,
    Effect.map((result) => Message.CompletedCopyLink({ isCopied: Result.isSuccess(result), path })),
  ),
);

export const LoadTrace = Command.make("LoadTrace", { args: {} }, () =>
  loadDemoTrace.pipe(
    Effect.mapError(describeTraceError),
    Effect.result,
    Effect.map((result) => Message.SettledLoadTrace({ result })),
  ),
);
