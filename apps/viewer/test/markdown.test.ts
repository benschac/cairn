import { readFileSync } from "node:fs";

import { SectionId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Number, Option, Predicate, Record, Result, Schema, String, pipe } from "effect";
import type { Html } from "foldkit/html";
import { expect, given, scene, selector } from "foldkit/scene";
import { expect as assert } from "vitest";

import { documentOf, renderMarkdown, treeOf, type SectionHooks } from "../src/markdown.ts";
import type { Range } from "../src/range.ts";

type VNode = NonNullable<Html>;

/** Renders through a real Scene, which supplies the `h` builder, and hands back the vnode tree. */
const render = (markdown: string, hooks?: SectionHooks<never>): VNode => {
  let rendered = Option.none<VNode>();
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => {
        const body = renderMarkdown(markdown, h, hooks);
        rendered = Option.fromNullOr(body);
        return { body, title: "markdown" };
      },
    },
    given(null),
  );
  return Option.getOrThrow(rendered);
};

const children = (node: VNode): ReadonlyArray<VNode | string> => node.children ?? [];

const walk = (node: VNode | string): ReadonlyArray<VNode> =>
  Predicate.isString(node) ? [] : Array.prepend(Array.flatMap(children(node), walk), node);

const textOf = (node: VNode | string): string =>
  Predicate.isString(node)
    ? node
    : (node.text ?? Array.join(Array.map(children(node), textOf), ""));

const attr = (node: VNode, name: string): unknown =>
  pipe(
    Option.fromNullishOr(node.data?.attrs?.[name]),
    Option.orElse(() => Option.fromNullishOr(node.data?.props?.[name])),
    Option.getOrUndefined,
  );

const tagOf = (element: VNode) =>
  pipe(
    Option.fromNullishOr(element.sel),
    Option.map((sel) => Array.headNonEmpty(String.split(sel, /[.#]/u))),
    Option.getOrUndefined,
  );

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

it("a table in a Scene is found by what a person reads", () => {
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => ({
        body: renderMarkdown("## Hi {#spec.hi}\n\n| A |\n| - |\n| cell |", h),
        title: "markdown",
      }),
    },
    given(null),
    expect(selector("[data-section='spec.hi']")).toHaveText("Hi"),
    expect(selector("td")).toHaveText("cell"),
  );
});

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
    assert(element.data?.props?.["innerHTML"]).toBeUndefined();
    assert(element.data?.on).toBeUndefined();
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

it("wrapTitle wraps a section heading's title, and the decoration stays outside it", () => {
  let wrapped: ReadonlyArray<string> = [];
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => {
        const body = renderMarkdown("## Some `code` title {#spec.some}\n\n## Plain", h, {
          decorate: () => [h.span([h.DataAttribute("badge", "")], ["badge"])],
          wrapTitle: (sectionId, title) => {
            wrapped = Array.append(wrapped, sectionId);
            return [h.button([h.DataAttribute("title-of", sectionId)], title)];
          },
        });
        return { body, title: "markdown" };
      },
    },
    given(null),
    expect(selector('[data-section="spec.some"] button')).toHaveText("Some code title"),
    expect(selector('[data-section="spec.some"] button [data-badge]')).toBeAbsent(),
    expect(selector('[data-section="spec.some"] [data-badge]')).toExist(),
  );
  // Only the heading with a section id is wrapped.
  assert(Array.dedupe(wrapped)).toEqual(["spec.some"]);
});

const classes = (node: VNode): ReadonlyArray<string> => Record.keys(node.data?.class ?? {});

const styleOf = (node: VNode): Readonly<Record<string, string>> => node.data?.style ?? {};

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

it("a mermaid fence is handed to the caller's diagramView, and no other fence is", () => {
  let sources: ReadonlyArray<string> = [];
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => ({
        body: renderMarkdown(
          `${fence("mermaid", "flowchart LR\n  A --> B")}\n\n${fence("ts", "const x = 1;")}`,
          h,
          {
            diagramView: (source) => {
              sources = Array.append(sources, source);
              return h.figure([h.DataAttribute("diagram", "")]);
            },
          },
        ),
        title: "markdown",
      }),
    },
    given(null),
    expect(selector("[data-diagram]")).toBeEmpty(),
    expect(selector("pre")).toHaveText("const x = 1;"),
  );
  // A Scene renders the view once per step.
  assert(Array.dedupe(sources)).toEqual(["flowchart LR\n  A --> B"]);
});

/** The keys renderMarkdown gives each mermaid fence in `markdown`, in order, from one render. */
const diagramKeys = (markdown: string): ReadonlyArray<string> => {
  let keys: ReadonlyArray<string> = [];
  render(markdown, {
    diagramView: (_source, key) => {
      keys = Array.append(keys, key);
      return null;
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

// SEARCH MARKS

/** Renders with these ranges of one block marked, as the search marks a match. */
const renderMarked = (
  markdown: string,
  marksOf: (blockKey: string) => ReadonlyArray<Range>,
): VNode => {
  let rendered = Option.none<VNode>();
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => {
        const body = renderMarkdown(markdown, h, {
          markView: (text) => h.mark([h.DataAttribute("search-match", "")], [text]),
          marksOf,
        });
        rendered = Option.fromNullOr(body);
        return { body, title: "markdown" };
      },
    },
    given(null),
  );
  return Option.getOrThrow(rendered);
};

const keysOf = (markdown: string): ReadonlyArray<string> =>
  Array.map(Array.flatten(Record.values(documentOf(markdown).proseOf)), (block) => block.key);

const markTexts = (node: VNode): ReadonlyArray<string> =>
  Array.map(
    Array.filter(walk(node), (element) => tagOf(element) === "mark"),
    textOf,
  );

const sample =
  "## S {#spec.s}\n\nSome **bold phrase** with [a link](https://example.com/x) inside.";

it("a block's text has an offset map to the text and inline code nodes that show it", () => {
  const markdown = "## S {#spec.s}\n\nUse `inline code` with **bold** and *more*.";
  const [block] = Option.getOrThrow(Record.get(documentOf(markdown).proseOf, "spec.s"));
  assert(block?.text).toBe("Use inline code with bold and more.");
  assert(
    Array.map(block?.leaves ?? [], (leaf) =>
      pipe(block?.text ?? "", String.slice(leaf.start, leaf.end)),
    ),
  ).toEqual(["Use ", "inline code", " with ", "bold", " and ", "more", "."]);
  // Text nodes map to the source they were read from; inline code to its fence and text.
  assert(
    Array.map(block?.leaves ?? [], (leaf) =>
      pipe(markdown, String.slice(leaf.sourceStart, leaf.sourceEnd)),
    ),
  ).toEqual(["Use ", "`inline code`", " with ", "bold", " and ", "more", "."]);
});

it("marks split across bold text and a link keep the formatting, the link and the text", () => {
  const [key] = keysOf(sample);
  const range = { end: 28, start: 5 };
  const marked = renderMarked(sample, (block) => (block === key ? [range] : []));
  // "bold phrase" in the strong, " with " between them and "a link" inside the anchor.
  assert(markTexts(marked)).toEqual(["bold phrase", " with ", "a link"]);
  assert(markTexts(firstTag(marked, "strong"))).toEqual(["bold phrase"]);
  const anchor = firstTag(marked, "a");
  assert(markTexts(anchor)).toEqual(["a link"]);
  assert(attr(anchor, "href")).toBe("https://example.com/x");
  assert(textOf(firstTag(marked, "p"))).toBe("Some bold phrase with a link inside.");
  // Nothing outside the match is marked, and the heading keeps its id and section.
  assert(attr(firstTag(marked, "h2"), "id")).toBe("spec.s");
  assert(attr(firstTag(marked, "h2"), "data-section")).toBe("spec.s");
  assert(attr(firstTag(marked, "p"), "data-block")).toBe(key);
});

it("a block with no ranges renders as it does with no search at all", () => {
  const plain = render(sample);
  assert(renderMarked(sample, () => [])).toEqual(plain);
  assert(markTexts(plain)).toEqual([]);
});

it("a heading's inline formatting survives a mark on its title", () => {
  const markdown = "## Some `code` title {#spec.some}";
  const key = "heading:spec.some";
  assert(documentOf(markdown).headings["spec.some"]?.key).toBe(key);
  const marked = renderMarked(markdown, (block) => (block === key ? [{ end: 15, start: 5 }] : []));
  assert(textOf(firstTag(marked, "h2"))).toBe("Some code title");
  assert(markTexts(marked)).toEqual(["code", " title"]);
  assert(markTexts(firstTag(marked, "code"))).toEqual(["code"]);
});

it("a table cell is marked inside its cell", () => {
  const markdown = "## T {#spec.t}\n\n| a | b |\n| - | - |\n| one **two** | three |";
  const key = Option.getOrThrow(
    Array.findFirst(keysOf(markdown), (candidate) =>
      Option.exists(
        Array.findFirst(
          Array.flatten(Record.values(documentOf(markdown).proseOf)),
          (block) => block.key === candidate && block.text === "one two",
        ),
        () => true,
      ),
    ),
  );
  const marked = renderMarked(markdown, (block) => (block === key ? [{ end: 7, start: 2 }] : []));
  const cell = Option.getOrThrow(
    Array.findFirst(walk(marked), (element) => attr(element, "data-block") === key),
  );
  assert(tagOf(cell)).toBe("td");
  assert(markTexts(cell)).toEqual(["e ", "two"]);
  assert(textOf(cell)).toBe("one two");
});

it("marking every block of the PRD and spec changes none of their text and marks each block", () => {
  Array.forEach([prd, spec], (source) => {
    const keys = keysOf(source);
    const lengths = Record.fromEntries(
      Array.map(Array.flatten(Record.values(documentOf(source).proseOf)), (block) => [
        block.key,
        String.length(block.text),
      ]),
    );
    const marked = renderMarked(source, (block) =>
      Option.match(Record.get(lengths, block), {
        onNone: () => [],
        onSome: (end) => [{ end, start: 0 }],
      }),
    );
    assert(textOf(marked)).toBe(textOf(render(source)));
    assert(Array.length(markTexts(marked))).toBeGreaterThanOrEqual(Array.length(keys));
    // Every mark is inside a block: a paragraph or a cell.
    assert(
      Array.every(
        Array.filter(walk(marked), (element) => attr(element, "data-block") !== undefined),
        (element) => tagOf(element) === "p" || tagOf(element) === "td" || tagOf(element) === "th",
      ),
    ).toBe(true);
  });
});

it("the syntax tree is the one the document was parsed into, once per text", () => {
  assert(treeOf(sample)).toBe(documentOf(sample).tree);
  assert(documentOf(sample)).toBe(documentOf(sample));
  assert(documentOf(sample)).not.toBe(documentOf(`${sample} more`));
});
