import { readFileSync } from "node:fs";

import { SectionId } from "@cairn/contract";
import { View } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import { HtmlScene } from "@effect/ui/html/testing";
import { it } from "@effect/vitest";
import {
  Array,
  Effect,
  Match,
  Number,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schema,
  String,
  pipe,
} from "effect";
import { expect as assert } from "vitest";

import {
  documentOf,
  renderMarkdown,
  renderSection,
  treeOf,
  type SectionHooks,
} from "../src/markdown.ts";
import { data, inside, tag as tagged, withoutAttr } from "./fixtures.ts";

type VNode = View.Element<never>;

/**
 * A builder with no component around it, for rendering markdown to nodes a test reads. Its tags
 * hold no state, so the one a component's view is given serves every render.
 */
const bare: Html.H<never> = await (async () => {
  const held: Array<Html.H<never>> = [];
  await Effect.runPromise(
    HtmlServer.renderToHtml(
      Html.component({ message: Schema.Never, model: Schema.Struct({}), name: "Builder" }).make({
        init: () => ({}),
        update: () => ({}),
        view: (builder) => {
          held.push(builder);
          return builder.span;
        },
      }),
      {},
    ),
  );
  return Option.getOrThrow(Array.head(held));
})();

const asElement = (content: View.Content<never>): VNode =>
  Option.getOrThrow(
    Match.value(View.toNode(content)).pipe(
      Match.withReturnType<Option.Option<VNode>>(),
      Match.tag("Element", (element) => Option.some(element)),
      Match.orElse(() => Option.none()),
    ),
  );

/** Renders with a builder and hands back the node tree. */
const render = (markdown: string, hooks?: SectionHooks<never>): VNode =>
  asElement(renderMarkdown(markdown, bare, hooks));

/** A Scene on a component that shows what `view` builds, with no Model and no Message. */
const shown = (name: string, view: (h: Html.H<never>) => View.Content<never>) =>
  HtmlScene.make(
    Html.component({ message: Schema.Never, model: Schema.Struct({}), name }).make({
      init: () => ({}),
      update: () => ({}),
      view: (builder) => view(builder),
    }),
    {},
  );

const children = (node: VNode): ReadonlyArray<VNode | string> =>
  Array.getSomes(
    Array.map(node.children, (child) =>
      Match.value(child).pipe(
        Match.withReturnType<Option.Option<VNode | string>>(),
        Match.tag("Element", (element) => Option.some(element)),
        Match.tag("Text", ({ text }) => Option.some(text)),
        Match.orElse(() => Option.none()),
      ),
    ),
  );

const walk = (node: VNode | string): ReadonlyArray<VNode> =>
  Predicate.isString(node) ? [] : Array.prepend(Array.flatMap(children(node), walk), node);

const textOf = (node: VNode | string): string =>
  Predicate.isString(node) ? node : Array.join(Array.map(children(node), textOf), "");

const attr = (node: VNode, name: string): unknown =>
  pipe(
    Record.get(node.attrs, name),
    Option.orElse(() => Record.get(node.props, name)),
    Option.getOrUndefined,
  );

const tagOf = (element: VNode) => element.tag;

const tags = (node: VNode) => Array.map(walk(node), tagOf);

/** The first element with a tag, or a thrown error that fails the test. */
const firstTag = (node: VNode, tag: string): VNode =>
  Option.getOrThrow(Array.findFirst(walk(node), (element) => tagOf(element) === tag));

const spec = readFileSync(new URL("../../../.cairn/spec.md", import.meta.url), "utf8");
const prd = readFileSync(new URL("../../../.cairn/prd.md", import.meta.url), "utf8");

const sectionsIn = (source: string) =>
  Array.filterMap(walk(render(source)), (element) => {
    const id = attr(element, "data-section");
    return Predicate.isString(id) ? Result.succeed({ element, id }) : Result.failVoid;
  });

const headingIds = (source: string) =>
  pipe(
    source,
    String.replaceAll(/^```[\s\S]*?^```/gmu, ""),
    String.matchAll(/^#{1,6}[ \t]+.*\{#([^}\s]+)\}[ \t]*$/gmu),
    Array.fromIterable,
    Array.map(Array.get(1)),
    Array.getSomes,
  );

it.prop(
  "a heading's trailing id becomes its element id and data-section, and leaves its text",
  [SectionId],
  ([id]) => {
    const root = render(`## Some title {#${id}}\n\nBody.`);
    const heading = firstTag(root, "h2");
    assert(attr(heading, "id")).toBe(id);
    assert(attr(heading, "data-section")).toBe(id);
    assert(textOf(heading)).toBe("Some title");
  },
);

it("a heading without an id has no data-section", () => {
  const sections = sectionsIn("## Plain title\n\nBody.");
  assert(sections).toEqual([]);
});

it("every heading with an id in the spec and the PRD becomes a data-section element", () => {
  Array.forEach([spec, prd], (source) => {
    assert(Array.map(sectionsIn(source), (section) => section.id)).toEqual(headingIds(source));
    assert(headingIds(source).length).toBeGreaterThan(5);
  });
  Array.forEach(sectionsIn(spec), ({ element, id }) => {
    assert(attr(element, "id")).toBe(id);
    assert(textOf(element)).not.toContain("{#");
  });
});

it("the key list that starts a spec section renders as chips", () => {
  const root = render(
    Array.join(
      [
        "## Title {#spec.a}",
        "",
        "- Implements: `prd.x`, `prd.y`",
        "- Files: `a/b.ts`",
        "",
        "Prose.",
      ],
      "\n",
    ),
  );
  const chips = Array.filter(walk(root), (element) => attr(element, "data-key") !== undefined);
  assert(Array.map(chips, (chip) => [attr(chip, "data-key"), textOf(chip)])).toEqual([
    ["Implements", "prd.x"],
    ["Implements", "prd.y"],
    ["Files", "a/b.ts"],
  ]);
  assert(tags(root)).not.toContain("ul");
});

it("a section's chips in the spec match its key lines", () => {
  const chips = Array.filter(
    walk(render(spec)),
    (element) => attr(element, "data-key") !== undefined,
  );
  assert(chips.length).toBeGreaterThan(20);
});

it("a bullet list that is not a key list stays a list", () => {
  Array.forEach(
    [
      "## T {#spec.a}\n\n- Colour: `red`",
      "## T {#spec.a}\n\n- Implements: some prose",
      "Intro\n\n- Implements: `prd.x`",
    ],
    (source) => {
      const root = render(source);
      assert(tags(root)).toContain("ul");
      assert(
        Array.filter(walk(root), (element) => attr(element, "data-key") !== undefined),
      ).toEqual([]);
    },
  );
});

it("renders the inline and block markdown it supports", () => {
  const root = render(
    Array.join(
      [
        "A *soft* and **hard** line with `code` and [a link](https://example.com).",
        "",
        "> quoted",
        "",
        "---",
        "",
        "1. one",
        "2. two",
        "",
        "- a",
        "- b",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ],
      "\n",
    ),
  );
  const supported = ["p", "em", "strong", "code", "a", "blockquote", "hr", "ol", "ul", "li", "pre"];
  assert(tags(root)).toEqual(assert.arrayContaining(supported));
  assert(attr(firstTag(root, "a"), "href")).toBe("https://example.com");
  assert(textOf(root)).toContain("const x = 1;");
});

it("renders a GFM table with a header row and body rows", () => {
  const root = render(
    Array.join(["| Name | Role |", "| :--- | ---: |", "| Ada | human |", "| Bot | agent |"], "\n"),
  );
  const names = tags(root);
  const count = (tag: string) => Array.countBy(names, (name) => name === tag);
  assert(Array.map(["th", "td", "tr"], count)).toEqual([2, 4, 3]);
  assert(textOf(root)).toBe("NameRoleAdahumanBotagent");
});

it.effect("a table in a Scene is found by what a person reads", () =>
  Effect.gen(function* () {
    const s = yield* shown("Table", (h) =>
      renderMarkdown("## Hi {#spec.hi}\n\n| A |\n| - |\n| cell |", h),
    );
    s.expect(data("section", "spec.hi")).toHaveText("Hi").expect(tagged("td")).toHaveText("cell");
  }),
);

const hostile = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<div onclick="x()">hi</div>',
  "<!-- hidden comment -->",
  "text <b>bold</b> <!-- inline comment --> more",
  '<iframe src="https://evil.example"></iframe>',
];

it.each(hostile)("raw HTML never becomes an element: %s", (source) => {
  Array.forEach([source, `para\n\n${source}\n\nafter`, `- ${source}`], (markdown) => {
    const names = tags(render(markdown));
    Array.forEach(["script", "img", "iframe", "b"], (tag) => {
      assert(names).not.toContain(tag);
    });
    assert(Array.countBy(names, (tag) => tag === "div")).toBe(1);
    assert(textOf(render(markdown))).not.toContain("<");
  });
});

it("HTML comments are dropped, including their text", () => {
  const root = render("Before <!-- secret --> after\n\n<!-- block secret -->\n\nEnd");
  assert(textOf(root)).not.toContain("secret");
  assert(textOf(root)).toContain("Before");
  assert(textOf(root)).toContain("End");
});

it("no element carries innerHTML or an event handler from the markdown", () => {
  Array.forEach(walk(render(`${Array.join(hostile, "\n\n")}\n\n${spec}`)), (element) => {
    assert(element.props["innerHTML"]).toBeUndefined();
    assert(element.handlers).toEqual({});
  });
});

it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"])(
  "a link to %s gets no href",
  (url) => {
    assert(attr(firstTag(render(`[x](${url})`), "a"), "href")).toBeUndefined();
  },
);

it.each(["https://example.com/a", "mailto:a@b.c", "/relative", "#spec.x", "./x.md"])(
  "a link to %s keeps its href",
  (url) => {
    assert(attr(firstTag(render(`[x](${url})`), "a"), "href")).toBe(url);
  },
);

it.prop(
  "a heading renders headingOffset levels deeper, and never deeper than h6",
  {
    depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  },
  ({ depth, offset }) => {
    const root = render(`${String.repeat(depth)("#")} Title {#spec.title}`, {
      headingOffset: offset,
    });
    assert(textOf(firstTag(root, `h${Number.min(depth + offset, 6)}`))).toBe("Title");
  },
);

it('without an offset "# " is an h1', () => {
  assert(tags(render("# Title {#prd.title}"))).toContain("h1");
});

it.effect("wrapTitle wraps a section heading's title, and the decoration stays outside it", () =>
  Effect.gen(function* () {
    let wrapped: ReadonlyArray<string> = [];
    const s = yield* shown("WrapTitle", (h) =>
      renderMarkdown("## Some `code` title {#spec.some}\n\n## Plain", h, {
        decorate: () => [h.span.attr("data-badge", "").children("badge")],
        wrapTitle: (sectionId, title) => {
          wrapped = Array.append(wrapped, sectionId);
          return [h.button.attr("data-title-of", sectionId).children(title)];
        },
      }),
    );
    const section = data("section", "spec.some");
    s.expect(inside(section, tagged("button")))
      .toHaveText("Some code title")
      .expect(inside(inside(section, tagged("button")), data("badge")))
      .toBeAbsent()
      .expect(inside(section, data("badge")))
      .toExist();
    // Only the heading with a section id is wrapped.
    assert(Array.dedupe(wrapped)).toEqual(["spec.some"]);
  }),
);

const classes = (node: VNode): ReadonlyArray<string> =>
  Array.filter(
    String.split(
      Option.getOrElse(Record.get(node.attrs, "class"), () => ""),
      " ",
    ),
    String.isNonEmpty,
  );

/** The declarations of a `style` attribute, written `name: value; name: value`. */
const styleOf = (node: VNode): Readonly<Record<string, string>> =>
  Record.fromEntries(
    Array.filterMap(
      String.split(
        Option.getOrElse(Record.get(node.attrs, "style"), () => ""),
        "; ",
      ),
      (declaration) => {
        const [name, value] = String.split(declaration, ": ");
        return name === undefined || value === undefined
          ? Result.failVoid
          : Result.succeed([name, value] as const);
      },
    ),
  );

/** The elements of a code block's text: a span per token when it is highlighted. */
const tokenSpans = (node: VNode) =>
  Array.filter(
    walk(firstTag(node, "code")),
    (element) => tagOf(element) === "span" && styleOf(element)["color"] !== undefined,
  );

const FENCE = "```";

const fence = (language: string, code: string): string =>
  Array.join([`${FENCE}${language}`, code, FENCE], "\n");

it("a fenced block keeps its language and gets a coloured span per token", () => {
  const root = render(fence("ts", "const x: number = 1;\nexport const y = 'a';"));
  assert(attr(firstTag(root, "pre"), "data-language")).toBe("ts");
  assert(classes(firstTag(root, "code"))).toEqual(["language-ts"]);
  assert(textOf(firstTag(root, "code"))).toBe("const x: number = 1;\nexport const y = 'a';");
  const colors = Array.dedupe(Array.map(tokenSpans(root), (span) => styleOf(span)["color"]));
  assert(tokenSpans(root).length).toBeGreaterThan(6);
  assert(colors.length).toBeGreaterThan(2);
});

it("a fence's meta after its language is not part of the language", () => {
  const root = render(fence('ts title="a.ts"', "const x = 1;"));
  assert(classes(firstTag(root, "code"))).toEqual(["language-ts"]);
  assert(tokenSpans(root).length).toBeGreaterThan(0);
});

it.each(["nope", ""])("a fence in %j stays plain text", (language) => {
  const root = render(fence(language, "const x = 1;"));
  assert(tokenSpans(root)).toEqual([]);
  assert(textOf(firstTag(root, "code"))).toBe("const x = 1;");
});

it("a fence with no language has no language class", () => {
  assert(classes(firstTag(render(fence("", "plain")), "code"))).toEqual([]);
});

it.prop(
  "highlighting never changes the text of a block or lets it become markup",
  [Schema.String.check(Schema.isPattern(/^(?:[^\p{Cc}]|[\n\t])*$/u))],
  ([source]) => {
    Array.forEach(["ts", "json", "sql", "mermaid"], (language) => {
      const root = render(fence(language, source));
      assert(textOf(firstTag(root, "code"))).toBe(source);
    });
  },
);

it("code that looks like markup stays text in every language", () => {
  const source = "<script>alert(1)</script><img src=x onerror=alert(1)>";
  Array.forEach(["ts", "html", "nope", ""], (language) => {
    const root = render(fence(language, source));
    assert(tags(root)).not.toContain("script");
    assert(tags(root)).not.toContain("img");
    assert(textOf(firstTag(root, "code"))).toBe(source);
  });
});

it("a mermaid fence is a code block of its source until the caller says what a diagram is", () => {
  const root = render(fence("mermaid", "flowchart LR\n  A --> B"));
  assert(tags(root)).toContain("pre");
  assert(textOf(firstTag(root, "code"))).toBe("flowchart LR\n  A --> B");
});

it.effect("a mermaid fence is handed to the caller's diagramView, and no other fence is", () =>
  Effect.gen(function* () {
    let sources: ReadonlyArray<string> = [];
    const s = yield* shown("Diagrams", (h) =>
      renderMarkdown(
        `${fence("mermaid", "flowchart LR\n  A --> B")}\n\n${fence("ts", "const x = 1;")}`,
        h,
        {
          diagramView: (source) => {
            sources = Array.append(sources, source);
            return h.figure.attr("data-diagram", "");
          },
        },
      ),
    );
    s.expect(data("diagram")).toHaveText("").expect(tagged("pre")).toHaveText("const x = 1;");
    // A Scene renders the view once per step.
    assert(Array.dedupe(sources)).toEqual(["flowchart LR\n  A --> B"]);
  }),
);

/** The keys renderMarkdown gives each mermaid fence in `markdown`, in order, from one render. */
const diagramKeys = (markdown: string): ReadonlyArray<string> => {
  let keys: ReadonlyArray<string> = [];
  render(markdown, {
    diagramView: (_source, key) => {
      keys = Array.append(keys, key);
      return bare.div;
    },
  });
  return keys;
};

// A Mount runs once, when its element is inserted, so a diagram's element must be new whenever the
// diagram changes: its key is what makes the element new.
it("a diagram's key changes with its source and its line, and two identical diagrams differ", () => {
  const a = fence("mermaid", "flowchart LR\n  A --> B");
  const b = fence("mermaid", "flowchart LR\n  A --> C");
  const [original] = diagramKeys(a);
  assert(diagramKeys(a)).toEqual([original]);
  assert(diagramKeys(b)).not.toEqual([original]);
  assert(diagramKeys(`# Moved\n\n${a}`)).not.toEqual([original]);
  const twice = diagramKeys(`${a}\n\n${a}`);
  assert(Array.length(Array.dedupe(twice))).toBe(2);
});

it("a document is parsed once while its text is the same", () => {
  const source = "# Title {#spec.title}\n\nText.";
  assert(treeOf(source)).toBe(treeOf(source));
  assert(treeOf(source)).not.toBe(treeOf(`${source} More.`));
  assert(treeOf(source)).toBe(treeOf(source));
});

// MARKS

const lines = (parts: ReadonlyArray<string>): string => Array.join(parts, "\n");

const MARKED_HEADING = "## Zebra {#spec.zebra}\n\n";

/** The offset of the first prose block under a section of `markdown`. */
const firstBlockOf = (markdown: string, id: string) =>
  Option.getOrThrow(Option.flatMap(Record.get(documentOf(markdown).blocks, id), Array.head));

const marksIn = (node: VNode) => Array.filter(walk(node), (element) => tagOf(element) === "mark");

it("a match across bold text and a link is cut at each element and stays inside it", () => {
  const markdown = `${MARKED_HEADING}The zebra has **bold stripes** and [a linked herd](https://example.com/h) that graze.`;
  const block = firstBlockOf(markdown, "spec.zebra");
  assert(block.text).toBe("The zebra has bold stripes and a linked herd that graze.");
  const start = Option.getOrThrow(String.indexOf("stripes")(block.text));
  const end = Option.getOrThrow(String.indexOf(" herd")(block.text));
  const root = render(markdown, {
    marks: { blocks: { [`${block.offset}`]: [{ end, start }] }, titles: {} },
  });
  const paragraph = firstTag(root, "p");
  assert(textOf(paragraph)).toBe(block.text);
  assert(Array.map(marksIn(paragraph), textOf)).toEqual(["stripes", " and ", "a linked"]);
  assert(Array.map(marksIn(firstTag(paragraph, "strong")), textOf)).toEqual(["stripes"]);
  const link = firstTag(paragraph, "a");
  assert(attr(link, "href")).toBe("https://example.com/h");
  assert(Array.map(marksIn(link), textOf)).toEqual(["a linked"]);
  assert(textOf(link)).toBe("a linked herd");
});

it("a section title keeps its inline code and its id while it is marked", () => {
  const root = render("## Use `code` here {#spec.zebra}", {
    marks: { blocks: {}, titles: { "spec.zebra": [{ end: 8, start: 4 }] } },
  });
  const heading = firstTag(root, "h2");
  assert(attr(heading, "id")).toBe("spec.zebra");
  assert(attr(heading, "data-section")).toBe("spec.zebra");
  assert(textOf(heading)).toBe("Use code here");
  assert(Array.map(marksIn(firstTag(heading, "code")), textOf)).toEqual(["code"]);
});

it("a table cell, a list paragraph and Unicode text are marked at the right offsets", () => {
  const markdown = lines([
    "## Zebra {#spec.zebra}",
    "",
    "- 😀 first item",
    "- second 𝒜 item",
    "",
    "| Name | Role |",
    "| ---- | ---- |",
    "| Ada | the **human** |",
  ]);
  const blocks = Option.getOrThrow(Record.get(documentOf(markdown).blocks, "spec.zebra"));
  assert(Array.map(blocks, (block) => block.text)).toEqual([
    "😀 first item",
    "second 𝒜 item",
    "Name",
    "Role",
    "Ada",
    "the human",
  ]);
  // Each block starts where its source does, however many surrogate pairs came before it; a
  // table cell's source starts at its pipe.
  Array.forEach(Array.take(blocks, 2), (block) => {
    assert(String.startsWith(block.text)(String.slice(block.offset)(markdown))).toBe(true);
  });
  Array.forEach(Array.drop(blocks, 2), (block) => {
    assert(String.startsWith("|")(String.slice(block.offset)(markdown))).toBe(true);
  });
  // "first" after an emoji, "item" after a mathematical letter, "human" inside bold text.
  const ranges = [
    ["😀 first item", { end: 8, start: 3 }],
    ["second 𝒜 item", { end: 14, start: 10 }],
    ["the human", { end: 9, start: 4 }],
  ] as const;
  const marks = Record.fromIterableWith(
    Array.filterMap(ranges, ([text, range]) =>
      Option.match(
        Array.findFirst(blocks, (block) => block.text === text),
        {
          onNone: () => Result.failVoid,
          onSome: (block) => Result.succeed([`${block.offset}`, [range]] as const),
        },
      ),
    ),
    (entry) => entry,
  );
  const root = render(markdown, { marks: { blocks: marks, titles: {} } });
  assert(Array.map(marksIn(root), textOf)).toEqual(["first", "item", "human"]);
  assert(Array.map(marksIn(firstTag(root, "strong")), textOf)).toEqual(["human"]);
});

it("escaped markdown and inline code are visible text", () => {
  const markdown = `${MARKED_HEADING}Escaped \\*star\\* and \`code\` &amp; more.`;
  const [block] = Option.getOrThrow(Record.get(documentOf(markdown).blocks, "spec.zebra"));
  assert(block?.text).toBe("Escaped *star* and code & more.");
});

it("comments, code fences, diagram labels, link destinations and key lists are not prose", () => {
  const markdown = lines([
    "## Zebra {#spec.zebra}",
    "",
    "- Implements: `prd.zebra`",
    "- Files: `apps/zebra.ts`",
    "",
    "Visible [label](https://example.com/destination).",
    "",
    "<!-- hidden comment -->",
    "",
    fence("ts", "const secret = 1;"),
    "",
    fence("mermaid", "flowchart LR\n  Diagram --> Label"),
  ]);
  const blocks = Option.getOrThrow(Record.get(documentOf(markdown).blocks, "spec.zebra"));
  assert(Array.map(blocks, (block) => block.text)).toEqual(["Visible label."]);
});

it("nested sections own their text, a heading without an id owns none and the parent has no copy", () => {
  const markdown = lines([
    "## Outer {#spec.outer}",
    "",
    "Outer text.",
    "",
    "### Inner {#spec.inner}",
    "",
    "Inner text.",
    "",
    "### Plain heading",
    "",
    "Orphan text.",
    "",
    "## Next {#spec.next}",
    "",
    "Next text.",
  ]);
  const { blocks, titles } = documentOf(markdown);
  const textsOf = (id: string) =>
    Array.map(
      Option.getOrElse(Record.get(blocks, id), () => []),
      (block) => block.text,
    );
  assert(textsOf("spec.outer")).toEqual(["Outer text."]);
  assert(textsOf("spec.inner")).toEqual(["Inner text."]);
  assert(textsOf("spec.next")).toEqual(["Next text."]);
  assert(Record.keys(blocks)).toEqual(["spec.outer", "spec.inner", "spec.next"]);
  assert(titles).toEqual({ "spec.inner": "Inner", "spec.next": "Next", "spec.outer": "Outer" });
});

it("a marked document keeps its code blocks and diagram keys as they were", () => {
  const markdown = lines([
    "## Zebra {#spec.zebra}",
    "",
    "Marked prose.",
    "",
    fence("ts", "const x = 1;"),
    "",
    fence("mermaid", "flowchart LR\n  A --> B"),
  ]);
  const block = firstBlockOf(markdown, "spec.zebra");
  const keysOf = (hooks: SectionHooks<never>) => {
    let keys: ReadonlyArray<string> = [];
    const root = render(markdown, {
      ...hooks,
      diagramView: (_source, key) => {
        keys = Array.append(keys, key);
        return bare.div;
      },
    });
    return { code: firstTag(root, "pre"), keys, root };
  };
  const plain = keysOf({});
  const marked = keysOf({
    marks: { blocks: { [`${block.offset}`]: [{ end: 6, start: 0 }] }, titles: {} },
  });
  assert(marksIn(marked.root).length).toBe(1);
  assert(marked.keys).toEqual(plain.keys);
  assert(marked.code).toEqual(plain.code);
});

it.effect("only a block that holds marks carries the caller's attributes", () =>
  Effect.gen(function* () {
    const markdown = `${MARKED_HEADING}Marked prose.\n\nPlain prose.`;
    const [marked] = Option.getOrThrow(Record.get(documentOf(markdown).blocks, "spec.zebra"));
    const s = yield* shown("Blocks", (h) =>
      renderMarkdown(markdown, h, {
        blockAttributesOf: (offset) => ({ "data-block": `${offset}` }),
        marks: { blocks: { [`${marked?.offset}`]: [{ end: 6, start: 0 }] }, titles: {} },
      }),
    );
    s.expect(data("block", `${marked?.offset}`))
      .toHaveText("Marked prose.")
      .expect(inside(data("block"), tagged("mark")))
      .toHaveText("Marked")
      .expect(withoutAttr("data-block", tagged("p")))
      .toHaveText("Plain prose.");
  }),
);

it("parsing for search and for rendering is one parse", () => {
  const markdown = "## Title {#spec.title}\n\nText.";
  const document = documentOf(markdown);
  assert(documentOf(markdown)).toBe(document);
  assert(treeOf(markdown)).toBe(document.tree);
  render(markdown);
  assert(documentOf(markdown)).toBe(document);
});

const elementsOf = (root: VNode) =>
  Array.filter(tags(root), (tag) => Predicate.isString(tag) && tag !== "mark");

const Letter = Schema.Literals(["a", "z", "é", "😀", "𝒜"]);
const Word = Schema.NonEmptyArray(Letter);
const Piece = Schema.Struct({
  kind: Schema.Literals(["plain", "strong", "emphasis", "code", "link", "deleted"]),
  word: Word,
});

const sourceOf = (piece: typeof Piece.Type): string => {
  const word = Array.join(piece.word, "");
  return piece.kind === "strong"
    ? `**${word}**`
    : piece.kind === "emphasis"
      ? `*${word}*`
      : piece.kind === "code"
        ? `\`${word}\``
        : piece.kind === "link"
          ? `[${word}](https://example.com/${word})`
          : piece.kind === "deleted"
            ? `~~${word}~~`
            : word;
};

it.prop(
  "marking keeps the visible text and the elements, and marks exactly the ranges",
  {
    cuts: Schema.Array(Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }))),
    pieces: Schema.NonEmptyArray(Piece),
  },
  ({ cuts, pieces }) => {
    const visible = Array.join(
      Array.map(pieces, (piece) => Array.join(piece.word, "")),
      " ",
    );
    const markdown = `${MARKED_HEADING}${Array.join(Array.map(pieces, sourceOf), " ")}`;
    const block = firstBlockOf(markdown, "spec.zebra");
    assert(block.text).toBe(visible);
    // Cut points between code points, in order and apart, paired into ranges.
    const codePoints = Array.fromIterable(visible);
    const [, unitOffsets] = Array.mapAccum(Array.append(codePoints, ""), 0, (offset, codePoint) => [
      offset + codePoint.length,
      offset,
    ]);
    const points = Array.dedupe(
      Array.sort(
        Array.map(cuts, (cut) => Math.floor(cut * codePoints.length)),
        Order.Number,
      ),
    );
    const ranges = Array.getSomes(
      Array.map(Array.chunksOf(points, 2), ([from, to]) =>
        Option.all({
          end: Array.get(unitOffsets, to ?? -1),
          start: Array.get(unitOffsets, from),
        }),
      ),
    );
    const plain = render(markdown);
    const marked = render(markdown, {
      marks: { blocks: { [`${block.offset}`]: ranges }, titles: {} },
    });
    assert(textOf(firstTag(marked, "p"))).toBe(visible);
    assert(Array.join(Array.map(marksIn(marked), textOf), "")).toBe(
      Array.join(
        Array.map(ranges, (range) => String.slice(range.start, range.end)(visible)),
        "",
      ),
    );
    // Without the marks the elements are the same; a marked leaf is only split into more text.
    assert(elementsOf(marked)).toEqual(elementsOf(plain));
  },
);

/** Renders one section of a parsed document, and hands back the node tree. */
const renderOne = (markdown: string, id: string, hooks?: SectionHooks<never>): VNode =>
  asElement(renderSection(documentOf(markdown), SectionId.make(id), bare, hooks));

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

const NESTED = Array.join(
  [
    "# Top {#spec.top}",
    "",
    "Before.",
    "",
    "## Heading text {#spec.own}",
    "",
    "- Implements: `prd.a`, `prd.b`",
    "- Files: `a.ts`",
    "",
    "Own prose.",
    "",
    "| H |",
    "| - |",
    "| own cell |",
    "",
    "### Child {#spec.child}",
    "",
    "Child prose.",
    "",
    "## Next {#spec.next}",
    "",
    "Next prose.",
  ],
  "\n",
);

it("renderSection renders a section's own body without its heading or its child sections", () => {
  const root = renderOne(NESTED, "spec.own");
  const text = textOf(root);
  assert(text).toContain("Own prose.");
  assert(text).toContain("own cell");
  assert(text).not.toContain("Heading text");
  assert(text).not.toContain("Child");
  assert(text).not.toContain("Next");
  assert(text).not.toContain("Before.");
  assert(
    Array.filter(tags(root), (tag) => Predicate.isString(tag) && Array.contains(HEADING_TAGS, tag)),
  ).toEqual([]);
});

it("renderSection renders a section with only a key list as its chips", () => {
  const root = renderOne(
    "## Keys {#spec.keys}\n\n- Implements: `prd.a`, `prd.b`\n- Files: `a.ts`",
    "spec.keys",
  );
  const chips = Array.filter(walk(root), (element) =>
    Predicate.isNotUndefined(attr(element, "data-key")),
  );
  assert(Array.map(chips, textOf)).toEqual(["prd.a", "prd.b", "a.ts"]);
  assert(Array.map(chips, (chip) => attr(chip, "data-key"))).toEqual([
    "Implements",
    "Implements",
    "Files",
  ]);
});

it("renderSection of an unknown section renders nothing", () => {
  assert(textOf(renderOne(NESTED, "spec.missing"))).toBe("");
});

it("renderSection keeps the offsets a whole render gives a block, so marks land where they do there", () => {
  const block = Option.getOrThrow(
    Array.head(Option.getOrThrow(Record.get(documentOf(NESTED).blocks, "spec.own"))),
  );
  const marks = { blocks: { [`${block.offset}`]: [{ end: 3, start: 0 }] }, titles: {} };
  const marked = Array.filter(
    walk(renderOne(NESTED, "spec.own", { marks })),
    (element) => tagOf(element) === "mark",
  );
  assert(Array.map(marked, textOf)).toEqual([String.slice(0, 3)(block.text)]);
});

const RICH = Array.join(
  [
    "## Rich {#spec.rich}",
    "",
    "- Implements: `prd.a`",
    "",
    "Prose.",
    "",
    "- first item",
    "- second item",
    "",
    "| Name | Value |",
    "| ---- | ----- |",
    "| cell | 42 |",
    "",
    fence("ts", "const own = 1;"),
    "",
    fence("mermaid", "flowchart LR\n  Own --> Diagram"),
    "",
    "### Child {#spec.rich.child}",
    "",
    fence("mermaid", "flowchart LR\n  Child --> Diagram"),
    "",
    fence("ts", "const child = 2;"),
  ],
  "\n",
);

it("renderSection renders a section's list, table, highlighted code and diagram, and none of its child's", () => {
  let sources: ReadonlyArray<string> = [];
  const root = renderOne(RICH, "spec.rich", {
    diagramView: (source) => {
      sources = Array.append(sources, source);
      return bare.div;
    },
  });
  const tagList = tags(root);
  assert(tagList).toContain("ul");
  assert(tagList).toContain("table");
  assert(textOf(firstTag(root, "table"))).toContain("cell");
  const code = firstTag(firstTag(root, "pre"), "code");
  assert(classes(code)).toEqual(["language-ts"]);
  assert(textOf(code)).toBe("const own = 1;");
  assert(Array.length(Array.filter(tagList, (tag) => tag === "pre"))).toBe(1);
  assert(Array.dedupe(sources)).toEqual(["flowchart LR\n  Own --> Diagram"]);
  assert(textOf(root)).not.toContain("child");
  // Its key list is still chips.
  assert(
    Array.length(Array.filter(walk(root), (element) => attr(element, "data-key") === "Implements")),
  ).toBe(1);
});

it("renderSection of a section whose next node is its child's heading has no body", () => {
  const root = renderOne(
    "## Parent {#spec.parent}\n\n### Child {#spec.child}\n\nChild.",
    "spec.parent",
  );
  assert(textOf(root)).toBe("");
  assert(Array.filter(tags(root), (tag) => tag === "p")).toEqual([]);
});

it("renderSection reads the document renderMarkdown reads, so a section renders from the shared parse", () => {
  const document = documentOf(NESTED);
  assert(documentOf(NESTED)).toBe(document);
  renderOne(NESTED, "spec.own");
  assert(documentOf(NESTED)).toBe(document);
});
