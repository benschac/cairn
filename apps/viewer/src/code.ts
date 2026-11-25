import { codeToTokens, isSupportedLanguage, type ThemedToken } from "@pierre/highlights";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { Array, Option, Record, String, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

/** Shiki's font style flags, which `@pierre/highlights` shares. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const STRIKETHROUGH = 8;

const hasFlag = (flags: number, flag: number): boolean => (flags & flag) === flag;

/** The language a fence names: its first word, as ```ts title="x" names `ts`. */
export const languageOf = (lang: string | null | undefined): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(lang),
    Option.flatMap((language) => Array.head(String.split(String.trim(language), /\s/u))),
    Option.filter(String.isNonEmpty),
  );

const tokenize = Option.liftThrowable(
  (code: string, lang: Parameters<typeof codeToTokens>[1]["lang"]) =>
    codeToTokens(code, { lang, theme: pierreLight }).tokens,
);

/**
 * The code as themed tokens, one array per line. None for a language the highlighter has no lexer
 * for, so the block stays plain. The highlighter is synchronous: it needs no Message and no Model.
 */
export const highlight = (
  code: string,
  language: string,
): Option.Option<ReadonlyArray<ReadonlyArray<ThemedToken>>> =>
  pipe(
    Option.liftPredicate(language, isSupportedLanguage),
    Option.flatMap((lang) => tokenize(code, lang)),
  );

/** The CSS a token carries: its colour, and the font style the theme gives it. */
export const styleOf = (token: ThemedToken): Readonly<Record<string, string>> => {
  const flags = Option.getOrElse(Option.fromNullishOr(token.fontStyle), () => 0);
  const decorations = pipe(
    [
      [UNDERLINE, "underline"],
      [STRIKETHROUGH, "line-through"],
    ] as const,
    Array.filter(([flag]) => hasFlag(flags, flag)),
    Array.map(([, decoration]) => decoration),
  );
  return Record.fromEntries(
    Array.getSomes([
      Option.map(Option.fromNullishOr(token.color), (color) => ["color", color] as const),
      Option.liftPredicate(["font-style", "italic"] as const, () => hasFlag(flags, ITALIC)),
      Option.liftPredicate(["font-weight", "bold"] as const, () => hasFlag(flags, BOLD)),
      Option.liftPredicate(["text-decoration", Array.join(decorations, " ")] as const, () =>
        Array.isReadonlyArrayNonEmpty(decorations),
      ),
    ]),
  );
};

/**
 * The classes of a code block, shared by a highlighted block and a diagram shown as its source.
 * Its colours come from pierre-light, so it is `light-only`.
 */
export const CODE_BLOCK_CLASS = "code-block light-only";

/** The lines of tokens as spans, with a newline between lines. */
const tokensView = <Message>(
  h: HtmlBuilder<Message>,
  lines: ReadonlyArray<ReadonlyArray<ThemedToken>>,
): ReadonlyArray<Html | string> =>
  Array.intersperse(
    Array.map(lines, (line) =>
      h.span(
        [],
        Array.map(line, (token) => h.span([h.Style(styleOf(token))], [token.content])),
      ),
    ),
    "\n",
  );

/**
 * A fenced code block. A language the highlighter knows gets a span per token and the language in
 * `data-language`; any other, or none, renders as plain text. The text only ever reaches the page
 * as text nodes, so the code cannot inject markup. `textView` is what plain text renders as; when
 * it changes the code, such as a redaction marker becoming a chip, the block is plain text.
 */
export const codeBlockView = <Message>(
  h: HtmlBuilder<Message>,
  code: string,
  lang: string | null | undefined,
  textView: (text: string) => ReadonlyArray<Html | string> = (text) => [text],
): Html => {
  const plain = textView(code);
  const isChanged = !(Array.length(plain) === 1 && Option.contains(Array.head(plain), code));
  const maybeLanguage = languageOf(lang);
  const maybeLines = isChanged
    ? Option.none()
    : Option.flatMap(maybeLanguage, (language) => highlight(code, language));
  return h.pre(
    Array.prepend(
      Array.fromOption(
        Option.map(maybeLanguage, (language) => h.DataAttribute("language", language)),
      ),
      h.Class(CODE_BLOCK_CLASS),
    ),
    [
      h.code(
        Array.fromOption(Option.map(maybeLanguage, (language) => h.Class(`language-${language}`))),
        Option.match(maybeLines, {
          onNone: () => plain,
          onSome: (lines) => tokensView(h, lines),
        }),
      ),
    ],
  );
};
