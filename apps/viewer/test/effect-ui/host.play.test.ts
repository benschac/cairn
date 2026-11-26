import { PrdSectionId } from "@cairn/contract";
import { HtmlPlay } from "@effect/ui/html/testing";
import { Locator, TestHost } from "@effect/ui/testing";
import { assert, it } from "@effect/vitest";
import { Array, Effect, MutableRef, Option, Result } from "effect";
import { Url } from "foldkit";
import { vi } from "vitest";

import { Viewer } from "../../src/app.ts";
import { demoTrace } from "../../src/demo.ts";
import { Message } from "../../src/message.ts";

// The viewer as it ships: one Effect UI component on `TestHost`, whose Commands run. Mounts do
// not run on `TestHost`, and the subscriptions hear no page, so the trace arrives as the poll
// would send it.

/** The first PRD section with a status line: below the title, and neither deferred, context nor unmapped. */
const firstStatusLine = Option.getOrThrow(
  Array.findFirst(
    demoTrace.prd.sections,
    (section) =>
      section.level > 1 &&
      !Array.some(
        demoTrace.sections,
        ({ id, status }) =>
          id === section.id && Array.contains(["context", "deferred", "unmapped"], status),
      ),
  ),
).id;

const statusLine = (id: string) => Locator.attr("data-status-line", id);
const heading = (id: string) => Locator.attr("data-section", id);
const copyLink = (id: string) =>
  Locator.inside(
    Locator.attr("data-prd-sec", id),
    Locator.attr("data-copy-link", `/section/${id}`),
  );

const goal = PrdSectionId.make("prd.goal");
const pinned = PrdSectionId.make("prd.viewer.reader");
const linked = PrdSectionId.make("prd.viewer.panes");

/**
 * The page the Commands write to: the history entries `PushUrl` and `ReplaceUrl` write, in order,
 * a clipboard that takes every copy, animation frames, and a document with no elements.
 */
const stubPage = Effect.sync(() => {
  const written = MutableRef.make<ReadonlyArray<string>>([]);
  const write = (_state: unknown, _title: string, path: string) =>
    MutableRef.update(written, Array.append(path));
  vi.stubGlobal("window", { history: { pushState: write, replaceState: write } });
  vi.stubGlobal("location", { origin: "http://localhost:4310" });
  vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() } });
  // Foldkit's DOM Commands wait for a frame before they touch the page; here the frame is now.
  vi.stubGlobal("requestAnimationFrame", (frame: (time: number) => void) => {
    frame(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // Foldkit's focus and scroll Commands look for their element in the page, which has none: each
  // finds nothing and ends with its Message.
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal(
    "HTMLElement",
    class HTMLElement {
      readonly isConnected = false;
    },
  );
  return written;
});

it.effect(
  "the viewer on Effect UI reads the demo trace, pins a status line, opens a changed address and copies a link",
  () =>
    Effect.gen(function* () {
      const written = yield* stubPage;
      const play = yield* HtmlPlay.make(Viewer, { maybeUrl: Option.none() });
      play.root.send(Message.SettledLoadTrace({ result: Result.succeed(demoTrace) }));

      yield* play.expect(Locator.attr("data-prd-title")).toHaveText("Cairn MVP");
      yield* play.expect(statusLine(firstStatusLine)).toHaveAttribute("aria-pressed", "false");

      // CopyLink runs through `$.run`, and its CompletedCopyLink comes back.
      yield* play.expect(copyLink(goal)).toHaveText("Copy link");
      yield* play.click(copyLink(goal));
      yield* play.expect(copyLink(goal)).toHaveText("copied");

      // A pin is a history entry: `PushUrl` runs and writes the pinned section's path.
      yield* play.click(statusLine(pinned));
      yield* play.expect(statusLine(pinned)).toHaveAttribute("aria-pressed", "true");
      yield* play.expect(heading(pinned)).toHaveAttribute("data-current", "");
      assert.deepStrictEqual(MutableRef.get(written), [`/section/${pinned}`]);

      // Back or Forward to a section's address opens it, and writes nothing.
      play.root.send(
        Message.ChangedUrl({
          url: Option.getOrThrow(Url.fromString(`http://localhost:4310/section/${linked}`)),
        }),
      );
      yield* play.expect(statusLine(linked)).toHaveAttribute("aria-pressed", "true");
      yield* play.expect(statusLine(pinned)).toHaveAttribute("aria-pressed", "false");
      assert.deepStrictEqual(MutableRef.get(written), [`/section/${pinned}`]);
    }).pipe(Effect.scoped, Effect.provide(TestHost.layer())),
);
