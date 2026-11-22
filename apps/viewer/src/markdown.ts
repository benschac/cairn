import type {
  AlignType,
  Heading,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  TableRow,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { Array, Match, Option, Predicate, String, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

/** The keys that start a spec section, in the order the format lists them. */
export const sectionKeys = ["Implements", "Files", "Depends on", "Defers", "Context"] as const;

const headingIdPattern = /\s*\{#([^\s{}]+)\}\s*$/u;

/** "Key: " with nothing after it but whitespace; the IDs follow as inline code. */
const keyLinePattern = /^([^:]*): \s*$/u;

const safeHref = /^(?:https?:|mailto:|[#/.?]|[^:]*$)/iu;

type Rendered = ReadonlyArray<Html | string>;

/** The text of a node and everything under it. */
const textOf = (node: Nodes): string => {
  if ("value" in node) {
    return node.value;
  } else if ("children" in node) {
    return Array.join(Array.map(node.children, textOf), "");
  } else {
    return "";
  }
};

const firstGroup = (pattern: RegExp) => (text: string) =>
  Option.flatMap(String.match(pattern)(text), (match) => Array.get(match, 1));

type KeyRow = { readonly key: string; readonly ids: ReadonlyArray<string> };

const keyOf = (text: string): Option.Option<string> =>
  Option.filter(firstGroup(keyLinePattern)(text), (key) => Array.contains(sectionKeys, key));

/** An inline code ID, or a comma between IDs; anything else means the line is not a key row. */
const idsOf = Match.type<PhrasingContent>().pipe(
  Match.withReturnType<Option.Option<ReadonlyArray<string>>>(),
  Match.when({ type: "inlineCode" }, (part) => Option.some([part.value])),
  Match.when({ type: "text", value: (value: string) => String.trim(value) === "," }, () =>
    Option.some([]),
  ),
  Match.orElse(() => Option.none()),
);

/** Reads "- Key: `id`, `id`" as a key and its IDs. */
const keyRowOf = (item: ListItem): Option.Option<KeyRow> => {
  const [paragraph, ...more] = item.children;
  if (paragraph?.type !== "paragraph" || Array.isReadonlyArrayNonEmpty(more)) {
    return Option.none();
  }
  const [head, ...rest] = paragraph.children;
  if (head?.type !== "text") {
    return Option.none();
  }
  return Option.all({
    ids: Option.map(Option.all(Array.map(rest, idsOf)), Array.flatten),
    key: keyOf(head.value),
  });
};

const keyRowsOf = (node: RootContent): Option.Option<ReadonlyArray<KeyRow>> =>
  node.type === "list" && node.ordered !== true
    ? Option.all(Array.map(node.children, keyRowOf))
    : Option.none();

const checkbox = (checked: boolean | null | undefined): ReadonlyArray<string> =>
  Predicate.isBoolean(checked) ? [checked ? "[x] " : "[ ] "] : [];

export const renderMarkdown = <Message>(markdown: string, h: HtmlBuilder<Message>): Html => {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const inline = (nodes: ReadonlyArray<PhrasingContent>): Rendered => Array.flatMap(nodes, render);

  const rows = (
    table: ReadonlyArray<TableRow>,
    align: ReadonlyArray<AlignType | undefined>,
  ): ReadonlyArray<Html> =>
    Array.map(table, (row, rowIndex) =>
      h.tr(
        [],
        Array.map(row.children, (cell, column) => {
          const cellAlign = align[column];
          const attributes = Predicate.isNotNullish(cellAlign)
            ? [h.Style({ "text-align": cellAlign })]
            : [];
          return (rowIndex === 0 ? h.th : h.td)(attributes, inline(cell.children));
        }),
      ),
    );

  const heading = (node: Heading): Html => {
    const maybeId = firstGroup(headingIdPattern)(textOf(node));
    const lastIndex = node.children.length - 1;
    const children = Option.isSome(maybeId)
      ? Array.map(node.children, (child, index) =>
          index === lastIndex && child.type === "text"
            ? { ...child, value: child.value.replace(headingIdPattern, "") }
            : child,
        )
      : node.children;
    const tag = Option.getOrElse(
      Array.get([h.h1, h.h2, h.h3, h.h4, h.h5, h.h6], node.depth - 1),
      () => h.h6,
    );
    return tag(
      Option.match(maybeId, {
        onNone: () => [],
        onSome: (id) => [h.Id(id), h.DataAttribute("section", id)],
      }),
      inline(Array.filter(children, (child) => child.type !== "text" || child.value !== "")),
    );
  };

  const languageClass = (lang: string | null | undefined) =>
    pipe(
      Option.fromNullishOr(lang),
      Option.filter(String.isNonEmpty),
      Option.map((language) =>
        h.Class(`language-${Array.headNonEmpty(String.split(language, /\s/u))}`),
      ),
      Array.fromOption,
    );

  const chips = (keyRows: ReadonlyArray<KeyRow>): Html =>
    h.div(
      [h.DataAttribute("keys", "")],
      Array.map(keyRows, ({ key, ids }) =>
        h.div(
          [h.DataAttribute("key-row", key)],
          [
            h.span([h.DataAttribute("key-label", "")], [key]),
            ...Array.map(ids, (id) => h.span([h.DataAttribute("key", key)], [id])),
          ],
        ),
      ),
    );

  const render: (node: Nodes) => Rendered = Match.type<Nodes>().pipe(
    Match.withReturnType<Rendered>(),
    Match.discriminators("type")({
      blockquote: (node) => [h.blockquote([], renderBlocks(node.children))],
      break: () => [h.br([])],
      code: (node) => [h.pre([], [h.code(languageClass(node.lang), [node.value])])],
      delete: (node) => [h.del([], inline(node.children))],
      emphasis: (node) => [h.em([], inline(node.children))],
      heading: (node) => [heading(node)],
      image: (node) => [node.alt ?? ""],
      inlineCode: (node) => [h.code([], [node.value])],
      link: (node) => [
        h.a(safeHref.test(node.url) ? [h.Href(node.url)] : [], inline(node.children)),
      ],
      list: (node) => [(node.ordered === true ? h.ol : h.ul)([], renderBlocks(node.children))],
      listItem: (node) => [h.li([], [...checkbox(node.checked), ...renderBlocks(node.children)])],
      paragraph: (node) => [h.p([], inline(node.children))],
      root: (node) => renderBlocks(node.children),
      strong: (node) => [h.strong([], inline(node.children))],
      table: (node) => [
        h.table(
          [],
          Array.matchLeft(rows(node.children, node.align ?? []), {
            onEmpty: () => [h.thead([]), h.tbody([])],
            onNonEmpty: (head, body) => [h.thead([], [head]), h.tbody([], body)],
          }),
        ),
      ],
      text: (node) => [node.value],
      thematicBreak: () => [h.hr([])],
    }),
    // Raw HTML, including comments, never reaches the page: those nodes render nothing.
    Match.orElse(() => []),
  );

  const renderBlocks = (nodes: ReadonlyArray<RootContent>): Rendered =>
    Array.flatMap(nodes, (node, index) => {
      const followsHeading = Option.exists(
        Array.get(nodes, index - 1),
        (previous) => previous.type === "heading",
      );
      return Option.match(followsHeading ? keyRowsOf(node) : Option.none(), {
        onNone: () => render(node),
        onSome: (keyRows) => [chips(keyRows)],
      });
    });

  return h.div([h.Class("markdown")], renderBlocks(tree.children));
};
