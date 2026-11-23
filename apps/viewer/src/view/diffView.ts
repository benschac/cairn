import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { DIFF_STYLE_ATTRIBUTE, FILE_ATTRIBUTE, RenderDiff } from "../diff.ts";
import { isDemoBuild } from "../load.ts";
import type { Message } from "../message.ts";
import { PatchData, type DiffStyle } from "../model.ts";

/** The words on each of the diff style toggle's buttons, in the order they are shown. */
const DIFF_STYLE_LABEL = { unified: "Unified", split: "Split" } satisfies Record.ReadonlyRecord<
  DiffStyle,
  string
>;

/**
 * The diff style toggle for the top bar: a group of two buttons, one pressed. Each button says
 * for itself whether it is the style in use, so the group reads the same to a screen reader as it
 * looks.
 */
export const diffStyleToggleView = (
  current: DiffStyle,
  onSelect: (style: DiffStyle) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Role("group"), h.AriaLabel("Diff style"), h.DataAttribute("diff-style-toggle", "")],
    Array.map(Record.toEntries(DIFF_STYLE_LABEL), ([style, label]) =>
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("diff-style-option", style),
          h.AriaPressed(String(style === current)),
          h.OnClick(onSelect(style)),
        ],
        [label],
      ),
    ),
  );

/** A sentence in the pane, with the room the diff itself does not need; a failure is an alert. */
const noteView = (note: string, isAlert: boolean, h: HtmlBuilder<Message>): Html =>
  h.p(
    Array.appendAll(isAlert ? [h.Role("alert")] : [], [
      h.Style({ margin: "0", padding: "8px 12px" }),
    ]),
    [note],
  );

/** The attribute that carries the tree's selected file to the mount, when there is one. */
const fileAttributes = (
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<ReturnType<HtmlBuilder<Message>["Attribute"]>> =>
  Array.map(Array.fromOption(maybeFile), (file) => h.Attribute(FILE_ATTRIBUTE, file));

/**
 * The list of a loaded patch: an element with nothing in it, which the `RenderDiff` mount fills.
 * It is keyed by the patch's route path, so another task or commit is a new element and a new
 * list, and it scrolls on its own to fill the pane. What the model changes later (the style, the
 * selected file) is written to its attributes, which the mount watches.
 */
const diffListView = (
  path: string,
  text: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    path,
    Array.appendAll(
      [
        h.DataAttribute("patch-path", path),
        h.Attribute(DIFF_STYLE_ATTRIBUTE, diffStyle),
        h.OnMount(RenderDiff({ text })),
        h.Style({ flex: "1", "min-height": "0", "overflow-y": "auto" }),
      ],
      fileAttributes(maybeFile, h),
    ),
  );

/** The patch as it stands: not asked for, loading, failed, or loaded and drawn by the mount. */
export const patchView = (
  patches: Record.ReadonlyRecord<string, PatchData>,
  path: string,
  diffStyle: DiffStyle,
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
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
            Loaded: ({ text }) => diffListView(path, text, diffStyle, maybeFile, h),
            Loading: () => note("Loading the diff."),
          }),
      });
};
