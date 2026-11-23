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
  Number,
  Option,
  Predicate,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { codeBlockView } from "./code.ts";
import { segmentsOf, type Range } from "./range.ts";

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

/** The offsets a node spans in the markdown source. */
interface Span {
  readonly end: number;
  readonly start: number;
}

const spanOf = (node: Nodes): Option.Option<Span> =>
  Option.flatMap(Option.fromNullishOr(node.position), (position) =>
    Option.all({
      end: Option.fromNullishOr(position.end.offset),
      start: Option.fromNullishOr(position.start.offset),
    }),
  );

/** A heading's children without its trailing `{#id}` and the text it leaves empty, and the id. */
const headingPartsOf = (
  node: Heading,
): {
  readonly children: ReadonlyArray<PhrasingContent>;
  readonly maybeId: Option.Option<string>;
} => {
  const maybeId = firstGroup(HEADING_ID_PATTERN)(textOf(node));
  const stripped = Option.isSome(maybeId)
    ? Array.match(node.children, {
        onEmpty: () => node.children,
        onNonEmpty: Array.modifyLastNonEmpty(stripId),
      })
    : node.children;
  return {
    children: Array.filter(stripped, (child) => child.type !== "text" || child.value !== ""),
    maybeId,
  };
};

// SEARCHABLE PROSE

/** What a block of prose is: a section heading's title, a paragraph or a table cell. */
export type BlockKind = "cell" | "heading" | "paragraph";

/**
 * Where one piece of a block's visible text came from: a text node, inline code or an image's
 * alt text. `start` and `end` are offsets in the block's text; `sourceStart` and `sourceEnd` are
 * the node's offsets in the markdown, so a range of the text maps back to the source.
 */
export interface ProseLeaf {
  readonly end: number;
  readonly sourceEnd: number;
  readonly sourceStart: number;
  readonly start: number;
}

/**
 * A heading, paragraph or table cell of a section as a reader sees it: the text of its inline
 * nodes joined, with an offset map from that text to the nodes that show it. Emphasis, links and
 * inline code are transparent, so a match can run across them; link destinations, raw HTML and
 * code fences are not text of the block.
 */
export interface ProseBlock {
  readonly key: string;
  readonly kind: BlockKind;
  readonly leaves: ReadonlyArray<ProseLeaf>;
  /** The section whose heading is the nearest before this block. */
  readonly owner: SectionId;
  /** The block's own node in the markdown source. */
  readonly source: Span;
  readonly text: string;
}

interface RawLeaf {
  readonly maybeSource: Option.Option<Span>;
  readonly text: string;
}

const leafOf = (node: Nodes, text: string): ReadonlyArray<RawLeaf> => [
  { maybeSource: spanOf(node), text },
];

/** The text leaves of some inline nodes in reading order; a line break reads as a space. */
const leavesOf = (nodes: ReadonlyArray<PhrasingContent>): ReadonlyArray<RawLeaf> =>
  Array.flatMap(nodes, (node) =>
    Match.value(node).pipe(
      Match.withReturnType<ReadonlyArray<RawLeaf>>(),
      Match.discriminators("type")({
        break: () => [{ maybeSource: Option.none(), text: " " }],
        delete: (child) => leavesOf(child.children),
        emphasis: (child) => leavesOf(child.children),
        image: (child) =>
          leafOf(
            child,
            Option.getOrElse(Option.fromNullishOr(child.alt), () => ""),
          ),
        inlineCode: (child) => leafOf(child, child.value),
        link: (child) => leavesOf(child.children),
        strong: (child) => leavesOf(child.children),
        text: (child) => leafOf(child, child.value),
      }),
      Match.orElse(() => []),
    ),
  );

const blockOf = (
  kind: BlockKind,
  owner: SectionId,
  node: Nodes,
  children: ReadonlyArray<PhrasingContent>,
  keyFor: (source: Span) => string,
): Option.Option<ProseBlock> => {
  const [, placed] = Array.mapAccum(leavesOf(children), 0, (offset, leaf) => [
    offset + String.length(leaf.text),
    { ...leaf, end: offset + String.length(leaf.text), start: offset },
  ]);
  return Option.filter(
    Option.map(spanOf(node), (source) => ({
      key: keyFor(source),
      kind,
      leaves: Array.getSomes(
        Array.map(placed, (leaf) =>
          Option.map(leaf.maybeSource, (from) => ({
            end: leaf.end,
            sourceEnd: from.end,
            sourceStart: from.start,
            start: leaf.start,
          })),
        ),
      ),
      owner,
      source,
      text: Array.join(
        Array.map(placed, (leaf) => leaf.text),
        "",
      ),
    })),
    (block) => String.isNonEmpty(block.text),
  );
};

/** The paragraphs and table cells under a node, which can be a list or a quote around them. */
const proseIn = (owner: SectionId, node: RootContent): ReadonlyArray<ProseBlock> =>
  Match.value(node).pipe(
    Match.withReturnType<ReadonlyArray<ProseBlock>>(),
    Match.discriminators("type")({
      blockquote: (child) => Array.flatMap(child.children, (inner) => proseIn(owner, inner)),
      list: (child) => Array.flatMap(child.children, (inner) => proseIn(owner, inner)),
      listItem: (child) => Array.flatMap(child.children, (inner) => proseIn(owner, inner)),
      paragraph: (child) =>
        Array.fromOption(
          blockOf("paragraph", owner, child, child.children, (span) => `${owner}@${span.start}`),
        ),
      table: (child) =>
        Array.flatMap(child.children, (row) =>
          Array.flatMap(row.children, (cell) =>
            Array.fromOption(
              blockOf("cell", owner, cell, cell.children, (span) => `${owner}@${span.start}`),
            ),
          ),
        ),
    }),
    Match.orElse(() => []),
  );

interface Gathered {
  readonly blocks: ReadonlyArray<ProseBlock>;
  readonly headings: ReadonlyArray<ProseBlock>;
  readonly maybeOwner: Option.Option<SectionId>;
}

/**
 * Walks the document once. A heading with a section id owns everything up to the next heading of
 * any level, so a nested section owns its own text and its parent does not repeat it. The key
 * list under a heading renders as chips, not prose, and text before the first heading, or under
 * a heading without a section id, belongs to no section.
 */
const gather = (tree: Root): Gathered =>
  Array.reduce(
    tree.children,
    { blocks: [], headings: [], maybeOwner: Option.none() } satisfies Gathered as Gathered,
    (gathered, node, index) => {
      if (node.type === "heading") {
        const { children, maybeId } = headingPartsOf(node);
        const maybeOwner = Option.filter(maybeId, isSectionId);
        return {
          blocks: gathered.blocks,
          headings: Array.appendAll(
            gathered.headings,
            Array.flatMap(Array.fromOption(maybeOwner), (owner) =>
              Array.fromOption(blockOf("heading", owner, node, children, () => `heading:${owner}`)),
            ),
          ),
          maybeOwner,
        };
      }
      const isKeyList =
        Option.exists(
          Array.get(tree.children, index - 1),
          (previous) => previous.type === "heading",
        ) && Option.isSome(keyRowsOf(node));
      return isKeyList
        ? gathered
        : {
            blocks: Array.appendAll(
              gathered.blocks,
              Option.match(gathered.maybeOwner, {
                onNone: () => [],
                onSome: (owner) => proseIn(owner, node),
              }),
            ),
            headings: gathered.headings,
            maybeOwner: gathered.maybeOwner,
          };
    },
  );

/**
 * A parsed document and what search reads from it, kept together so indexing and rendering share
 * one parse: the syntax tree, the title of each section and each section's prose in source order.
 */
export interface ProseDocument {
  /** Every block by the offset its node starts at, which is how the renderer finds the block of a node. */
  readonly byStart: Record.ReadonlyRecord<string, ProseBlock>;
  /** The title block of each section heading, by section id. */
  readonly headings: Record.ReadonlyRecord<string, ProseBlock>;
  readonly markdown: string;
  /** The paragraph and table cell blocks of each section, by section id, in source order. */
  readonly proseOf: Record.ReadonlyRecord<string, ReadonlyArray<ProseBlock>>;
  readonly tree: Root;
}

const proseDocumentOf = (markdown: string, tree: Root): ProseDocument => {
  const { blocks, headings } = gather(tree);
  return {
    byStart: Record.fromIterableWith(Array.appendAll(headings, blocks), (block) => [
      `${block.source.start}`,
      block,
    ]),
    headings: Record.fromIterableWith(headings, (block) => [block.owner, block]),
    markdown,
    proseOf: Array.groupBy(blocks, (block) => block.owner),
    tree,
  };
};

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
  /**
   * The ranges of a block's visible text to mark, by the block's key (see `ProseBlock`); none for
   * a block nothing matched.
   */
  readonly marksOf?: (blockKey: string) => ReadonlyArray<Range>;
  /** What a marked stretch of text renders as. */
  readonly markView?: (text: string) => Html;
}

/** What every renderer below reads: the builder, the caller's section hooks and the parse. */
interface RenderContext<Message> {
  readonly h: HtmlBuilder<Message>;
  readonly attributesOf: (sectionId: SectionId) => ReadonlyArray<Attribute<Message>>;
  readonly decorate: (sectionId: SectionId) => ReadonlyArray<Html>;
  readonly wrapTitle: (sectionId: SectionId, title: Rendered) => Rendered;
  readonly headingOffset: number;
  readonly diagramView: (source: string, key: string) => Html;
  readonly document: ProseDocument;
  /** The block being rendered, with the ranges of its text to mark; none outside a marked block. */
  readonly maybeMarking: Option.Option<Marking>;
  readonly marksOf: (blockKey: string) => ReadonlyArray<Range>;
  readonly markView: (text: string) => Html;
}

interface Marking {
  readonly block: ProseBlock;
  readonly ranges: ReadonlyArray<Range>;
}

/**
 * The context for rendering a node's inline content: when the node is a searchable block with
 * ranges to mark, its leaves mark them; otherwise nothing is marked.
 */
const blockContextOf = <Message>(
  context: RenderContext<Message>,
  node: Nodes,
): RenderContext<Message> => ({
  ...context,
  maybeMarking: Option.flatMap(
    Option.flatMap(spanOf(node), (span) => Record.get(context.document.byStart, `${span.start}`)),
    (block) =>
      Option.liftPredicate({ block, ranges: context.marksOf(block.key) }, (marking) =>
        Array.isReadonlyArrayNonEmpty(marking.ranges),
      ),
  ),
});

/** The attributes that name a node's block, so its box can be measured. */
const blockAttributes = <Message>(
  context: RenderContext<Message>,
  node: Nodes,
): ReadonlyArray<Attribute<Message>> =>
  Array.fromOption(
    Option.map(
      Option.flatMap(spanOf(node), (span) => Record.get(context.document.byStart, `${span.start}`)),
      (block) => context.h.DataAttribute("block", block.key),
    ),
  );

/**
 * The text of a leaf node, with the ranges the block marks that fall in it wrapped in the caller's
 * mark. The leaf's offset in the block's text comes from the block's offset map.
 */
const leafView = <Message>(context: RenderContext<Message>, node: Nodes, value: string): Rendered =>
  Option.match(
    Option.flatMap(
      Option.all({ marking: context.maybeMarking, span: spanOf(node) }),
      ({ marking, span }) =>
        Option.map(
          Array.findFirst(marking.block.leaves, (leaf) => leaf.sourceStart === span.start),
          (leaf) =>
            Array.filterMap(marking.ranges, (range) =>
              range.end > leaf.start && range.start < leaf.end
                ? Result.succeed({
                    end: Number.min(range.end, leaf.end) - leaf.start,
                    start: Number.max(range.start, leaf.start) - leaf.start,
                  })
                : Result.failVoid,
            ),
        ),
    ),
    {
      onNone: () => [value],
      onSome: (ranges) =>
        Array.map(segmentsOf(value, ranges), (segment) =>
          segment.isMatch ? context.markView(segment.text) : segment.text,
        ),
    },
  );

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
        Array.appendAll(
          pipe(
            Array.get(align, column),
            Option.flatMap(Option.fromNullOr),
            Option.map((cellAlign) => context.h.Style({ "text-align": cellAlign })),
            Array.fromOption,
          ),
          blockAttributes(context, cell),
        ),
        renderInline(blockContextOf(context, cell), cell.children),
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
  const { children, maybeId } = headingPartsOf(node);
  const tag = Option.getOrElse(
    Array.get([h.h1, h.h2, h.h3, h.h4, h.h5, h.h6], node.depth - 1 + headingOffset),
    () => h.h6,
  );
  const maybeSectionId = Option.filter(maybeId, isSectionId);
  const title = renderInline(blockContextOf(context, node), children);
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
      image: (node) =>
        leafView(
          context,
          node,
          Option.getOrElse(Option.fromNullishOr(node.alt), () => ""),
        ),
      inlineCode: (node) => [h.code([], leafView(context, node, node.value))],
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
      paragraph: (node) => [
        h.p(
          blockAttributes(context, node),
          renderInline(blockContextOf(context, node), node.children),
        ),
      ],
      root: (node) => renderBlocks(context, node.children),
      strong: (node) => [h.strong([], renderInline(context, node.children))],
      table: (node) => [tableView(context, node)],
      text: (node) => leafView(context, node, node.value),
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

/** The documents the cache keeps: the PRD and the spec, with room for a refresh in between. */
const PARSED_LIMIT = 4;

const parsed = MutableRef.make<ReadonlyArray<ProseDocument>>([]);

/**
 * The parsed document of some markdown: its syntax tree and the prose search reads from it.
 * Parsing dominates a render, and a search changes how the documents look on every keystroke
 * without changing what they say, so one parse is kept for as long as its text is one of the last
 * few asked for, and both the index and the renderer read it.
 */
export const documentOf = (markdown: string): ProseDocument =>
  Option.match(
    Array.findFirst(MutableRef.get(parsed), (entry) =>
      String.Equivalence(entry.markdown, markdown),
    ),
    {
      onNone: () => {
        const document = proseDocumentOf(
          markdown,
          fromMarkdown(markdown, {
            extensions: [gfm()],
            mdastExtensions: [gfmFromMarkdown()],
          }),
        );
        MutableRef.update(parsed, (entries) =>
          Array.takeRight(Array.append(entries, document), PARSED_LIMIT),
        );
        return document;
      },
      onSome: (entry) => entry,
    },
  );

/** The syntax tree of some markdown, parsed once while it stays among the last few documents. */
export const treeOf = (markdown: string): Root => documentOf(markdown).tree;

export const renderMarkdown = <Message>(
  markdown: string,
  h: HtmlBuilder<Message>,
  {
    attributesOf = () => [],
    decorate = () => [],
    diagramView = (source, _key) => codeBlockView(h, source, DIAGRAM_LANGUAGE),
    headingOffset = 0,
    markView = (text) => h.mark([], [text]),
    marksOf = () => [],
    wrapTitle = (_sectionId, title) => title,
  }: SectionHooks<Message> = {},
): Html => {
  const document = documentOf(markdown);
  return h.div(
    [h.Class("markdown")],
    renderBlocks(
      {
        attributesOf,
        decorate,
        diagramView,
        document,
        h,
        headingOffset,
        markView,
        marksOf,
        maybeMarking: Option.none(),
        wrapTitle,
      },
      document.tree.children,
    ),
  );
};
