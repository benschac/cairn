import { readFileSync } from "node:fs";

import { SectionId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Number, Option, Predicate, Result, Schema, String, pipe } from "effect";
import type { Html } from "foldkit/html";
import { expect as expectScene, given, scene, selector } from "foldkit/scene";
import { expect } from "vitest";

import { renderMarkdown, type SectionHooks } from "../src/markdown.ts";

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
    expect(attr(heading, "id")).toBe(id);
    expect(attr(heading, "data-section")).toBe(id);
    expect(textOf(heading)).toBe("Some title");
  },
);

it("a heading without an id has no data-section", () => {
  const sections = sectionsIn("## Plain title\n\nBody.");
  expect(sections).toEqual([]);
});

it("every heading with an id in the spec and the PRD becomes a data-section element", () => {
  Array.forEach([spec, prd], (source) => {
    expect(Array.map(sectionsIn(source), (section) => section.id)).toEqual(headingIds(source));
    expect(headingIds(source).length).toBeGreaterThan(5);
  });
  Array.forEach(sectionsIn(spec), ({ element, id }) => {
    expect(attr(element, "id")).toBe(id);
    expect(textOf(element)).not.toContain("{#");
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
  expect(Array.map(chips, (chip) => [attr(chip, "data-key"), textOf(chip)])).toEqual([
    ["Implements", "prd.x"],
    ["Implements", "prd.y"],
    ["Files", "a/b.ts"],
  ]);
  expect(tags(root)).not.toContain("ul");
});

it("a section's chips in the spec match its key lines", () => {
  const chips = Array.filter(
    walk(render(spec)),
    (element) => attr(element, "data-key") !== undefined,
  );
  expect(chips.length).toBeGreaterThan(20);
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
      expect(tags(root)).toContain("ul");
      expect(
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
  expect(tags(root)).toEqual(expect.arrayContaining(supported));
  expect(attr(firstTag(root, "a"), "href")).toBe("https://example.com");
  expect(textOf(root)).toContain("const x = 1;");
});

it("renders a GFM table with a header row and body rows", () => {
  const root = render(
    Array.join(["| Name | Role |", "| :--- | ---: |", "| Ada | human |", "| Bot | agent |"], "\n"),
  );
  const names = tags(root);
  const count = (tag: string) => Array.countBy(names, (name) => name === tag);
  expect(Array.map(["th", "td", "tr"], count)).toEqual([2, 4, 3]);
  expect(textOf(root)).toBe("NameRoleAdahumanBotagent");
});

it("a table in a Scene is found by what a person reads", () => {
  expect(() =>
    scene(
      {
        update: (model: null) => ({ model }),
        view: (_model: null, h) => ({
          body: renderMarkdown("## Hi {#spec.hi}\n\n| A |\n| - |\n| cell |", h),
          title: "markdown",
        }),
      },
      given(null),
      expectScene(selector("[data-section='spec.hi']")).toHaveText("Hi"),
      expectScene(selector("td")).toHaveText("cell"),
    ),
  ).not.toThrow();
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
      expect(names).not.toContain(tag);
    });
    expect(Array.countBy(names, (tag) => tag === "div")).toBe(1);
    expect(textOf(render(markdown))).not.toContain("<");
  });
});

it("HTML comments are dropped, including their text", () => {
  const root = render("Before <!-- secret --> after\n\n<!-- block secret -->\n\nEnd");
  expect(textOf(root)).not.toContain("secret");
  expect(textOf(root)).toContain("Before");
  expect(textOf(root)).toContain("End");
});

it("no element carries innerHTML or an event handler from the markdown", () => {
  Array.forEach(walk(render(`${Array.join(hostile, "\n\n")}\n\n${spec}`)), (element) => {
    expect(element.data?.props?.["innerHTML"]).toBeUndefined();
    expect(element.data?.on).toBeUndefined();
  });
});

it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"])(
  "a link to %s gets no href",
  (url) => {
    expect(attr(firstTag(render(`[x](${url})`), "a"), "href")).toBeUndefined();
  },
);

it.each(["https://example.com/a", "mailto:a@b.c", "/relative", "#spec.x", "./x.md"])(
  "a link to %s keeps its href",
  (url) => {
    expect(attr(firstTag(render(`[x](${url})`), "a"), "href")).toBe(url);
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
    expect(textOf(firstTag(root, `h${Number.min(depth + offset, 6)}`))).toBe("Title");
  },
);

it('without an offset "# " is an h1', () => {
  expect(tags(render("# Title {#prd.title}"))).toContain("h1");
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
    expectScene(selector('[data-section="spec.some"] button')).toHaveText("Some code title"),
    expectScene(selector('[data-section="spec.some"] button [data-badge]')).toBeAbsent(),
    expectScene(selector('[data-section="spec.some"] [data-badge]')).toExist(),
  );
  // Only the heading with a section id is wrapped.
  expect(Array.dedupe(wrapped)).toEqual(["spec.some"]);
});
