import type {
  AlignType,
  Code,
  Heading,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableRow,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { SectionId } from "@cairn/contract";
import {
  Array,
  Hash,
  Match,
  MutableRef,
  Option,
  Predicate,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { codeBlockView } from "./code.ts";

/** The keys that start a spec section, in the order the format lists them. */
export const SECTION_KEYS = ["Implements", "Files", "Depends on", "Defers", "Context"] as const;

const HEADING_ID_PATTERN = /\s*\{#([^\s{}]+)\}\s*$/u;

/** "Key: " with nothing after it but whitespace; the IDs follow as inline code. */
const KEY_LINE_PATTERN = /^([^:]*): \s*$/u;

const SAFE_HREF_PATTERN = /^(?:https?:|mailto:|[#/.?]|[^:]*$)/iu;

/** Rendered markdown: elements and bare text. */
export type Rendered = ReadonlyArray<Html | string>;

/** The text of a node and everything under it. */
const textOf = (node: Nodes): string => {
  if (Predicate.hasProperty(node, "value")) {
    return node.value;
  } else if (Predicate.hasProperty(node, "children")) {
    return Array.join(Array.map(node.children, textOf), "");
  } else {
    return "";
  }
};

const firstGroup = (pattern: RegExp) => (text: string) =>
  Option.flatMap(String.match(pattern)(text), (match) => Array.get(match, 1));

type KeyRow = Readonly<{ key: string; ids: ReadonlyArray<string> }>;

const keyOf = (text: string): Option.Option<string> =>
  Option.filter(firstGroup(KEY_LINE_PATTERN)(text), (key) => Array.contains(SECTION_KEYS, key));

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
const keyRowOf = (item: ListItem): Option.Option<KeyRow> =>
  Array.matchLeft(item.children, {
    onEmpty: () => Option.none(),
    onNonEmpty: (paragraph, more) =>
      paragraph.type === "paragraph" && Array.isReadonlyArrayEmpty(more)
        ? Array.matchLeft(paragraph.children, {
            onEmpty: () => Option.none(),
            onNonEmpty: (head, rest) =>
              head.type === "text"
                ? Option.all({
                    ids: Option.map(Option.all(Array.map(rest, idsOf)), Array.flatten),
                    key: keyOf(head.value),
                  })
                : Option.none(),
          })
        : Option.none(),
  });

const keyRowsOf = (node: RootContent): Option.Option<ReadonlyArray<KeyRow>> =>
  node.type === "list" && node.ordered !== true
    ? Option.all(Array.map(node.children, keyRowOf))
    : Option.none();

/** A heading's last text without its trailing `{#id}`. */
const stripId = (child: PhrasingContent): PhrasingContent =>
  child.type === "text"
    ? Struct.evolve(child, { value: String.replace(HEADING_ID_PATTERN, "") })
    : child;

const checkbox = (checked: boolean | null | undefined): ReadonlyArray<string> =>
  Match.value(checked).pipe(
    Match.withReturnType<ReadonlyArray<string>>(),
    Match.when(true, () => ["[x] "]),
    Match.when(false, () => ["[ ] "]),
    Match.orElse(() => []),
  );

const isSectionId = Schema.is(SectionId);

/**
 * A diagram's identity in the page: its source and the line its fence starts on. A diagram that is
 * edited or moves gets a new key, so its placeholder is a new element and its Mount draws it again;
 * two identical diagrams on different lines still get different keys.
 */
const diagramKeyOf = (node: Code): string =>
  `diagram:${Hash.string(node.value) >>> 0}:${Option.getOrElse(
    Option.map(Option.fromNullishOr(node.position), (position) => position.start.line),
    () => 0,
  )}`;

/** The fence language that holds a Mermaid diagram. */
const DIAGRAM_LANGUAGE = "mermaid";

/** What a caller adds to a heading whose `{#id}` is a section ID, how deep headings start, and what a diagram is. */
export interface SectionHooks<Message> {
  /** Attributes for the heading. */
  readonly attributesOf?: (sectionId: SectionId) => ReadonlyArray<Attribute<Message>>;
  /** Nodes at the end of the heading. */
  readonly decorate?: (sectionId: SectionId) => ReadonlyArray<Html>;
  /** What the heading's title renders as, such as a button holding it. */
  readonly wrapTitle?: (sectionId: SectionId, title: Rendered) => Rendered;
  /** Levels added to every heading, so "# " can render below the page's own h1; h6 is the deepest. */
  readonly headingOffset?: number;
  /**
   * What a `mermaid` fence renders as, given its source, such as a placeholder a Mount draws into.
   * Without it a diagram is a code block of its source.
   */
  readonly diagramView?: (source: string, key: string) => Html;
}

/** What every renderer below reads: the builder and the caller's section hooks. */
interface RenderContext<Message> {
  readonly h: HtmlBuilder<Message>;
  readonly attributesOf: (sectionId: SectionId) => ReadonlyArray<Attribute<Message>>;
  readonly decorate: (sectionId: SectionId) => ReadonlyArray<Html>;
  readonly wrapTitle: (sectionId: SectionId, title: Rendered) => Rendered;
  readonly headingOffset: number;
  readonly diagramView: (source: string, key: string) => Html;
}

const renderInline = <Message>(
  context: RenderContext<Message>,
  nodes: ReadonlyArray<PhrasingContent>,
): Rendered => Array.flatMap(nodes, (node) => render(context, node));

const tableRow = <Message>(
  context: RenderContext<Message>,
  cellTag: HtmlBuilder<Message>["th"],
  align: ReadonlyArray<AlignType>,
  row: TableRow,
): Html =>
  context.h.tr(
    [],
    Array.map(row.children, (cell, column) =>
      cellTag(
        pipe(
          Array.get(align, column),
          Option.flatMap(Option.fromNullOr),
          Option.map((cellAlign) => context.h.Style({ "text-align": cellAlign })),
          Array.fromOption,
        ),
        renderInline(context, cell.children),
      ),
    ),
  );

const tableView = <Message>(context: RenderContext<Message>, node: Table): Html => {
  const { h } = context;
  return h.table(
    [],
    Array.matchLeft(node.children, {
      onEmpty: () => [h.thead([]), h.tbody([])],
      onNonEmpty: (head, body) => {
        const align = Option.getOrElse(Option.fromNullishOr(node.align), () => []);
        return [
          h.thead([], [tableRow(context, h.th, align, head)]),
          h.tbody(
            [],
            Array.map(body, (row) => tableRow(context, h.td, align, row)),
          ),
        ];
      },
    }),
  );
};

const headingView = <Message>(context: RenderContext<Message>, node: Heading): Html => {
  const { h, attributesOf, decorate, headingOffset, wrapTitle } = context;
  const maybeId = firstGroup(HEADING_ID_PATTERN)(textOf(node));
  const children = Option.isSome(maybeId)
    ? Array.match(node.children, {
        onEmpty: () => node.children,
        onNonEmpty: Array.modifyLastNonEmpty(stripId),
      })
    : node.children;
  const tag = Option.getOrElse(
    Array.get([h.h1, h.h2, h.h3, h.h4, h.h5, h.h6], node.depth - 1 + headingOffset),
    () => h.h6,
  );
  const maybeSectionId = Option.filter(maybeId, isSectionId);
  const title = renderInline(
    context,
    Array.filter(children, (child) => child.type !== "text" || child.value !== ""),
  );
  return tag(
    Option.match(maybeId, {
      onNone: () => [],
      onSome: (id) =>
        Array.appendAll(
          [h.Id(id), h.DataAttribute("section", id)],
          Option.match(maybeSectionId, { onNone: () => [], onSome: attributesOf }),
        ),
    }),
    Array.appendAll(
      Option.match(maybeSectionId, {
        onNone: () => title,
        onSome: (sectionId) => wrapTitle(sectionId, title),
      }),
      Option.match(maybeSectionId, { onNone: () => [], onSome: decorate }),
    ),
  );
};

const keyRowsView = <Message>(h: HtmlBuilder<Message>, keyRows: ReadonlyArray<KeyRow>): Html =>
  h.div(
    [h.DataAttribute("keys", "")],
    Array.map(keyRows, ({ key, ids }) =>
      h.div(
        [h.DataAttribute("key-row", key)],
        Array.prepend(
          Array.map(ids, (id) => h.span([h.DataAttribute("key", key)], [id])),
          h.span([h.DataAttribute("key-label", "")], [key]),
        ),
      ),
    ),
  );

const render = <Message>(context: RenderContext<Message>, content: Nodes): Rendered => {
  const { h } = context;
  return Match.value(content).pipe(
    Match.withReturnType<Rendered>(),
    Match.discriminators("type")({
      blockquote: (node) => [h.blockquote([], renderBlocks(context, node.children))],
      break: () => [h.br([])],
      code: (node) => [
        node.lang === DIAGRAM_LANGUAGE
          ? context.diagramView(node.value, diagramKeyOf(node))
          : codeBlockView(h, node.value, node.lang),
      ],
      delete: (node) => [h.del([], renderInline(context, node.children))],
      emphasis: (node) => [h.em([], renderInline(context, node.children))],
      heading: (node) => [headingView(context, node)],
      image: (node) => [Option.getOrElse(Option.fromNullishOr(node.alt), () => "")],
      inlineCode: (node) => [h.code([], [node.value])],
      link: (node) => [
        h.a(
          SAFE_HREF_PATTERN.test(node.url) ? [h.Href(node.url)] : [],
          renderInline(context, node.children),
        ),
      ],
      list: (node) => [
        (node.ordered === true ? h.ol : h.ul)([], renderBlocks(context, node.children)),
      ],
      listItem: (node) => [
        h.li([], Array.appendAll(checkbox(node.checked), renderBlocks(context, node.children))),
      ],
      paragraph: (node) => [h.p([], renderInline(context, node.children))],
      root: (node) => renderBlocks(context, node.children),
      strong: (node) => [h.strong([], renderInline(context, node.children))],
      table: (node) => [tableView(context, node)],
      text: (node) => [node.value],
      thematicBreak: () => [h.hr([])],
    }),
    // Raw HTML, including comments, never reaches the page: those nodes render nothing.
    Match.orElse(() => []),
  );
};

const renderBlocks = <Message>(
  context: RenderContext<Message>,
  nodes: ReadonlyArray<RootContent>,
): Rendered =>
  Array.flatMap(nodes, (node, index) => {
    const followsHeading = Option.exists(
      Array.get(nodes, index - 1),
      (previous) => previous.type === "heading",
    );
    return Option.match(followsHeading ? keyRowsOf(node) : Option.none(), {
      onNone: () => render(context, node),
      onSome: (keyRows) => [keyRowsView(context.h, keyRows)],
    });
  });

interface Parsed {
  readonly markdown: string;
  readonly tree: Root;
}

/** How many documents are kept parsed: the PRD and the spec, with room for an edit of each. */
const PARSED_LIMIT = 4;

const parsed = MutableRef.make<ReadonlyArray<Parsed>>([]);

/**
 * The tree of a document, parsed once while its text is the same. A render for a new hover, pin or
 * search result reuses it, so only a change to the document itself parses again.
 */
export const treeOf = (markdown: string): Root =>
  Option.match(
    Array.findFirst(MutableRef.get(parsed), (entry) => entry.markdown === markdown),
    {
      onNone: () => {
        const tree: Root = fromMarkdown(markdown, {
          extensions: [gfm()],
          mdastExtensions: [gfmFromMarkdown()],
        });
        MutableRef.update(parsed, (entries) =>
          Array.takeRight(Array.append(entries, { markdown, tree }), PARSED_LIMIT),
        );
        return tree;
      },
      onSome: (entry) => entry.tree,
    },
  );

export const renderMarkdown = <Message>(
  markdown: string,
  h: HtmlBuilder<Message>,
  {
    attributesOf = () => [],
    decorate = () => [],
    diagramView = (source, _key) => codeBlockView(h, source, DIAGRAM_LANGUAGE),
    headingOffset = 0,
    wrapTitle = (_sectionId, title) => title,
  }: SectionHooks<Message> = {},
): Html => {
  const tree = treeOf(markdown);
  return h.div(
    [h.Class("markdown")],
    renderBlocks(
      { attributesOf, decorate, diagramView, h, headingOffset, wrapTitle },
      tree.children,
    ),
  );
};
