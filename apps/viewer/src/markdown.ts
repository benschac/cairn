import type { Nodes, PhrasingContent, Root, RootContent, TableRow } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Html, HtmlBuilder } from "foldkit/html";

/** The keys that start a spec section, in the order the format lists them. */
export const sectionKeys = ["Implements", "Files", "Depends on", "Defers", "Context"] as const;

const sectionKeySet: ReadonlySet<string> = new Set(sectionKeys);

const headingIdPattern = /\s*\{#([^\s{}]+)\}\s*$/u;

const safeHref = /^(?:https?:|mailto:|[#/.?]|[^:]*$)/iu;

/** The text of a node and everything under it. */
const textOf = (node: Nodes): string =>
  "value" in node ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

type KeyRow = { readonly key: string; readonly ids: ReadonlyArray<string> };

/** Reads "- Key: `id`, `id`" as a key and its IDs, or says it is not one. */
const keyRowOf = (item: Nodes): KeyRow | null => {
  if (item.type !== "listItem" || item.children.length !== 1) return null;
  const [paragraph] = item.children;
  if (paragraph?.type !== "paragraph") return null;
  const [head, ...rest] = paragraph.children;
  if (head?.type !== "text") return null;
  const colon = head.value.indexOf(": ");
  const key = colon < 0 ? "" : head.value.slice(0, colon);
  if (!sectionKeySet.has(key) || head.value.slice(colon + 2).trim() !== "") return null;
  const ids: Array<string> = [];
  for (const part of rest) {
    if (part.type === "inlineCode") ids.push(part.value);
    else if (part.type !== "text" || part.value.trim() !== ",") return null;
  }
  return { key, ids };
};

const keyRowsOf = (node: RootContent | undefined): ReadonlyArray<KeyRow> | null => {
  if (node?.type !== "list" || node.ordered === true) return null;
  const rows = node.children.map(keyRowOf);
  return rows.every((row) => row !== null) ? rows : null;
};

export const renderMarkdown = <Message>(markdown: string, h: HtmlBuilder<Message>): Html => {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  const inline = (nodes: ReadonlyArray<PhrasingContent>): ReadonlyArray<Html | string> =>
    nodes.flatMap((node) => render(node));

  const rows = (
    table: ReadonlyArray<TableRow>,
    align: ReadonlyArray<"center" | "left" | "right" | null | undefined>,
  ): ReadonlyArray<Html> =>
    table.map((row, rowIndex) =>
      h.tr(
        [],
        row.children.map((cell, column) => {
          const cellAlign = align[column];
          const attributes = cellAlign ? [h.Style({ "text-align": cellAlign })] : [];
          return (rowIndex === 0 ? h.th : h.td)(attributes, inline(cell.children));
        }),
      ),
    );

  const heading = (node: Extract<Nodes, { type: "heading" }>): Html => {
    const match = headingIdPattern.exec(textOf(node));
    const id = match?.[1];
    const children = node.children.flatMap((child, index) =>
      id !== undefined && index === node.children.length - 1 && child.type === "text"
        ? [{ ...child, value: child.value.replace(headingIdPattern, "") }]
        : [child],
    );
    const tag = ([h.h1, h.h2, h.h3, h.h4, h.h5, h.h6] as const)[node.depth - 1] ?? h.h6;
    return tag(
      id === undefined ? [] : [h.Id(id), h.DataAttribute("section", id)],
      inline(children.filter((child) => child.type !== "text" || child.value !== "")),
    );
  };

  const chips = (keyRows: ReadonlyArray<KeyRow>): Html =>
    h.div(
      [h.DataAttribute("keys", "")],
      keyRows.map(({ key, ids }) =>
        h.div(
          [h.DataAttribute("key-row", key)],
          [
            h.span([h.DataAttribute("key-label", "")], [key]),
            ...ids.map((id) => h.span([h.DataAttribute("key", key)], [id])),
          ],
        ),
      ),
    );

  // Raw HTML, including comments, never reaches the page: those nodes render nothing.
  const render = (node: Nodes): ReadonlyArray<Html | string> => {
    switch (node.type) {
      case "root":
        return renderBlocks(node.children);
      case "paragraph":
        return [h.p([], inline(node.children))];
      case "heading":
        return [heading(node)];
      case "text":
        return [node.value];
      case "emphasis":
        return [h.em([], inline(node.children))];
      case "strong":
        return [h.strong([], inline(node.children))];
      case "delete":
        return [h.del([], inline(node.children))];
      case "inlineCode":
        return [h.code([], [node.value])];
      case "break":
        return [h.br([])];
      case "code":
        return [
          h.pre(
            [],
            [
              h.code(node.lang ? [h.Class(`language-${node.lang.split(/\s/u)[0] ?? ""}`)] : [], [
                node.value,
              ]),
            ],
          ),
        ];
      case "link":
        return [h.a(safeHref.test(node.url) ? [h.Href(node.url)] : [], inline(node.children))];
      case "image":
        return [node.alt ?? ""];
      case "blockquote":
        return [h.blockquote([], renderBlocks(node.children))];
      case "thematicBreak":
        return [h.hr([])];
      case "list":
        return [(node.ordered === true ? h.ol : h.ul)([], renderBlocks(node.children))];
      case "listItem": {
        const prefix =
          node.checked === undefined || node.checked === null
            ? []
            : [node.checked ? "[x] " : "[ ] "];
        return [h.li([], [...prefix, ...renderBlocks(node.children)])];
      }
      case "table":
        return [
          h.table(
            [],
            (() => {
              const [head, ...body] = rows(node.children, node.align ?? []);
              return [h.thead([], head ? [head] : []), h.tbody([], body)];
            })(),
          ),
        ];
      default:
        return [];
    }
  };

  const renderBlocks = (nodes: ReadonlyArray<RootContent>): ReadonlyArray<Html | string> =>
    nodes.flatMap((node, index) => {
      const keyRows = keyRowsOf(node);
      return keyRows !== null && nodes[index - 1]?.type === "heading"
        ? [chips(keyRows)]
        : render(node);
    });

  return h.div([h.Class("markdown")], renderBlocks(tree.children));
};
