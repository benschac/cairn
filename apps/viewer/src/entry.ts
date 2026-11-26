import { BrowserHost } from "@effect/ui/html";
import { Effect, Layer, Option } from "effect";

// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/tokens.css";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/base.css";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/components.css";

import { Viewer } from "./app.ts";
import { InPage } from "./subscription/page.ts";
import { urlFromString } from "./url.ts";

const root = Option.getOrThrowWith(
  Option.fromNullOr(document.getElementById("root")),
  () => new Error("The page has no #root to mount the viewer in"),
);

// The viewer mounts for as long as the Layer is built. It owns the address, so it opens at the
// page's URL and needs no Router; its subscriptions listen to this page.
Layer.launch(
  BrowserHost.mount(Viewer, { maybeUrl: urlFromString(window.location.href) }, root).pipe(
    Layer.provide(Layer.succeed(InPage, true)),
  ),
).pipe(Effect.runFork);
