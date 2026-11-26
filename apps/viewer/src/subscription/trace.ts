import { Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Subscription } from "@effect/ui";

import { isDemoBuild, pollTrace, TRACE_POLL_INTERVAL } from "../load.ts";
import { Message } from "../message.ts";
import { inPage } from "./page.ts";

/**
 * Under `cairn serve` the trace is polled for as long as the page lives. The demo build has no
 * server behind it and loads its trace once, in `LoadTrace`.
 */
export const traceMessages = (isDemo: boolean) =>
  isDemo
    ? Stream.empty
    : pollTrace(TRACE_POLL_INTERVAL).pipe(
        Stream.map((result) => Message.SettledLoadTrace({ result })),
        Stream.provide(FetchHttpClient.layer),
      );

export const traceSubscription = Subscription.make(
  "trace",
  inPage(Stream.suspend(() => traceMessages(isDemoBuild()))),
);
