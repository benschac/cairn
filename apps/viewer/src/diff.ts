import {
  CodeView,
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewOptions,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  Array,
  Effect,
  Equal,
  Function,
  MutableRef,
  Option,
  Predicate,
  Result,
  Schema,
  String,
} from "effect";
import { Mount } from "foldkit";

import { Message } from "./message.ts";
import { DiffStyle } from "./model.ts";

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

/** The diff style a list starts in, and the one an attribute that is missing or unknown means. */
const DEFAULT_DIFF_STYLE: DiffStyle = "unified";

/**
 * What the list is built with. The Highlights backend colours code with the lexers and the light
 * palette the documents' fenced code uses, so Shiki is never loaded; a file's language is the one
 * `@pierre/diffs` infers from its path, and a path with no lexer is plain text with its added and
 * removed lines still marked. `setOptions` replaces the options whole, so every change to the style
 * goes through this and not through a partial.
 */
export const diffOptionsOf = (style: DiffStyle): CodeViewOptions<undefined, undefined> => ({
  diffStyle: style,
  hunkSeparators: "line-info",
  lineDiffType: "word-alt",
  preferredHighlighter: "highlights",
  stickyHeaders: true,
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
});

/** The ID of a file's item in the list, which a scroll names. */
export const itemIdOf = (path: string): string => `diff:${path}`;

/** One `diff` item per file, in the order the patch has them. */
export const itemsOf = (
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<CodeViewItem<undefined>> =>
  Array.map(files, (file) => ({
    fileDiff: file,
    id: itemIdOf(file.name),
    type: "diff" as const,
    version: 0,
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

/** The sentence for whatever the library threw. */
const reasonOf = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : globalThis.String(cause);

/** Scrolls the file's item to the top of the list. A file the patch does not hold scrolls nothing. */
const scrollToFile = (list: CodeView, path: string): void => {
  const id = itemIdOf(path);
  if (Predicate.isNotUndefined(list.getItem(id))) {
    list.scrollTo({ align: "start", id, type: "item" });
  }
};

/** Puts a sentence where the list would be. The text goes in as text, not as markup. */
const showNote = (element: Element, note: string, isAlert: boolean): void => {
  const paragraph = element.ownerDocument.createElement("p");
  paragraph.setAttribute("role", isAlert ? "alert" : "status");
  paragraph.textContent = note;
  element.replaceChildren(paragraph);
};

/**
 * Applies each change the model makes to the element's attributes: a new style goes to the list as
 * options, and a new file is scrolled to. The element's attributes at mount are what the list
 * started with, so only a difference from them is applied. The observer disconnects when the scope
 * closes.
 */
const watchAttributes = (element: Element, list: CodeView) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const shownStyle = MutableRef.make(diffStyleOf(element));
      const shownFile = MutableRef.make(fileOf(element));
      const watcher = new MutationObserver(() => {
        const style = diffStyleOf(element);
        if (style !== MutableRef.get(shownStyle)) {
          MutableRef.set(shownStyle, style);
          list.setOptions(diffOptionsOf(style));
        }
        const maybeFile = fileOf(element);
        if (!Equal.equals(maybeFile, MutableRef.get(shownFile))) {
          MutableRef.set(shownFile, maybeFile);
          Option.match(maybeFile, {
            onNone: Function.constVoid,
            onSome: (path) => scrollToFile(list, path),
          });
        }
      });
      watcher.observe(element, {
        attributeFilter: [DIFF_STYLE_ATTRIBUTE, FILE_ATTRIBUTE],
        attributes: true,
      });
      return watcher;
    }),
    (watcher) => Effect.sync(() => watcher.disconnect()),
  );

/**
 * A list of the files in the element, starting in the style and at the file its attributes name.
 * The list is cleaned up when the scope closes. Anything the library throws while starting is
 * shown in the element as a sentence instead.
 */
const drawFiles = (element: HTMLElement, files: ReadonlyArray<FileDiffMetadata>) =>
  Effect.gen(function* () {
    const list = yield* Effect.acquireRelease(
      Effect.sync(() => new CodeView(diffOptionsOf(diffStyleOf(element)))),
      (started) => Effect.sync(() => started.cleanUp()),
    );
    yield* Effect.try({
      catch: reasonOf,
      try: () => {
        list.setup(element);
        list.setItems(itemsOf(files));
        Option.match(fileOf(element), {
          onNone: Function.constVoid,
          onSome: (path) => scrollToFile(list, path),
        });
      },
    });
    yield* watchAttributes(element, list);
  }).pipe(
    Effect.catch((reason) =>
      Effect.sync(() => showNote(element, `The diff could not be drawn: ${reason}`, true)),
    ),
  );

/**
 * Parses the patch and draws its files into the element with the library's `CodeView`, a
 * virtualized list that owns the DOM inside the element, then watches the element's attributes
 * (see `watchAttributes`). Cleanup calls `cleanUp()` when the element goes. Mount arguments are
 * fixed when the element appears, so the view keys the element by the patch's route path: another
 * patch is another element, and its own list. A patch that does not parse, or has no files, says so
 * in the element.
 */
export const RenderDiff = Mount.define("RenderDiff", {
  args: { text: Schema.String },
  execute: ({ element, text }) =>
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
                ? drawFiles(element, changed)
                : Effect.sync(() => showNote(element, "The diff has no element to draw in.", true)),
          }),
      });
      return Message.CompletedRenderDiff();
    }),
  messages: [Message.CompletedRenderDiff],
});
