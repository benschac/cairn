import { UiSchema } from "@effect/ui";
import { Option, Schema } from "effect";

/**
 * An address in the page, as the viewer reads one: its path, and its search and fragment with
 * their `?` and `#` (empty when it has none). Only the path is a link; the rest goes with it
 * when the page is sent to the address.
 */
export const Url = Schema.Struct({
  hash: Schema.String,
  pathname: Schema.String,
  search: Schema.String,
});
export type Url = typeof Url.Type;

/** An absolute address as a `Url`; none for a string that is not one. */
export const urlFromString = (href: string): Option.Option<Url> =>
  Option.map(Option.liftThrowable((value: string) => new URL(value))(href), (url) => ({
    hash: url.hash,
    pathname: url.pathname,
    search: url.search,
  }));

/** A `Url` as a path the browser goes to on this page's origin. */
export const hrefOfUrl = (url: Url): string => `${url.pathname}${url.search}${url.hash}`;

/** What a click on an anchor asks for: an address on this page's origin, or one elsewhere. */
export const UrlRequest = UiSchema.TaggedEnum({
  External: { href: Schema.String },
  Internal: { url: Url },
});
export type UrlRequest = typeof UrlRequest.Type;
