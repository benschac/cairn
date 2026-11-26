import type { LinesStep, Session } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Option, Record } from "effect";

import { styleText } from "../effect-ui/attributes.ts";
import { segmentedView } from "../effect-ui/controls.ts";
import {
  DIFF_STYLE_ATTRIBUTE,
  FILE_ATTRIBUTE,
  LINES_ATTRIBUTE,
  linesTextOf,
  RenderDiff,
  TURN_ATTRIBUTE,
  TURN_FROM_ATTRIBUTE,
} from "../diff.ts";
import { isDemoBuild } from "../load.ts";
import type { Message } from "../message.ts";
import { PatchData, type DiffStyle, type HighlightedTurn } from "../model.ts";

/** The words on each of the diff style control's buttons, in the order they are shown. */
const DIFF_STYLE_OPTIONS: ReadonlyArray<{ readonly value: DiffStyle; readonly label: string }> = [
  { label: "Unified", value: "unified" },
  { label: "Split", value: "split" },
];

/**
 * The diff style control for the top bar: a segmented group of two buttons, one pressed. Each
 * button says for itself whether it is the style in use, so the group reads the same to a screen
 * reader as it looks.
 */
export const diffStyleToggleView = (
  h: Html.H<Message>,
  current: DiffStyle,
  onSelect: (style: DiffStyle) => Message,
) =>
  h.div.attr("data-diff-style-toggle", "").children(
    segmentedView(h, {
      label: "Diff style",
      onSelect,
      options: DIFF_STYLE_OPTIONS,
      selected: current,
    }),
  );

/** A sentence in the pane, with the room the diff itself does not need; a failure is an alert. */
const noteView = (h: Html.H<Message>, note: string, isAlert: boolean) =>
  h.p.attr("role", isAlert ? "alert" : undefined).children(note);

/**
 * What the diff marks its hunks with: the session of the commit shown, once it is read, the
 * turn a person highlighted from either pane, and the lines of the selected file a link names.
 */
export interface DiffMarks {
  readonly maybeLines: Option.Option<typeof LinesStep.Type>;
  readonly maybeSession: Option.Option<Session>;
  readonly maybeTurn: Option.Option<HighlightedTurn>;
}

/** A diff with no session to mark it, such as the one in the detail panel. */
export const NO_MARKS: DiffMarks = {
  maybeLines: Option.none(),
  maybeSession: Option.none(),
  maybeTurn: Option.none(),
};

/**
 * The list of a loaded patch: an element with nothing in it, which the `RenderDiff` mount fills.
 * It is keyed by the patch's route path, and by the session once it is read, so another task or
 * commit, or the session arriving to mark the hunks, is a new element and a new list. It scrolls
 * on its own to fill the pane. What the model changes later (the style, the selected file, the
 * highlighted turn, the lines a link names) is written to its attributes, which the mount watches.
 */
const diffListView = (
  h: Html.H<Message>,
  path: string,
  text: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  marks: DiffMarks,
) =>
  h.div
    .key(
      Option.match(marks.maybeSession, {
        onNone: () => path,
        onSome: (session) => `${path} ${session.id}`,
      }),
    )
    .attrs({
      "data-patch-path": path,
      [DIFF_STYLE_ATTRIBUTE]: diffStyle,
      [FILE_ATTRIBUTE]: Option.getOrUndefined(maybeFile),
      [LINES_ATTRIBUTE]: Option.getOrUndefined(Option.map(marks.maybeLines, linesTextOf)),
      [TURN_ATTRIBUTE]: Option.getOrUndefined(Option.map(marks.maybeTurn, ({ id }) => id)),
      [TURN_FROM_ATTRIBUTE]: Option.getOrUndefined(Option.map(marks.maybeTurn, ({ from }) => from)),
      // The list scrolls inside the pane and fills it.
      style: styleText({ flex: "1", "min-height": "0", "overflow-y": "auto" }),
    })
    .onMount(RenderDiff({ session: marks.maybeSession, text }));

/**
 * The patch as it stands: not asked for, loading, failed, or loaded and drawn by the mount, its
 * hunks marked with the turns of `marks`' session.
 */
export const patchView = (
  h: Html.H<Message>,
  patches: Record.ReadonlyRecord<string, PatchData>,
  path: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  marks: DiffMarks = NO_MARKS,
) => {
  const note = (text: string, isAlert = false) =>
    h.div
      .attrs({ "data-patch-path": path, [FILE_ATTRIBUTE]: Option.getOrUndefined(maybeFile) })
      .children(noteView(h, text, isAlert));
  return isDemoBuild()
    ? note("The diff needs `cairn serve`.")
    : Option.match(Record.get(patches, path), {
        onNone: () => note("Loading the diff."),
        onSome: (data) =>
          PatchData.match(data, {
            Failed: ({ message }) => note(message, true),
            Loaded: ({ text }) => diffListView(h, path, text, diffStyle, maybeFile, marks),
            Loading: () => note("Loading the diff."),
          }),
      });
};
