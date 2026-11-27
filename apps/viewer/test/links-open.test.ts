import { urlFromString, type Url } from "../src/url.ts";
import { UiStruct } from "@effect/ui";
import {
  LinesStep,
  PrdSectionId,
  SpecSectionId,
  Step,
  type Link,
  type TraceTask,
} from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Result, Schema, String, pipe } from "effect";

import { commitPathOf, diffPathOf, filesOf, rangeOf, sessionCommitOf } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { linkOf, linkTargetsOf, trunkOf } from "../src/links.ts";
import { Message } from "../src/message.ts";
import { HighlightedTurn, Screen, Shown, TraceData, WHOLE_TASK, type Model } from "../src/model.ts";
import { indexOf } from "../src/search.ts";
import { linkRoute } from "../src/route.ts";
import { openLink, update, withAddress } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import { sessionWith } from "./fixtures.ts";

const decodeStep = Schema.decodeUnknownSync(Step);
const isPrdSection = Schema.is(PrdSectionId);
const isSpecSection = Schema.is(SpecSectionId);

// DEMO DATA

/** A task whose stacked diff can be fetched, and the spec section it builds. */
const task: TraceTask = Option.getOrThrow(
  Array.findFirst(
    demoTrace.tasks,
    (candidate) =>
      Option.isSome(rangeOf(candidate)) && Array.isReadonlyArrayNonEmpty(candidate.specSections),
  ),
);
const { base, head } = Option.getOrThrow(rangeOf(task));
const diffPath = diffPathOf(base, head);
const specSection = Option.getOrThrow(Array.head(task.specSections));

/** A PRD section with prose, and the first words of it. */
const { prdSection, quote } = Option.getOrThrow(
  Array.findFirst(indexOf(demoTrace).content, (entry) =>
    pipe(
      Option.liftPredicate(entry.node.id, isPrdSection),
      Option.flatMap((id) =>
        pipe(
          Array.findFirst(entry.fields, (field) => field.kind === "prose"),
          Option.map((field) =>
            Array.join(Array.take(String.split(String.trim(field.text), /\s+/u), 4), " "),
          ),
          Option.filter(String.isNonEmpty),
          Option.map((words) => ({ prdSection: id, quote: words })),
        ),
      ),
    ),
  ),
);

/** A file the fixture patch holds. */
const FILE = "packages/contract/src/events.ts";

/** Lines the fixture patch shows: its first hunk adds lines 1 to 34. */
const LINES = Schema.decodeUnknownSync(LinesStep)({ end: 3, kind: "lines", side: "new", start: 1 });

const linkTo = (file: string): Link =>
  Array.append(
    Array.map(
      [
        { kind: "passage", quote, section: prdSection },
        { id: specSection, kind: "section" },
        { id: task.id, kind: "task" },
        { head, kind: "diff" },
        { kind: "file", path: file },
      ],
      (step) => decodeStep(step),
    ),
    LINES,
  );

interface Returned {
  readonly commands?: ReadonlyArray<{ readonly args?: unknown; readonly name: string }>;
}

/** The arguments of each command of one name that an update asked for. */
const argsOf = (result: Returned, name: string) =>
  Array.filterMap(
    Option.getOrElse(Option.fromUndefinedOr(result.commands), () => []),
    (command) => (command.name === name ? Result.succeed(command.args) : Result.failVoid),
  );

/** A session some demo commit names. */
const turnSession = Option.getOrThrow(
  Array.findFirst(
    Array.flatMap(demoTrace.tasks, (candidate) => candidate.commits),
    (commit) => Option.fromNullishOr(commit.session),
  ),
);

/** The viewer before its first trace, with a link waiting for it, as `init` leaves it. */
const waitingFor = (link: Link): Model =>
  UiStruct.evolve(init().model, { maybePendingLink: () => Option.some(link) });

const loaded = UiStruct.evolve(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

const firstTrace = Message.SettledLoadTrace({ result: Result.succeed(demoTrace) });

// OPENING

it("the first trace opens a waiting link step by step, and fetches its diff once", () => {
  const link = linkTo(FILE);
  const opened = update(waitingFor(link), firstTrace);
  const { model } = opened;
  expect(model.reader.maybePinned).toEqual(Option.some(prdSection));
  expect(model.reader.maybePassage).toEqual(Option.some(Array.getUnsafe(link, 0)));
  expect(model.detail).toEqual([
    { id: specSection, kind: "section" },
    { id: task.id, kind: "task" },
  ]);
  expect(model.screen).toEqual(
    Screen.Code({
      maybeFile: Option.some(FILE),
      maybeLines: Option.some(LINES),
      shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
      taskId: task.id,
    }),
  );
  expect(linkOf(model)).toEqual(link);
  // The file waits for its patch, so the link stays pending.
  expect(model.maybePendingLink).toEqual(Option.some(link));
  expect(model.maybeLinkNotice).toEqual(Option.none());
  expect(argsOf(opened, "FetchPatch")).toEqual([{ path: diffPath }]);
  expect(Array.length(argsOf(opened, "ScrollLinkTargets"))).toBe(1);

  // A later trace does not open it again.
  const elsewhere = update(model, Message.ClickedBackToPlan()).model;
  expect(update(elsewhere, firstTrace).model.screen).toEqual(Screen.Reader());

  // The patch arrives with the file and its lines: everything stays, and nothing is pending.
  const arrived = update(
    model,
    Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
  );
  expect(linkOf(arrived.model)).toEqual(link);
  expect(arrived.model.maybePendingLink).toEqual(Option.none());
  expect(arrived.model.maybeLinkNotice).toEqual(Option.none());
  expect(argsOf(arrived, "FetchPatch")).toEqual([]);

  // A patch that failed says why and is not fetched again until it is selected again.
  const failed = update(
    model,
    Message.ReceivedPatch({ path: diffPath, result: Result.fail("HTTP 500") }),
  );
  expect(failed.model.maybeLinkNotice).toEqual(
    Option.some(`Opened as far as the diff at ${String.takeLeft(head, 7)}. HTTP 500`),
  );
  expect(argsOf(failed, "FetchPatch")).toEqual([]);
});

it("a patch without the link's file drops the file and its lines and says so", () => {
  const link = linkTo("missing/gone.ts");
  const { model } = update(waitingFor(link), firstTrace);
  const arrived = update(
    model,
    Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
  ).model;
  expect(arrived.screen).toEqual(
    Screen.Code({
      maybeFile: Option.none(),
      maybeLines: Option.none(),
      shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
      taskId: task.id,
    }),
  );
  expect(linkOf(arrived)).toEqual(Array.take(link, 4));
  expect(arrived.maybePendingLink).toEqual(Option.none());
  expect(arrived.maybeLinkNotice).toEqual(
    Option.some(
      `Opened as far as the diff at ${String.takeLeft(head, 7)}. \`missing/gone.ts\` is not in that diff.`,
    ),
  );
  expect(update(arrived, Message.ClickedDismissLinkNotice()).model.maybeLinkNotice).toEqual(
    Option.none(),
  );
});

it("a diff at an older head shows and fetches the task's diff to that commit", () => {
  const stacked = Option.getOrThrow(
    Array.findFirst(
      demoTrace.tasks,
      (candidate) => Array.length(candidate.commits) >= 2 && Option.isSome(rangeOf(candidate)),
    ),
  );
  const oldest = Option.getOrThrow(Array.head(stacked.commits));
  const link = Array.map(
    [
      { id: stacked.id, kind: "task" },
      { head: oldest.sha, kind: "diff" },
    ],
    (step) => decodeStep(step),
  );
  const opened = openLink(loaded, link);
  expect(linkOf(opened.model)).toEqual(link);
  expect(argsOf(opened, "FetchPatch")).toContainEqual({
    path: diffPathOf(Option.getOrThrow(rangeOf(stacked)).base, oldest.sha),
  });
});

it("a turn opens its session's newest commit and highlights the turn while the session loads", () => {
  const session = turnSession;
  const { commit, task: owner } = Option.getOrThrow(sessionCommitOf(demoTrace, session));
  const opened = openLink(loaded, [decodeStep({ kind: "turn", session, turn: "c1" })]);
  expect(opened.model.screen).toEqual(
    Screen.Code({
      maybeFile: Option.none(),
      maybeLines: Option.none(),
      shown: Shown.OneCommit({ sha: commit.sha }),
      taskId: owner.id,
    }),
  );
  expect(opened.model.maybeHighlightedTurn).toEqual(
    Option.some(HighlightedTurn.make({ from: "session", id: "c1" })),
  );
  expect(argsOf(opened, "FetchSession")).toEqual([{ id: session }]);
  // The turn waits for its session.
  expect(Option.isSome(opened.model.maybePendingLink)).toBe(true);
});

it("a click while a link waits for its patch cancels it, so the late patch leaves the click's screen", () => {
  const { model } = update(waitingFor(linkTo(FILE)), firstTrace);
  const clicked = update(model, Message.ClickedBackToPlan()).model;
  expect(clicked.maybePendingLink).toEqual(Option.none());
  const arrived = update(
    clicked,
    Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
  ).model;
  expect(arrived.screen).toEqual(Screen.Reader());
  // The patch still fills the cache.
  expect(Option.isSome(Record.get(arrived.patches, diffPath))).toBe(true);
});

it("a turn that waited for its session is brought into view once the session arrives", () => {
  const opened = openLink(loaded, [decodeStep({ kind: "turn", session: turnSession, turn: "c1" })]);
  const arrived = update(
    opened.model,
    Message.ReceivedSession({ id: turnSession, result: Result.succeed(sessionWith(turnSession)) }),
  );
  expect(arrived.model.maybePendingLink).toEqual(Option.none());
  expect(argsOf(arrived, "ScrollLinkTargets")).toEqual([
    { targets: [{ block: "nearest", selectors: ['[id="turn-c1"]'] }] },
  ]);
});

/** A demo commit with a session, and another session than its. */
const demoCommits = Array.flatMap(demoTrace.tasks, (candidate) => candidate.commits);
const first = Option.getOrThrow(
  Array.findFirst(demoCommits, (commit) => Option.isSome(Option.fromNullishOr(commit.session))),
);
const other = Option.getOrThrow(
  Array.findFirst(demoCommits, (commit) =>
    Option.filter(Option.fromNullishOr(commit.session), (id) => id !== first.session),
  ),
);

it("a turn of another session than the commit before it opens that session's newest commit", () => {
  const newest = Option.getOrThrow(sessionCommitOf(demoTrace, other));
  const opened = openLink(loaded, [
    decodeStep({ kind: "commit", sha: first.sha }),
    decodeStep({ kind: "turn", session: other, turn: "c1" }),
  ]).model;
  expect(opened.screen).toEqual(
    Screen.Code({
      maybeFile: Option.none(),
      maybeLines: Option.none(),
      shown: Shown.OneCommit({ sha: newest.commit.sha }),
      taskId: newest.task.id,
    }),
  );
  expect(Array.last(linkOf(opened))).toEqual(
    Option.some({ kind: "turn", session: other, turn: "c1" }),
  );
});

it("a file before a turn of another session is still checked against its commit's patch", () => {
  const opened = openLink(loaded, [
    decodeStep({ kind: "commit", sha: first.sha }),
    decodeStep({ kind: "file", path: "missing/gone.ts" }),
    decodeStep({ kind: "turn", session: other, turn: "c1" }),
  ]);
  // The turn moves the code view to another commit, but the file waits for this commit's patch.
  const path = commitPathOf(first.sha);
  expect(argsOf(opened, "FetchPatch")).toContainEqual({ path });
  const arrived = update(
    opened.model,
    Message.ReceivedPatch({ path, result: Result.succeed(commitPatch) }),
  ).model;
  expect(arrived.maybePendingLink).toEqual(Option.none());
  expect(arrived.maybeLinkNotice).toEqual(
    Option.some(
      `Opened as far as commit ${String.takeLeft(first.sha, 7)}. \`missing/gone.ts\` is not in that diff.`,
    ),
  );
});

/** A spec section that implements no PRD section, or one that does, and its first four words. */
const specPassageOf = (isCardless: boolean) =>
  Option.getOrThrow(
    Array.findFirst(demoTrace.spec.sections, (candidate) =>
      pipe(
        Option.liftPredicate(
          candidate,
          (found) => Array.isReadonlyArrayEmpty(found.keys.implements) === isCardless,
        ),
        Option.flatMap((found) =>
          Array.findFirst(indexOf(demoTrace).content, (entry) =>
            entry.node.id === found.id
              ? Array.findFirst(entry.fields, (field) => field.kind === "prose")
              : Option.none(),
          ),
        ),
        Option.map((field) =>
          Array.join(Array.take(String.split(String.trim(field.text), /\s+/u), 4), " "),
        ),
        Option.filter(String.isNonEmpty),
        Option.map((words) => ({ section: candidate.id, words })),
      ),
    ),
  );

it("a passage of a spec section with no card opens to itself, and its trail does not grow", () => {
  const { section, words } = specPassageOf(true);
  const link = [decodeStep({ kind: "passage", quote: words, section })];
  const once = openLink(loaded, link).model;
  expect(once.detail).toEqual([{ id: section, kind: "section" }]);
  expect(linkOf(once)).toEqual(link);
  const twice = openLink(loaded, linkOf(once)).model;
  expect(twice.detail).toEqual(once.detail);
  expect(linkOf(twice)).toEqual(link);
  // A passage with a card implies no trail step, so its section opened in the panel is written.
  const carded = specPassageOf(false);
  const withCard = [
    decodeStep({ kind: "passage", quote: carded.words, section: carded.section }),
    decodeStep({ id: carded.section, kind: "section" }),
  ];
  expect(Array.drop(linkOf(openLink(loaded, withCard).model), 1)).toEqual(withCard);
});

it("a link to a task the trace lacks opens nothing and says so", () => {
  const opened = openLink(loaded, [decodeStep({ id: "zz404", kind: "task" })]).model;
  expect(opened.screen).toEqual(Screen.Reader());
  expect(opened.detail).toEqual([]);
  expect(opened.maybeLinkNotice).toEqual(
    Option.some("Nothing in this link opened. No task zz404 in the trace."),
  );
});

it("a click on a file drops the lines, and Escape clears the focus with the pin", () => {
  const opened = update(waitingFor(linkTo(FILE)), firstTrace).model;
  const path = Option.getOrThrow(Array.head(filesOf(task, WHOLE_TASK)));
  expect(update(opened, Message.ClickedTreeFile({ path })).model.screen).toEqual(
    Screen.Code({
      maybeFile: Option.some(path),
      maybeLines: Option.none(),
      shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
      taskId: task.id,
    }),
  );
  const { root } = Option.getOrThrow(Array.head(stacksOf(demoTrace.tasks)));
  const focused = openLink(loaded, [decodeStep({ kind: "stack", root })]);
  expect(focused.model.reader.maybeFocus).toEqual(Option.some({ kind: "stack", root }));
  expect(argsOf(focused, "ScrollLinkTargets")).toHaveLength(1);
  expect(update(focused.model, Message.PressedEscape()).model.reader.maybeFocus).toEqual(
    Option.none(),
  );
});

// HISTORY

/** The viewer's update as the application runs it, writing the address. */
const app = withAddress(update);

/** The address of a link in a window of the viewer. */
const urlOf = (link: Link): Url =>
  Option.getOrThrow(
    urlFromString(`http://localhost:4310${Option.getOrThrow(linkRoute.print(link))}`),
  );

const pathOf = (link: Link) => ({ path: Option.getOrThrow(linkRoute.print(link)) });

/** The history an update wrote: each entry replaced, and each pushed, in order. */
const writtenBy = (result: Returned) => ({
  pushed: argsOf(result, "PushUrl"),
  replaced: argsOf(result, "ReplaceUrl"),
});

const NOTHING_WRITTEN = { pushed: [], replaced: [] };

it("a link opened in a new window opens on the first trace and writes one history entry per step", () => {
  const link = linkTo(FILE);
  const started = init(urlOf(link));
  expect(started.model.maybePendingLink).toEqual(Option.some(link));
  expect(started.model.screen).toEqual(Screen.Reader());
  const opened = app(started.model, firstTrace);
  const { model } = opened;
  expect(model.reader.maybePinned).toEqual(Option.some(prdSection));
  expect(model.reader.maybePassage).toEqual(Option.some(Array.getUnsafe(link, 0)));
  expect(model.detail).toEqual([
    { id: specSection, kind: "section" },
    { id: task.id, kind: "task" },
  ]);
  expect(model.screen).toEqual(
    Screen.Code({
      maybeFile: Option.some(FILE),
      maybeLines: Option.some(LINES),
      shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
      taskId: task.id,
    }),
  );
  expect(writtenBy(opened)).toEqual({
    pushed: Array.map([2, 3, 4, 5, 6], (length) => pathOf(Array.take(link, length))),
    replaced: [pathOf(Array.take(link, 1))],
  });
  expect(argsOf(opened, "FetchPatch")).toEqual([{ path: diffPath }]);
  expect(diffPath).toBe(`/api/diffs/${base}/${head}`);
  // A later trace writes nothing.
  expect(writtenBy(app(model, firstTrace))).toEqual(NOTHING_WRITTEN);
});

it("Back to the root before the first trace drops the link that was waiting for it", () => {
  const started = init(urlOf(linkTo(FILE))).model;
  const back = app(started, Message.ChangedUrl({ url: urlOf([]) }));
  expect(back.model.maybePendingLink).toEqual(Option.none());
  expect(writtenBy(back)).toEqual(NOTHING_WRITTEN);
  const loadedLater = app(back.model, firstTrace);
  expect(loadedLater.model.screen).toEqual(Screen.Reader());
  expect(writtenBy(loadedLater)).toEqual(NOTHING_WRITTEN);
});

it("an address that is not a link opens the reader under its notice, and writes nothing", () => {
  const url = Option.getOrThrow(urlFromString("http://localhost:4310/task/t1/file/x.ts"));
  const started = init(url).model;
  expect(started.screen).toEqual(Screen.Reader());
  expect(started.maybePendingLink).toEqual(Option.none());
  expect(started.maybeLinkNotice).toEqual(
    Option.some("This address is not a Cairn link: step 1 (file): must follow a diff or a commit."),
  );
  expect(writtenBy(app(started, firstTrace))).toEqual(NOTHING_WRITTEN);
  // Back to such an address says the same and clears what was open.
  const back = app(app(started, firstTrace).model, Message.ChangedUrl({ url }));
  expect(back.model.maybeLinkNotice).toEqual(started.maybeLinkNotice);
  expect(writtenBy(back)).toEqual(NOTHING_WRITTEN);
});

it("Back walks a link one step at a time without writing history, and a click after pushes", () => {
  const link = linkTo(FILE);
  const opened = app(
    app(init(urlOf(link)).model, firstTrace).model,
    Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
  ).model;
  // The viewer's own address does nothing.
  const echo = app(opened, Message.ChangedUrl({ url: urlOf(link) }));
  expect(echo.model).toBe(opened);
  expect(echo.commands).toEqual([]);

  const lengths = [5, 4, 3, 2, 1, 0];
  const walked = Array.scan(
    lengths,
    { model: opened },
    (current: Returned & { readonly model: Model }, length) =>
      app(current.model, Message.ChangedUrl({ url: urlOf(Array.take(link, length)) })),
  );
  const steps = Array.drop(walked, 1);
  expect(Array.map(steps, (step) => writtenBy(step))).toEqual(
    Array.map(lengths, () => NOTHING_WRITTEN),
  );
  expect(Array.map(steps, (step) => linkOf(step.model))).toEqual(
    Array.map(lengths, (length) => Array.take(link, length)),
  );
  const screens = Array.map(steps, (step) => step.model.screen);
  const code = (maybeFile: Option.Option<string>) =>
    Screen.Code({
      maybeFile,
      maybeLines: Option.none(),
      shown: Shown.WholeTask({ maybeHead: Option.some(head) }),
      taskId: task.id,
    });
  expect(screens).toEqual([
    code(Option.some(FILE)),
    code(Option.none()),
    Screen.Reader(),
    Screen.Reader(),
    Screen.Reader(),
    Screen.Reader(),
  ]);
  expect(Array.map(steps, (step) => step.model.detail)).toEqual([
    [
      { id: specSection, kind: "section" },
      { id: task.id, kind: "task" },
    ],
    [
      { id: specSection, kind: "section" },
      { id: task.id, kind: "task" },
    ],
    [
      { id: specSection, kind: "section" },
      { id: task.id, kind: "task" },
    ],
    [{ id: specSection, kind: "section" }],
    [],
    [],
  ]);
  expect(Array.map(steps, (step) => step.model.reader.maybePinned)).toEqual([
    Option.some(prdSection),
    Option.some(prdSection),
    Option.some(prdSection),
    Option.some(prdSection),
    Option.some(prdSection),
    Option.none(),
  ]);

  const empty = Option.getOrThrow(Array.last(steps)).model;
  const clicked = app(empty, Message.ClickedTask({ id: task.id }));
  expect(writtenBy(clicked)).toEqual({ pushed: [{ path: `/task/${task.id}` }], replaced: [] });
});

it("a patch without the link's file shows the notice, drops the file and replaces the address", () => {
  const link = linkTo("missing/gone.ts");
  const { model } = app(init(urlOf(link)).model, firstTrace);
  const arrived = app(
    model,
    Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
  );
  expect(Option.isSome(arrived.model.maybeLinkNotice)).toBe(true);
  expect(linkOf(arrived.model)).toEqual(Array.take(link, 4));
  expect(writtenBy(arrived)).toEqual({ pushed: [], replaced: [pathOf(Array.take(link, 4))] });
  // A patch that changes nothing on screen writes nothing.
  expect(
    writtenBy(
      app(
        arrived.model,
        Message.ReceivedPatch({ path: diffPath, result: Result.succeed(commitPatch) }),
      ),
    ),
  ).toEqual(NOTHING_WRITTEN);
});

// CANONICAL LINKS

const prdIds = Array.filter(
  Array.map(demoTrace.prd.sections, (section) => section.id),
  isPrdSection,
);
const specIds = Array.filter(
  Array.map(demoTrace.spec.sections, (section) => section.id),
  isSpecSection,
);
const stacks = stacksOf(demoTrace.tasks);
const focuses: ReadonlyArray<Step> = Array.appendAll(
  Array.map(stacks, (stack): Step => ({ kind: "stack", root: stack.root })),
  Array.filterMap(stacks, (stack) =>
    Array.length(trunkOf(stack, demoTrace.tasks)) >= 2
      ? Result.succeed<Step>({ kind: "segment", root: stack.root })
      : Result.failVoid,
  ),
);
const trailSteps: ReadonlyArray<Step> = Array.appendAll(
  Array.map(specIds, (id): Step => ({ id, kind: "section" })),
  Array.map(demoTrace.tasks, (candidate): Step => ({ id: candidate.id, kind: "task" })),
);

const Pick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000));

/** Picks for a canonical link: a pin or none, a focus or none, and up to three trail steps. */
const Canonical = Schema.Struct({
  focus: Pick,
  length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3)),
  pin: Pick,
  trail: Schema.Tuple([Pick, Pick, Pick]),
});

/** The item at `at`, where the length of the list itself picks none. */
const pickOrNone = <A>(items: ReadonlyArray<A>, at: number): ReadonlyArray<A> =>
  Array.fromOption(Array.get(items, at % (Array.length(items) + 1)));

it.prop(
  "a canonical link of sections, tasks and stacks opens to itself",
  [Canonical],
  ([{ focus, length, pin, trail }]) => {
    const link: Link = Array.flatten<ReadonlyArray<ReadonlyArray<Step>>>([
      Array.map(pickOrNone(prdIds, pin), (id): Step => ({ id, kind: "section" })),
      pickOrNone(focuses, focus),
      Array.filterMap(Array.take(trail, length), (at) =>
        Result.fromOption(Array.get(trailSteps, at % Array.length(trailSteps)), () => undefined),
      ),
    ]);
    expect(linkOf(openLink(loaded, link).model)).toEqual(link);
  },
);

// LIST ITEMS

const ITEM = "prd.cli.lint";
const ITEM_TASK = "t110";

it("a section step that names a list item pins it, and the link it writes is the same", () => {
  const link = [decodeStep({ id: ITEM, kind: "section" })];
  const opened = openLink(loaded, link).model;
  expect(opened.maybeLinkNotice).toEqual(Option.none());
  expect(opened.reader.maybePinned).toEqual(Option.some(PrdSectionId.make(ITEM)));
  expect(linkOf(opened)).toEqual(link);
});

it("an item followed by a task opens both", () => {
  const link = [
    decodeStep({ id: ITEM, kind: "section" }),
    decodeStep({ id: ITEM_TASK, kind: "task" }),
  ];
  const opened = openLink(loaded, link).model;
  expect(opened.maybeLinkNotice).toEqual(Option.none());
  expect(opened.reader.maybePinned).toEqual(Option.some(PrdSectionId.make(ITEM)));
  expect(Array.map(opened.detail, (node) => node.id)).toEqual([ITEM_TASK]);
  expect(linkOf(opened)).toEqual(link);
});

it("a section step that names neither a section nor an item is still deleted", () => {
  const opened = openLink(loaded, [decodeStep({ id: "prd.cli.no-such-item", kind: "section" })]);
  expect(opened.model.reader.maybePinned).toEqual(Option.none());
  expect(opened.model.maybeLinkNotice).toEqual(
    Option.some(
      "Nothing in this link opened. No section has the ID prd.cli.no-such-item: it was deleted.",
    ),
  );
});

it("an item's step scrolls the PRD pane to the item", () => {
  const targets = linkTargetsOf(demoTrace, decodeStep({ id: ITEM, kind: "section" }));
  expect(Array.flatMap(targets, (target) => target.selectors)).toContain(
    `[data-prd-pane] [data-item="${ITEM}"]`,
  );
});
