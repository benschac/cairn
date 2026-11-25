import type { Session } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  DIFF_STYLE_ATTRIBUTE,
  FILE_ATTRIBUTE,
  RenderDiff,
  TURN_ATTRIBUTE,
  TURN_FROM_ATTRIBUTE,
} from "../diff.ts";
import { isDemoBuild } from "../load.ts";
import type { Message } from "../message.ts";
import { PatchData, type DiffStyle, type HighlightedTurn } from "../model.ts";
import { segmentedView } from "../ui/controls.ts";

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
  current: DiffStyle,
  onSelect: (style: DiffStyle) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.DataAttribute("diff-style-toggle", "")],
    [
      segmentedView(
        { label: "Diff style", onSelect, options: DIFF_STYLE_OPTIONS, selected: current },
        h,
      ),
    ],
  );

/** A sentence in the pane, with the room the diff itself does not need; a failure is an alert. */
const noteView = (note: string, isAlert: boolean, h: HtmlBuilder<Message>): Html =>
  h.p(isAlert ? [h.Role("alert")] : [], [note]);

/** The attribute that carries the tree's selected file to the mount, when there is one. */
const fileAttributes = (
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<ReturnType<HtmlBuilder<Message>["Attribute"]>> =>
  Array.map(Array.fromOption(maybeFile), (file) => h.Attribute(FILE_ATTRIBUTE, file));

/**
 * What the diff marks its hunks with: the session of the commit shown, once it is read, and the
 * turn a person highlighted from either pane.
 */
export interface DiffMarks {
  readonly maybeSession: Option.Option<Session>;
  readonly maybeTurn: Option.Option<HighlightedTurn>;
}

/** A diff with no session to mark it, such as the one in the detail panel. */
export const NO_MARKS: DiffMarks = { maybeSession: Option.none(), maybeTurn: Option.none() };

/** The attributes that carry the highlighted turn to the mount, when there is one. */
const turnAttributes = (
  maybeTurn: Option.Option<HighlightedTurn>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<ReturnType<HtmlBuilder<Message>["Attribute"]>> =>
  Array.flatMap(Array.fromOption(maybeTurn), ({ from, id }) => [
    h.Attribute(TURN_ATTRIBUTE, id),
    h.Attribute(TURN_FROM_ATTRIBUTE, from),
  ]);

/**
 * The list of a loaded patch: an element with nothing in it, which the `RenderDiff` mount fills.
 * It is keyed by the patch's route path, and by the session once it is read, so another task or
 * commit, or the session arriving to mark the hunks, is a new element and a new list. It scrolls
 * on its own to fill the pane. What the model changes later (the style, the selected file, the
 * highlighted turn) is written to its attributes, which the mount watches.
 */
const diffListView = (
  path: string,
  text: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  marks: DiffMarks,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    Option.match(marks.maybeSession, {
      onNone: () => path,
      onSome: (session) => `${path} ${session.id}`,
    }),
    Array.flatten([
      [
        h.DataAttribute("patch-path", path),
        h.Attribute(DIFF_STYLE_ATTRIBUTE, diffStyle),
        h.OnMount(RenderDiff({ session: marks.maybeSession, text })),
        // The list scrolls inside the pane and fills it.
        h.Style({ flex: "1", "min-height": "0", "overflow-y": "auto" }),
      ],
      fileAttributes(maybeFile, h),
      turnAttributes(marks.maybeTurn, h),
    ]),
  );

/**
 * The patch as it stands: not asked for, loading, failed, or loaded and drawn by the mount, its
 * hunks marked with the turns of `marks`' session.
 */
export const patchView = (
  patches: Record.ReadonlyRecord<string, PatchData>,
  path: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
  marks: DiffMarks = NO_MARKS,
): Html => {
  const note = (text: string, isAlert = false): Html =>
    h.div(Array.prepend(fileAttributes(maybeFile, h), h.DataAttribute("patch-path", path)), [
      noteView(text, isAlert, h),
    ]);
  return isDemoBuild()
    ? note("The diff needs `cairn serve`.")
    : Option.match(Record.get(patches, path), {
        onNone: () => note("Loading the diff."),
        onSome: (data) =>
          PatchData.match(data, {
            Failed: ({ message }) => note(message, true),
            Loaded: ({ text }) => diffListView(path, text, diffStyle, maybeFile, marks, h),
            Loading: () => note("Loading the diff."),
          }),
      });
};
