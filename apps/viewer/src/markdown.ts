import type {
  AlignType,
  Code,
  Heading,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
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
  Record,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { codeBlockView } from "./code.ts";
import { segmentsOf, withinOf, type Range } from "./range.ts";

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

/** What a node shows on the page, and so what a query can match: no markup, HTML or link destination. */
const visibleOf = (node: Nodes): string =>
  Match.value(node).pipe(
    Match.withReturnType<string>(),
    Match.discriminators("type")({
      break: () => " ",
      delete: (parent) => visibleIn(parent.children),
      emphasis: (parent) => visibleIn(parent.children),
      image: (image) => Option.getOrElse(Option.fromNullishOr(image.alt), () => ""),
      inlineCode: (code) => code.value,
      link: (parent) => visibleIn(parent.children),
      strong: (parent) => visibleIn(parent.children),
      text: (text) => text.value,
    }),
    Match.orElse(() => ""),
  );

const visibleIn = (nodes: ReadonlyArray<PhrasingContent>): string =>
  Array.join(Array.map(nodes, visibleOf), "");

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

/** The key rows a list renders as chips: a list right after a heading whose items are all key rows. */
const keyRowsAfterHeading = (
  nodes: ReadonlyArray<RootContent>,
  index: number,
): Option.Option<ReadonlyArray<KeyRow>> =>
  Option.flatMap(
    Option.liftPredicate(index, () =>
      Option.exists(Array.get(nodes, index - 1), (previous) => previous.type === "heading"),
    ),
    () => Option.flatMap(Array.get(nodes, index), keyRowsOf),
  );

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

/** The stretches of text a search matched, to render in a `mark` element. */
export interface Marks {
  /** The ranges in each prose block's visible text, by the block's offset in the markdown. */
  readonly blocks: Record.ReadonlyRecord<string, ReadonlyArray<Range>>;
  /** The ranges in each section title's visible text, by section ID. */
  readonly titles: Record.ReadonlyRecord<string, ReadonlyArray<Range>>;
}

export const NO_MARKS: Marks = { blocks: {}, titles: {} };

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
  /** Matched stretches to wrap, split across the inline elements they cross. */
  readonly marks?: Marks;
  /** What a matched stretch of text renders as. */
  readonly markView?: (text: string) => Html;
  /** Attributes for a prose block that holds marks, given its offset in the markdown. */
  readonly blockAttributesOf?: (offset: number) => ReadonlyArray<Attribute<Message>>;
}

/** What every renderer below reads: the builder and the caller's section hooks. */
interface RenderContext<Message> {
  readonly h: HtmlBuilder<Message>;
  readonly attributesOf: (sectionId: SectionId) => ReadonlyArray<Attribute<Message>>;
  readonly decorate: (sectionId: SectionId) => ReadonlyArray<Html>;
  readonly wrapTitle: (sectionId: SectionId, title: Rendered) => Rendered;
  readonly headingOffset: number;
  readonly diagramView: (source: string, key: string) => Html;
  readonly marks: Marks;
  readonly markView: (text: string) => Html;
  readonly blockAttributesOf: (offset: number) => ReadonlyArray<Attribute<Message>>;
}

/**
 * Where a node starts in its block's visible text, and the block's matched ranges. Without ranges
 * nothing is marked and the offset is never read.
 */
interface At {
  readonly from: number;
  readonly ranges: ReadonlyArray<Range>;
}

const UNMARKED: At = { from: 0, ranges: [] };

/** A text leaf, with the part of the block's ranges that falls in it wrapped in `mark` elements. */
const leafView = <Message>(context: RenderContext<Message>, text: string, at: At): Rendered => {
  const inside = withinOf(at.ranges, at.from, at.from + String.length(text));
  return Array.isReadonlyArrayEmpty(inside)
    ? [text]
    : Array.map(segmentsOf(text, inside), (segment) =>
        segment.isMatch ? context.markView(segment.text) : segment.text,
      );
};

/** Renders inline nodes, each told where it starts so its text leaves find their share of the ranges. */
const renderInline = <Message>(
  context: RenderContext<Message>,
  nodes: ReadonlyArray<PhrasingContent>,
  at: At = UNMARKED,
): Rendered => {
  if (Array.isReadonlyArrayEmpty(at.ranges)) {
    return Array.flatMap(nodes, (node) => render(context, node));
  }
  const [, rendered] = Array.mapAccum(nodes, at.from, (from, node) => [
    from + String.length(visibleOf(node)),
    render(context, node, { from, ranges: at.ranges }),
  ]);
  return Array.flatten(rendered);
};

/** A paragraph's or table cell's offset in its document's markdown, which names it. */
const blockOffsetOf = (node: Paragraph | TableCell): Option.Option<number> =>
  Option.flatMap(Option.fromNullishOr(node.position), (position) =>
    Option.fromNullishOr(position.start.offset),
  );

/** The ranges a search matched in a block, and the attributes that tell the page it holds them. */
const blockMarksOf = <Message>(
  context: RenderContext<Message>,
  node: Paragraph | TableCell,
): { readonly at: At; readonly attributes: ReadonlyArray<Attribute<Message>> } =>
  Option.match(
    Option.flatMap(blockOffsetOf(node), (offset) =>
      Option.map(
        Option.filter(Record.get(context.marks.blocks, `${offset}`), Array.isReadonlyArrayNonEmpty),
        (ranges) => ({ at: { from: 0, ranges }, attributes: context.blockAttributesOf(offset) }),
      ),
    ),
    { onNone: () => ({ at: UNMARKED, attributes: [] }), onSome: (marked) => marked },
  );

const tableRow = <Message>(
  context: RenderContext<Message>,
  cellTag: HtmlBuilder<Message>["th"],
  align: ReadonlyArray<AlignType>,
  row: TableRow,
): Html =>
  context.h.tr(
    [],
    Array.map(row.children, (cell, column) => {
      const block = blockMarksOf(context, cell);
      return cellTag(
        Array.appendAll(
          pipe(
            Array.get(align, column),
            Option.flatMap(Option.fromNullOr),
            Option.map((cellAlign) => context.h.Style({ "text-align": cellAlign })),
            Array.fromOption,
          ),
          block.attributes,
        ),
        renderInline(context, cell.children, block.at),
      );
    }),
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

/** A heading's `{#id}`, and the children of its title once the id is stripped. */
const headingOf = (
  node: Heading,
): {
  readonly children: ReadonlyArray<PhrasingContent>;
  readonly maybeId: Option.Option<string>;
} => {
  const maybeId = firstGroup(HEADING_ID_PATTERN)(textOf(node));
  const children = Option.isSome(maybeId)
    ? Array.match(node.children, {
        onEmpty: () => node.children,
        onNonEmpty: Array.modifyLastNonEmpty(stripId),
      })
    : node.children;
  return {
    children: Array.filter(children, (child) => child.type !== "text" || child.value !== ""),
    maybeId,
  };
};

/** The section a heading starts: its `{#id}` when that is a section ID. */
const sectionOf = (node: Heading): Option.Option<SectionId> =>
  Option.filter(headingOf(node).maybeId, isSectionId);

const headingView = <Message>(context: RenderContext<Message>, node: Heading): Html => {
  const { h, attributesOf, decorate, headingOffset, wrapTitle } = context;
  const { children, maybeId } = headingOf(node);
  const tag = Option.getOrElse(
    Array.get([h.h1, h.h2, h.h3, h.h4, h.h5, h.h6], node.depth - 1 + headingOffset),
    () => h.h6,
  );
  const maybeSectionId = Option.filter(maybeId, isSectionId);
  const title = renderInline(context, children, {
    from: 0,
    ranges: Option.getOrElse(
      Option.flatMap(maybeSectionId, (id) => Record.get(context.marks.titles, id)),
      () => [],
    ),
  });
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

const render = <Message>(
  context: RenderContext<Message>,
  content: Nodes,
  at: At = UNMARKED,
): Rendered => {
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
      delete: (node) => [h.del([], renderInline(context, node.children, at))],
      emphasis: (node) => [h.em([], renderInline(context, node.children, at))],
      heading: (node) => [headingView(context, node)],
      image: (node) =>
        leafView(
          context,
          Option.getOrElse(Option.fromNullishOr(node.alt), () => ""),
          at,
        ),
      inlineCode: (node) => [h.code([], leafView(context, node.value, at))],
      link: (node) => [
        h.a(
          SAFE_HREF_PATTERN.test(node.url) ? [h.Href(node.url)] : [],
          renderInline(context, node.children, at),
        ),
      ],
      list: (node) => [
        (node.ordered === true ? h.ol : h.ul)([], renderBlocks(context, node.children)),
      ],
      listItem: (node) => [
        h.li([], Array.appendAll(checkbox(node.checked), renderBlocks(context, node.children))),
      ],
      paragraph: (node) => {
        const block = blockMarksOf(context, node);
        return [h.p(block.attributes, renderInline(context, node.children, block.at))];
      },
      root: (node) => renderBlocks(context, node.children),
      strong: (node) => [h.strong([], renderInline(context, node.children, at))],
      table: (node) => [tableView(context, node)],
      text: (node) => leafView(context, node.value, at),
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
  Array.flatMap(nodes, (node, index) =>
    Option.match(keyRowsAfterHeading(nodes, index), {
      onNone: () => render(context, node),
      onSome: (keyRows) => [keyRowsView(context.h, keyRows)],
    }),
  );

/** A stretch of prose a query can match inside: a paragraph, a list item's paragraph or a table cell. */
export interface ProseBlock {
  /** Where the block starts in the markdown, which names it within its document. */
  readonly offset: number;
  /** The section whose heading is the nearest before it. */
  readonly owner: SectionId;
  /** Its visible text: the text leaves of its AST in order, which the renderer cuts the same way. */
  readonly text: string;
}

interface OwnedBlock {
  readonly offset: number;
  readonly text: string;
}

const blockOf = (node: Paragraph | TableCell): Option.Option<OwnedBlock> =>
  Option.filter(
    Option.map(blockOffsetOf(node), (offset) => ({ offset, text: visibleIn(node.children) })),
    (block) => String.isNonEmpty(block.text),
  );

/**
 * The blocks in a node: paragraphs and table cells, through lists and quotes. Headings are titles,
 * code, diagrams and HTML are not prose, and key rows render as chips of IDs, so none is a block.
 */
const blocksOf = (node: RootContent): ReadonlyArray<OwnedBlock> =>
  Match.value(node).pipe(
    Match.withReturnType<ReadonlyArray<OwnedBlock>>(),
    Match.discriminators("type")({
      blockquote: (parent) => blocksIn(parent.children),
      list: (parent) => blocksIn(parent.children),
      listItem: (parent) => blocksIn(parent.children),
      paragraph: (paragraph) => Array.fromOption(blockOf(paragraph)),
      table: (table) =>
        Array.flatMap(table.children, (row) =>
          Array.flatMap(row.children, (cell) => Array.fromOption(blockOf(cell))),
        ),
    }),
    Match.orElse(() => []),
  );

const blocksIn = (nodes: ReadonlyArray<RootContent>): ReadonlyArray<OwnedBlock> =>
  Array.flatMap(nodes, (node, index) =>
    Option.isSome(keyRowsAfterHeading(nodes, index)) ? [] : blocksOf(node),
  );

/** What search reads of a document, found in the same pass as its parse. */
export interface MarkdownDocument {
  /** The blocks under each section's heading, by section ID; a nested section's are its own. */
  readonly blocks: Record.ReadonlyRecord<string, ReadonlyArray<ProseBlock>>;
  /** Each section's visible title, by section ID: the heading's text without its `{#id}` or markup. */
  readonly titles: Record.ReadonlyRecord<string, string>;
  readonly tree: Root;
}

/**
 * Walks the top level in order: a heading with a section ID owns every block up to the next heading
 * of any level, and a heading without one owns nothing.
 */
const documentOfTree = (tree: Root): MarkdownDocument => {
  const [, owned] = Array.mapAccum(tree.children, Option.none<SectionId>(), (owner, node, index) =>
    node.type === "heading"
      ? [sectionOf(node), []]
      : [
          owner,
          Option.match(owner, {
            onNone: () => [],
            onSome: (id) =>
              Array.map(
                Option.isSome(keyRowsAfterHeading(tree.children, index)) ? [] : blocksOf(node),
                (block): ProseBlock => ({ ...block, owner: id }),
              ),
          }),
        ],
  );
  return {
    blocks: Array.groupBy(Array.flatten(owned), (block) => block.owner),
    titles: Record.fromIterableWith(
      Array.getSomes(
        Array.map(
          Array.filter(tree.children, (node) => node.type === "heading"),
          (heading) =>
            Option.map(
              sectionOf(heading),
              (id) => [id, visibleIn(headingOf(heading).children)] as const,
            ),
        ),
      ),
      (entry) => entry,
    ),
    tree,
  };
};

interface Parsed {
  readonly document: MarkdownDocument;
  readonly markdown: string;
}

/** How many documents are kept parsed: the PRD and the spec, with room for an edit of each. */
const PARSED_LIMIT = 4;

const parsed = MutableRef.make<ReadonlyArray<Parsed>>([]);

/**
 * A document, parsed once while its text is the same, with the prose and titles search reads taken
 * from the same tree. A render for a new hover, pin or search result and a query over the index
 * both reuse it, so only a change to the document itself parses again.
 */
export const documentOf = (markdown: string): MarkdownDocument =>
  Option.match(
    Array.findFirst(MutableRef.get(parsed), (entry) => entry.markdown === markdown),
    {
      onNone: () => {
        const document = documentOfTree(
          fromMarkdown(markdown, {
            extensions: [gfm()],
            mdastExtensions: [gfmFromMarkdown()],
          }),
        );
        MutableRef.update(parsed, (entries) =>
          Array.takeRight(Array.append(entries, { document, markdown }), PARSED_LIMIT),
        );
        return document;
      },
      onSome: (entry) => entry.document,
    },
  );

/** The tree of a document, parsed once while its text is the same. */
export const treeOf = (markdown: string): Root => documentOf(markdown).tree;

const contextOf = <Message>(
  h: HtmlBuilder<Message>,
  {
    attributesOf = () => [],
    decorate = () => [],
    diagramView = (source, _key) => codeBlockView(h, source, DIAGRAM_LANGUAGE),
    blockAttributesOf = () => [],
    headingOffset = 0,
    marks = NO_MARKS,
    markView = (text) => h.mark([], [text]),
    wrapTitle = (_sectionId, title) => title,
  }: SectionHooks<Message>,
): RenderContext<Message> => ({
  attributesOf,
  blockAttributesOf,
  decorate,
  diagramView,
  h,
  headingOffset,
  marks,
  markView,
  wrapTitle,
});

export const renderMarkdown = <Message>(
  markdown: string,
  h: HtmlBuilder<Message>,
  hooks: SectionHooks<Message> = {},
): Html =>
  h.div([h.Class("markdown")], renderBlocks(contextOf(h, hooks), treeOf(markdown).children));

/**
 * The nodes of a section's own body, from its heading to the next heading of any level, with the
 * heading itself first so a key list right after it is still read as one.
 */
const sectionNodesOf = (
  nodes: ReadonlyArray<RootContent>,
  id: SectionId,
): ReadonlyArray<RootContent> =>
  Option.match(
    Array.findFirstIndex(
      nodes,
      (node) => node.type === "heading" && Option.contains(sectionOf(node), id),
    ),
    {
      onNone: () => [],
      onSome: (start) => {
        const body = Array.drop(nodes, start + 1);
        return Array.take(
          Array.drop(nodes, start),
          1 + Array.length(Array.takeWhile(body, (node) => node.type !== "heading")),
        );
      },
    },
  );

/**
 * One section of an already parsed document, rendered as `renderMarkdown` renders a whole one: its
 * key list as chips, prose, lists, tables, code and diagrams. The heading is not rendered and
 * neither are the section's children, which are sections of their own. The nodes are the
 * document's own, so a block's offset is the one a whole render gives it.
 */
export const renderSection = <Message>(
  document: MarkdownDocument,
  id: SectionId,
  h: HtmlBuilder<Message>,
  hooks: SectionHooks<Message> = {},
): Html =>
  h.div(
    [h.Class("markdown")],
    Array.drop(renderBlocks(contextOf(h, hooks), sectionNodesOf(document.tree.children, id)), 1),
  );
