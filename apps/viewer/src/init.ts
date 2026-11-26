import { Array, Option, Result } from "effect";
import type { Update, Url } from "foldkit";

import type { Message } from "./message.ts";
import { PresenceConnection, Screen, TraceData, type Model } from "./model.ts";
import { noticeOf } from "./links.ts";
import { isDemoBuild } from "./load.ts";
import { INITIAL_WIDTHS, Resize } from "./panes.ts";
import { linkRoute } from "./route.ts";
import { NO_SEARCH } from "./search.ts";
import { LoadTrace } from "./update.ts";

/**
 * The viewer as it starts at an address. A link in the address waits for the first trace, which
 * opens it; a path that is not a link opens nothing, under the notice that says why. With no address, as in a test, it starts at `/`.
 */
export const init = (url?: Url.Url): Update.Return<Model, Message> => {
  const opened = Option.match(Option.fromUndefinedOr(url), {
    onNone: () => Result.succeed([]),
    onSome: linkRoute.parse,
  });
  return {
    // Only the demo loads its bundled trace. Under cairn serve the first poll is the first load, so the
    // bundled trace can never arrive after, and replace, a live one.
    commands: isDemoBuild() ? [LoadTrace()] : [],
    model: {
      diffStyle: "unified",
      detail: [],
      isShowingModels: true,
      maybeCopied: Option.none(),
      maybeCopiedLink: Option.none(),
      maybeLinkNotice: Result.match(opened, {
        onFailure: (error) => noticeOf(Result.fail(error)),
        onSuccess: () => Option.none(),
      }),
      maybeSelectedPassage: Option.none(),
      maybePendingLink: Option.filter(Result.getSuccess(opened), Array.isReadonlyArrayNonEmpty),
      maybeHovered: Option.none(),
      maybeMeasuredWires: Option.none(),
      maybeYou: Option.none(),
      participants: [],
      readers: [],
      patches: {},
      sessions: {},
      openedTurns: {},
      fullTurns: {},
      maybeHighlightedTurn: Option.none(),
      presenceConnection: PresenceConnection.Connecting(),
      reader: {
        density: "summary",
        isPrdCondensed: false,
        maybeAtTop: Option.none(),
        maybeFocus: Option.none(),
        maybePassage: Option.none(),
        maybePinned: Option.none(),
        opened: {},
        prdOpened: {},
        unfolded: {},
      },
      resize: Resize.Idle(),
      search: NO_SEARCH,
      screen: Screen.Reader(),
      trace: TraceData.Loading(),
      widths: INITIAL_WIDTHS,
      hasChosenStacksWidth: false,
    },
  };
};
