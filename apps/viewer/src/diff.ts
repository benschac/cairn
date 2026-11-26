import { LinesStep, Session } from "@cairn/contract";
import {
  CodeView,
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  Array,
  Effect,
  Equal,
  Function,
  MutableRef,
  Number,
  Option,
  Predicate,
  Queue,
  Record,
  Result,
  Schema,
  Stream,
  String,
} from "effect";
import { Mount } from "@effect/ui";

import {
  attributionOf,
  markLineOf,
  type Attribution,
  type HunkAttribution,
} from "./attribution.ts";
import { Message } from "./message.ts";
import { DiffStyle, HighlightedTurn } from "./model.ts";

/** The patch text could not be read by `@pierre/diffs`. */
export class PatchNotParsed extends Schema.TaggedError<PatchNotParsed>()("PatchNotParsed", {
  cause: Schema.Defect(),
}) {}

/** What a patch holds: the commit message `git show` leads with, and one entry per changed file. */
export interface PatchFiles {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  /** The commit's header and message; none for a `git diff` patch. */
  readonly maybeMessage: Option.Option<string>;
}

/**
 * The files of a patch: `git show --patch` output for one commit, or `git diff --patch` output
 * for a range. The library reads the hunks; Cairn only collects what it returns.
 */
export const parsePatch = (text: string): Result.Result<PatchFiles, PatchNotParsed> =>
  Result.map(
    Result.try({
      catch: (cause) => new PatchNotParsed({ cause }),
      try: () => parsePatchFiles(text),
    }),
    (patches) => ({
      files: Array.flatMap(patches, (patch) => patch.files),
      maybeMessage: Option.filter(
        Option.flatMap(Array.head(patches), (patch) => Option.fromUndefinedOr(patch.patchMetadata)),
        String.isNonEmpty,
      ),
    }),
  );

/** The sentence the viewer shows for a patch that did not parse. */
export const describePatchNotParsed = ({ cause }: PatchNotParsed): string =>
  `The patch did not parse: ${globalThis.String(cause)}`;

/** The model's diff style reaches the mount through this attribute on its element. */
export const DIFF_STYLE_ATTRIBUTE = "data-diff-style";

/** The file the tree selected reaches the mount through this attribute on its element. */
export const FILE_ATTRIBUTE = "data-file";

/**
 * The lines a link selected in that file reach the mount through this attribute on its element,
 * written as the link writes them: `n40-42` for lines 40 to 42 of the new side, `o7` for line 7 of
 * the old side.
 */
export const LINES_ATTRIBUTE = "data-lines";

/** The highlighted turn reaches the mount through this attribute on its element. */
export const TURN_ATTRIBUTE = "data-turn";

/** Which pane chose the highlighted turn reaches the mount through this attribute. */
export const TURN_FROM_ATTRIBUTE = "data-turn-from";

/** A hunk's mark as the list draws it: the turns that wrote the hunk, and whether one is highlighted. */
export interface HunkMark {
  readonly attribution: HunkAttribution;
  readonly isActive: boolean;
}

/** Draws a hunk's mark into the list; none draws nothing. */
export type RenderMark = (annotation: { readonly metadata: HunkMark }) => HTMLElement | undefined;

const NO_MARK: RenderMark = () => undefined;

/** The diff style a list starts in, and the one an attribute that is missing or unknown means. */
const DEFAULT_DIFF_STYLE: DiffStyle = "unified";

/**
 * What the list tells the mount when a person selects lines: the ID of the item the selection was
 * made in, and the range, or none when the selection was cleared.
 */
export type LinesSelected = (id: string, maybeRange: Option.Option<SelectedLineRange>) => void;

const NO_SELECTION: LinesSelected = () => undefined;

/**
 * What the list is built with. The Highlights backend colours code with the lexers and the light
 * palette the documents' fenced code uses, so Shiki is never loaded; a file's language is the one
 * `@pierre/diffs` infers from its path, and a path with no lexer is plain text with its added and
 * removed lines still marked. `setOptions` replaces the options whole, so every change to the style
 * goes through this and not through a partial.
 */
export const diffOptionsOf = (
  style: DiffStyle,
  renderMark: RenderMark = NO_MARK,
  onLines: LinesSelected = NO_SELECTION,
): CodeViewOptions<HunkMark, undefined> => ({
  diffStyle: style,
  enableLineSelection: true,
  hunkSeparators: "line-info",
  lineDiffType: "word-alt",
  // A selection is reported when it is made, not as it is dragged: one message for each.
  onLineSelected: (range, context) => {
    onLines(context.item.id, Option.fromNullOr(range));
  },
  preferredHighlighter: "highlights",
  renderAnnotation: renderMark,
  stickyHeaders: true,
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
});

/** The ID of a file's item in the list, which a scroll names. */
export const itemIdOf = (path: string): string => `diff:${path}`;

const isWrittenBy = (hunk: HunkAttribution, id: string): boolean =>
  Array.some(hunk.turns, (turn) => turn.id === id);

/**
 * A file's marks: one line annotation per hunk, on its first changed line, active when the
 * highlighted turn wrote that hunk.
 */
export const annotationsOf = (
  file: FileDiffMetadata,
  attribution: Attribution,
  maybeTurnId: Option.Option<string>,
): ReadonlyArray<DiffLineAnnotation<HunkMark>> => {
  const hunks = Array.filter(attribution.hunks, (hunk) => hunk.path === file.name);
  return Array.getSomes(
    Array.map(file.hunks, (hunk, index) =>
      Option.map(
        Option.all({
          line: markLineOf(hunk),
          marked: Array.findFirst(hunks, (each) => each.index === index),
        }),
        ({ line, marked }) => ({
          lineNumber: line.lineNumber,
          metadata: {
            attribution: marked,
            isActive: Option.exists(maybeTurnId, (id) => isWrittenBy(marked, id)),
          },
          side: line.side,
        }),
      ),
    ),
  );
};

/**
 * One `diff` item per file, in the order the patch has them, with its hunks' marks when the
 * commit's session has been read. A changed mark needs a new version for the list to draw it.
 */
export const itemsOf = (
  files: ReadonlyArray<FileDiffMetadata>,
  maybeAttribution: Option.Option<Attribution> = Option.none(),
  maybeTurnId: Option.Option<string> = Option.none(),
  version = 0,
): ReadonlyArray<CodeViewItem<HunkMark>> =>
  Array.map(files, (file) => ({
    annotations: Option.match(maybeAttribution, {
      onNone: () => [],
      onSome: (attribution) => Array.copy(annotationsOf(file, attribution, maybeTurnId)),
    }),
    fileDiff: file,
    id: itemIdOf(file.name),
    type: "diff" as const,
    version,
  }));

const decodeDiffStyle = Schema.decodeUnknownOption(DiffStyle);

/** The diff style in the element's attribute; unified when it is missing or is not a style. */
export const diffStyleOf = (element: Element): DiffStyle =>
  Option.getOrElse(
    Option.flatMap(Option.fromNullOr(element.getAttribute(DIFF_STYLE_ATTRIBUTE)), decodeDiffStyle),
    () => DEFAULT_DIFF_STYLE,
  );

/** The file in the element's attribute, if the tree has selected one. */
export const fileOf = (element: Element): Option.Option<string> =>
  Option.fromNullOr(element.getAttribute(FILE_ATTRIBUTE));

const LINES_SIDES = { new: "n", old: "o" } as const;

/** What the lines attribute holds for a lines step: `n40-42`, or `n40` for one line. */
export const linesTextOf = ({ end, side, start }: typeof LinesStep.Type): string =>
  `${LINES_SIDES[side]}${start}${start === end ? "" : `-${end}`}`;

const LINES_TEXT = /^([no])(\d+)(?:-(\d+))?$/u;

const decodeLines = Schema.decodeUnknownOption(LinesStep);

/** The lines a lines attribute's text names; none when it is not a range of lines. */
export const linesFromText = (text: string): Option.Option<typeof LinesStep.Type> =>
  Option.flatMap(Option.fromNullOr(LINES_TEXT.exec(text)), (groups) =>
    Option.flatMap(
      Option.all({
        side: Option.map(Option.fromUndefinedOr(groups[1]), (letter) =>
          letter === "n" ? "new" : "old",
        ),
        start: Option.flatMap(Option.fromUndefinedOr(groups[2]), Number.parse),
      }),
      ({ side, start }) =>
        decodeLines({
          end: Option.getOrElse(
            Option.flatMap(Option.fromUndefinedOr(groups[3]), Number.parse),
            () => start,
          ),
          kind: "lines",
          side,
          start,
        }),
    ),
  );

/** The lines in the element's attribute; none when it is missing or is not a range of lines. */
export const linesOf = (element: Element): Option.Option<typeof LinesStep.Type> =>
  Option.flatMap(Option.fromNullOr(element.getAttribute(LINES_ATTRIBUTE)), linesFromText);

/**
 * The lines a selection in the list makes: the range ordered, on the side it started on. A range
 * that crosses from one side to the other has no lines on a single side, so it links its first
 * line alone.
 */
export const linesOfRange = (range: SelectedLineRange): Option.Option<typeof LinesStep.Type> => {
  const side = Option.getOrElse(
    Option.fromUndefinedOr(range.side),
    (): "additions" | "deletions" => "additions",
  );
  const isCrossing = Option.exists(Option.fromUndefinedOr(range.endSide), (end) => end !== side);
  return decodeLines({
    end: isCrossing ? range.start : Number.max(range.start, range.end),
    kind: "lines",
    side: side === "additions" ? "new" : "old",
    start: isCrossing ? range.start : Number.min(range.start, range.end),
  });
};

/** The file a selection in the list was made in, and the lines it selected there. */
export interface DiffSelection {
  readonly lines: typeof LinesStep.Type;
  readonly path: string;
}

/**
 * What a selection in the list selects: the file whose item it was made in, which a link names even
 * when it was not the one open, and the lines. None when it was cleared, is in no file of the patch
 * or is not lines.
 */
export const diffSelectionOf = (
  files: ReadonlyArray<FileDiffMetadata>,
  id: string,
  maybeRange: Option.Option<SelectedLineRange>,
): Option.Option<DiffSelection> =>
  Option.all({
    lines: Option.flatMap(maybeRange, linesOfRange),
    path: Option.map(
      Array.findFirst(files, (file) => itemIdOf(file.name) === id),
      (file) => file.name,
    ),
  });

const sameLines = Option.makeEquivalence(Schema.toEquivalence(LinesStep));

const decodeHighlightedTurn = Schema.decodeUnknownOption(HighlightedTurn);

const sameTurn = Option.makeEquivalence(Schema.toEquivalence(HighlightedTurn));

/** The highlighted turn in the element's attributes, and the pane that chose it. */
export const turnOf = (element: Element): Option.Option<HighlightedTurn> =>
  Option.flatMap(Option.fromNullOr(element.getAttribute(TURN_ATTRIBUTE)), (id) =>
    decodeHighlightedTurn({ from: element.getAttribute(TURN_FROM_ATTRIBUTE), id }),
  );

/** The sentence for whatever the library threw. */
const reasonOf = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : globalThis.String(cause);

/** Scrolls the file's item to the top of the list. A file the patch does not hold scrolls nothing. */
const scrollToFile = (list: CodeView<HunkMark>, path: string): void => {
  const id = itemIdOf(path);
  if (Predicate.isNotUndefined(list.getItem(id))) {
    list.scrollTo({ align: "start", id, type: "item" });
  }
};

/**
 * Selects the lines a link named in its file and scrolls to them, on the side the link names. No
 * lines, or lines in a file the patch does not hold, leave nothing selected.
 */
const showLines = (
  list: CodeView<HunkMark>,
  maybeFile: Option.Option<string>,
  maybeLines: Option.Option<typeof LinesStep.Type>,
): void =>
  Option.match(
    Option.filter(Option.all({ lines: maybeLines, path: maybeFile }), ({ path }) =>
      Predicate.isNotUndefined(list.getItem(itemIdOf(path))),
    ),
    {
      onNone: () => {
        list.clearSelectedLines({ notify: false });
      },
      onSome: ({ lines, path }) => {
        const side = lines.side === "new" ? "additions" : "deletions";
        list.setSelectedLines(
          {
            id: itemIdOf(path),
            range: { end: lines.end, endSide: side, side, start: lines.start },
          },
          { notify: false },
        );
        list.scrollTo({
          align: "center",
          id: itemIdOf(path),
          lineNumber: lines.start,
          side,
          type: "line",
        });
      },
    },
  );

/** Scrolls the list to the first hunk the turn wrote. A turn that wrote none scrolls nothing. */
const scrollToTurn = (
  list: CodeView<HunkMark>,
  files: ReadonlyArray<FileDiffMetadata>,
  attribution: Attribution,
  id: string,
): void =>
  Option.match(
    Option.flatMap(
      Option.flatMap(Record.get(attribution.turns, id), Array.head),
      ({ index, path }) =>
        Option.map(
          Option.flatMap(
            Option.flatMap(
              Array.findFirst(files, (file) => file.name === path),
              (file) => Array.get(file.hunks, index),
            ),
            markLineOf,
          ),
          (line) => ({ line, path }),
        ),
    ),
    {
      onNone: Function.constVoid,
      onSome: ({ line, path }) =>
        list.scrollTo({
          align: "center",
          id: itemIdOf(path),
          lineNumber: line.lineNumber,
          side: line.side,
          type: "line",
        }),
    },
  );

/**
 * A hunk's mark: a button per turn that wrote it, which sends `ClickedHunkMark`, then "Partly
 * traced" or "Not traced to a turn" where that applies. The library owns this DOM, so the mark is
 * built here and not by the view; its text goes in as text, not as markup.
 */
const markElement = (
  document: Document,
  { attribution, isActive }: HunkMark,
  onTurn: (id: string) => void,
): HTMLElement => {
  const mark = document.createElement("div");
  mark.setAttribute("data-hunk-mark", attribution.traced);
  mark.toggleAttribute("data-active", isActive);
  const buttons = Array.map(attribution.turns, (turn) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.setAttribute("data-mark-turn", turn.id);
    button.textContent = `Turn ${turn.number} · ${turn.name}`;
    button.addEventListener("click", () => onTurn(turn.id));
    return button;
  });
  const notes = Array.map(
    Array.filter(
      [
        { isShown: attribution.traced === "partly", text: "Partly traced" },
        { isShown: attribution.traced === "untraced", text: "Not traced to a turn" },
      ],
      ({ isShown }) => isShown,
    ),
    ({ text }) => {
      const note = document.createElement("span");
      note.setAttribute("data-trace-note", "");
      note.textContent = text;
      return note;
    },
  );
  Array.forEach(Array.appendAll<HTMLElement, HTMLElement>(buttons, notes), (child) => {
    mark.append(child);
  });
  return mark;
};

/** Puts a sentence where the list would be. The text goes in as text, not as markup. */
const showNote = (element: Element, note: string, isAlert: boolean): void => {
  const paragraph = element.ownerDocument.createElement("p");
  paragraph.setAttribute("role", isAlert ? "alert" : "status");
  paragraph.textContent = note;
  element.replaceChildren(paragraph);
};

/** What the list was drawn from: the patch's files and, once its session is read, their marks. */
interface Drawn {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly maybeAttribution: Option.Option<Attribution>;
  readonly renderMark: RenderMark;
}

/**
 * Scrolls the list to the first hunk of a turn the session pane chose. A turn chosen from the
 * diff's own mark leaves the list where it is, as does a list with no session.
 */
const followTurn = (
  list: CodeView<HunkMark>,
  drawn: Drawn,
  maybeTurn: Option.Option<HighlightedTurn>,
): void =>
  Option.match(
    Option.all({
      attribution: drawn.maybeAttribution,
      turn: Option.filter(maybeTurn, ({ from }) => from === "session"),
    }),
    {
      onNone: Function.constVoid,
      onSome: ({ attribution, turn }) => scrollToTurn(list, drawn.files, attribution, turn.id),
    },
  );

/**
 * Applies each change the model makes to the element's attributes: a new style goes to the list as
 * options, a new file is scrolled to, and a new highlighted turn redraws the marks with its hunks
 * active and, when the session pane chose it, scrolls to its first hunk. The element's attributes
 * at mount are what the list started with, so only a difference from them is applied. The observer
 * disconnects when the scope closes.
 */
const watchAttributes = (
  element: Element,
  list: CodeView<HunkMark>,
  drawn: Drawn,
  shown: {
    readonly file: MutableRef.MutableRef<Option.Option<string>>;
    readonly lines: MutableRef.MutableRef<Option.Option<typeof LinesStep.Type>>;
  },
  linesSelected: LinesSelected,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const shownStyle = MutableRef.make(diffStyleOf(element));
      const shownTurn = MutableRef.make(turnOf(element));
      const version = MutableRef.make(0);
      const watcher = new MutationObserver(() => {
        const style = diffStyleOf(element);
        if (style !== MutableRef.get(shownStyle)) {
          MutableRef.set(shownStyle, style);
          list.setOptions(diffOptionsOf(style, drawn.renderMark, linesSelected));
        }
        const maybeFile = fileOf(element);
        const isNewFile = !Equal.equals(maybeFile, MutableRef.get(shown.file));
        if (isNewFile) {
          MutableRef.set(shown.file, maybeFile);
          Option.match(maybeFile, {
            onNone: Function.constVoid,
            onSome: (path) => scrollToFile(list, path),
          });
        }
        const maybeLines = linesOf(element);
        if (isNewFile || !sameLines(maybeLines, MutableRef.get(shown.lines))) {
          MutableRef.set(shown.lines, maybeLines);
          showLines(list, maybeFile, maybeLines);
        }
        const maybeTurn = turnOf(element);
        if (!sameTurn(maybeTurn, MutableRef.get(shownTurn))) {
          MutableRef.set(shownTurn, maybeTurn);
          Option.match(drawn.maybeAttribution, {
            onNone: Function.constVoid,
            onSome: () => {
              const next = MutableRef.incrementAndGet(version);
              const turnId = Option.map(maybeTurn, ({ id }) => id);
              Array.forEach(itemsOf(drawn.files, drawn.maybeAttribution, turnId, next), (item) => {
                list.updateItem(item);
              });
              followTurn(list, drawn, maybeTurn);
            },
          });
        }
      });
      watcher.observe(element, {
        attributeFilter: [
          DIFF_STYLE_ATTRIBUTE,
          FILE_ATTRIBUTE,
          LINES_ATTRIBUTE,
          TURN_ATTRIBUTE,
          TURN_FROM_ATTRIBUTE,
        ],
        attributes: true,
      });
      return watcher;
    }),
    (watcher) => Effect.sync(() => watcher.disconnect()),
  );

/**
 * A list of the files in the element, starting in the style and at the file its attributes name,
 * with each hunk marked by the turns of the session that wrote it when there is a session. The
 * list is cleaned up when the scope closes. Anything the library throws while starting is shown in
 * the element as a sentence instead.
 */
const drawFiles = (
  element: HTMLElement,
  files: ReadonlyArray<FileDiffMetadata>,
  maybeSession: Option.Option<Session>,
  onTurn: (id: string) => void,
  onLines: (maybeSelection: Option.Option<DiffSelection>) => void,
) =>
  Effect.gen(function* () {
    // The file and lines the list shows: the attributes' at mount, then each the person selected or
    // the model wrote. A selection is remembered here before it is sent, so the attributes it comes
    // back as are already shown and the list does not scroll to what the person just selected.
    const shown = {
      file: MutableRef.make(fileOf(element)),
      lines: MutableRef.make(linesOf(element)),
    };
    const linesSelected: LinesSelected = (id, maybeRange) =>
      Option.match(diffSelectionOf(files, id, maybeRange), {
        onNone: () => {
          if (Option.isSome(MutableRef.get(shown.lines))) {
            MutableRef.set(shown.lines, Option.none());
            onLines(Option.none());
          }
        },
        onSome: (selection) => {
          const isShown =
            sameLines(Option.some(selection.lines), MutableRef.get(shown.lines)) &&
            Option.contains(MutableRef.get(shown.file), selection.path);
          if (!isShown) {
            MutableRef.set(shown.file, Option.some(selection.path));
            MutableRef.set(shown.lines, Option.some(selection.lines));
            onLines(Option.some(selection));
          }
        },
      });
    const drawn: Drawn = {
      files,
      maybeAttribution: Option.map(maybeSession, (session) => attributionOf(files, session)),
      renderMark: ({ metadata }) => markElement(element.ownerDocument, metadata, onTurn),
    };
    const list = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new CodeView<HunkMark>(
            diffOptionsOf(diffStyleOf(element), drawn.renderMark, linesSelected),
          ),
      ),
      (started) => Effect.sync(() => started.cleanUp()),
    );
    yield* Effect.try({
      catch: reasonOf,
      try: () => {
        list.setup(element);
        list.setItems(
          itemsOf(
            files,
            drawn.maybeAttribution,
            Option.map(turnOf(element), ({ id }) => id),
          ),
        );
        Option.match(fileOf(element), {
          onNone: Function.constVoid,
          onSome: (path) => scrollToFile(list, path),
        });
        // Lines a link named are selected and scrolled to after the file, so they win the scroll.
        if (Option.isSome(linesOf(element))) {
          showLines(list, fileOf(element), linesOf(element));
        }
        // A turn opened in the session pane while the diff was loading is scrolled to as well.
        followTurn(list, drawn, turnOf(element));
      },
    });
    yield* watchAttributes(element, list, drawn, shown, linesSelected);
  }).pipe(
    Effect.catch((reason) =>
      Effect.sync(() => showNote(element, `The diff could not be drawn: ${reason}`, true)),
    ),
  );

/**
 * What it sends: that it has drawn, each click on a hunk's turn, and the lines a person selects or
 * clears. Parses the patch and draws its files into the element with the library's `CodeView`, a
 * virtualized list that owns the DOM inside the element, then watches the element's attributes
 * (see `watchAttributes`). With the commit's session, each hunk carries a mark naming the turns
 * that wrote it (see `attributionOf`), and a click on one of them is sent as `ClickedHunkMark`.
 * Cleanup calls `cleanUp()` when the element goes. Mount arguments are fixed when the element
 * appears, so the view keys the element by the patch's route path and the session: another patch,
 * or the session arriving, is another element and its own list. A patch that does not parse, or
 * has no files, says so in the element.
 */
export const RenderDiff = Mount.makeStream(
  "RenderDiff",
  { args: { session: Schema.Option(Schema.toType(Session)), text: Schema.String } },
  (element: Element, { session, text }) =>
    Stream.callback<Message>((queue) =>
      Effect.gen(function* () {
        yield* Result.match(parsePatch(text), {
          onFailure: (error) =>
            Effect.sync(() => showNote(element, describePatchNotParsed(error), true)),
          onSuccess: ({ files }) =>
            Array.match(files, {
              onEmpty: () =>
                Effect.sync(() => showNote(element, "This patch changes no files.", false)),
              onNonEmpty: (changed) =>
                element instanceof HTMLElement
                  ? drawFiles(
                      element,
                      changed,
                      session,
                      (id) => {
                        Queue.offerUnsafe(queue, Message.ClickedHunkMark({ id }));
                      },
                      (maybeSelection) => {
                        Queue.offerUnsafe(
                          queue,
                          Option.match(maybeSelection, {
                            onNone: () => Message.ClearedDiffLines(),
                            onSome: ({ lines: { end, side, start }, path }) =>
                              Message.SelectedDiffLines({ end, path, side, start }),
                          }),
                        );
                      },
                    )
                  : Effect.sync(() =>
                      showNote(element, "The diff has no element to draw in.", true),
                    ),
            }),
        });
        Queue.offerUnsafe(queue, Message.CompletedRenderDiff());
      }),
    ),
);
