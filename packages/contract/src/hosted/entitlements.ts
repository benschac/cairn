import { Schema } from "effect";

import { Slug } from "../manifest.ts";

export const Dimension = Schema.Literals(["members", "prds", "privatePrds", "publicPrds"]);
export type Dimension = typeof Dimension.Type;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A plan's limits; `null` is unlimited. */
export const Limits = Schema.Struct({
  guestsPerPrd: Schema.NullOr(Count),
  members: Schema.NullOr(Count),
  privatePrds: Schema.NullOr(Count),
  prds: Schema.NullOr(Count),
  publicPrds: Schema.NullOr(Count),
});
export type Limits = typeof Limits.Type;

/** What a workspace's plan allows, what it uses, and what is over. */
export const Entitlements = Schema.Struct({
  billing: Schema.Literals(["managed", "off"]),
  graceEndsAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  limits: Limits,
  overLimit: Schema.Array(Dimension),
  /** `free`, `team` or `self-hosted`. */
  plan: Slug,
  status: Schema.Literals(["free", "active", "past_due", "canceling", "canceled"]),
  usage: Schema.Record(Dimension, Count),
});
export type Entitlements = typeof Entitlements.Type;
