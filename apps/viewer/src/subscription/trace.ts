import { Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { Subscription } from "foldkit";

import { isDemoBuild, pollTrace, TRACE_POLL_INTERVAL } from "../load.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";

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

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  trace: Subscription.persistentEntry(Stream.suspend(() => traceMessages(isDemoBuild()))),
}));
