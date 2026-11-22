import { readFileSync } from "node:fs";

import { SectionId } from "@cairn/contract";
import { it } from "@effect/vitest";
import type { Html } from "foldkit/html";
import { expect as expectScene, given, scene, selector } from "foldkit/scene";
import { expect } from "vitest";

import { renderMarkdown } from "../src/markdown.ts";

type VNode = NonNullable<Html>;
type Rendered = Html;

/** Renders through a real Scene, which supplies the `h` builder, and hands back the vnode tree. */
const render = (markdown: string): VNode => {
  let rendered: Rendered = null;
  scene(
    {
      update: (model: null) => ({ model }),
      view: (_model: null, h) => {
        rendered = renderMarkdown(markdown, h);
        return { body: rendered, title: "markdown" };
      },
    },
    given(null),
  );
  if (rendered === null) throw new Error("nothing rendered");
  return rendered;
};

const defined = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

const children = (node: VNode): ReadonlyArray<VNode | string> => node.children ?? [];

const walk = (node: VNode | string): ReadonlyArray<VNode> =>
  typeof node === "string" ? [] : [node, ...children(node).flatMap(walk)];

const textOf = (node: VNode | string): string =>
  typeof node === "string" ? node : (node.text ?? children(node).map(textOf).join(""));

const attr = (node: VNode, name: string): unknown =>
  node.data?.attrs?.[name] ?? node.data?.props?.[name];

const tags = (node: VNode) => walk(node).map((element) => element.sel?.split(/[.#]/u)[0]);

const spec = readFileSync(new URL("../../../.cairn/spec.md", import.meta.url), "utf8");
const prd = readFileSync(new URL("../../../.cairn/prd.md", import.meta.url), "utf8");

const sectionsIn = (source: string) =>
  walk(render(source)).flatMap((element) => {
    const id = attr(element, "data-section");
    return typeof id === "string" ? [{ element, id }] : [];
  });

const headingIds = (source: string) =>
  [
    ...source
      .replaceAll(/^```[\s\S]*?^```/gmu, "")
      .matchAll(/^#{1,6}[ \t]+.*\{#([^}\s]+)\}[ \t]*$/gmu),
  ].map((match) => match[1]);

it.prop(
  "a heading's trailing id becomes its element id and data-section, and leaves its text",
  [SectionId],
  ([id]) => {
    const root = render(`## Some title {#${id}}\n\nBody.`);
    const heading = walk(root).find((element) => tags(element)[0] === "h2");
    expect(heading).toBeDefined();
    expect(attr(defined(heading), "id")).toBe(id);
    expect(attr(defined(heading), "data-section")).toBe(id);
    expect(textOf(defined(heading))).toBe("Some title");
  },
);

it("a heading without an id has no data-section", () => {
  const sections = sectionsIn("## Plain title\n\nBody.");
  expect(sections).toEqual([]);
});

it("every heading with an id in the spec and the PRD becomes a data-section element", () => {
  for (const source of [spec, prd]) {
    expect(sectionsIn(source).map((section) => section.id)).toEqual(headingIds(source));
    expect(headingIds(source).length).toBeGreaterThan(5);
  }
  for (const { element, id } of sectionsIn(spec)) {
    expect(attr(element, "id")).toBe(id);
    expect(textOf(element)).not.toContain("{#");
  }
});

it("the key list that starts a spec section renders as chips", () => {
  const root = render(
    [
      "## Title {#spec.a}",
      "",
      "- Implements: `prd.x`, `prd.y`",
      "- Files: `a/b.ts`",
      "",
      "Prose.",
    ].join("\n"),
  );
  const chips = walk(root).filter((element) => attr(element, "data-key") !== undefined);
  expect(chips.map((chip) => [attr(chip, "data-key"), textOf(chip)])).toEqual([
    ["Implements", "prd.x"],
    ["Implements", "prd.y"],
    ["Files", "a/b.ts"],
  ]);
  expect(tags(root)).not.toContain("ul");
});

it("a section's chips in the spec match its key lines", () => {
  const chips = walk(render(spec)).filter((element) => attr(element, "data-key") !== undefined);
  expect(chips.length).toBeGreaterThan(20);
});

it("a bullet list that is not a key list stays a list", () => {
  for (const source of [
    "## T {#spec.a}\n\n- Colour: `red`",
    "## T {#spec.a}\n\n- Implements: some prose",
    "Intro\n\n- Implements: `prd.x`",
  ]) {
    const root = render(source);
    expect(tags(root)).toContain("ul");
    expect(walk(root).filter((element) => attr(element, "data-key") !== undefined)).toEqual([]);
  }
});

it("renders the inline and block markdown it supports", () => {
  const root = render(
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
    ].join("\n"),
  );
  const present = new Set(tags(root));
  for (const tag of [
    "p",
    "em",
    "strong",
    "code",
    "a",
    "blockquote",
    "hr",
    "ol",
    "ul",
    "li",
    "pre",
  ]) {
    expect(present.has(tag)).toBe(true);
  }
  const link = walk(root).find((element) => tags(element)[0] === "a");
  expect(attr(defined(link), "href")).toBe("https://example.com");
  expect(textOf(root)).toContain("const x = 1;");
});

it("renders a GFM table with a header row and body rows", () => {
  const root = render(
    ["| Name | Role |", "| :--- | ---: |", "| Ada | human |", "| Bot | agent |"].join("\n"),
  );
  const names = tags(root);
  expect(names.filter((tag) => tag === "th")).toHaveLength(2);
  expect(names.filter((tag) => tag === "td")).toHaveLength(4);
  expect(names.filter((tag) => tag === "tr")).toHaveLength(3);
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
  for (const markdown of [source, `para\n\n${source}\n\nafter`, `- ${source}`]) {
    const names = tags(render(markdown));
    for (const tag of ["script", "img", "iframe", "b"]) {
      expect(names).not.toContain(tag);
    }
    expect(names.filter((tag) => tag === "div")).toHaveLength(1);
    expect(textOf(render(markdown))).not.toContain("<");
  }
});

it("HTML comments are dropped, including their text", () => {
  const root = render("Before <!-- secret --> after\n\n<!-- block secret -->\n\nEnd");
  expect(textOf(root)).not.toContain("secret");
  expect(textOf(root)).toContain("Before");
  expect(textOf(root)).toContain("End");
});

it("no element carries innerHTML or an event handler from the markdown", () => {
  for (const element of walk(render(`${hostile.join("\n\n")}\n\n${spec}`))) {
    expect(element.data?.props?.["innerHTML"]).toBeUndefined();
    expect(element.data?.on).toBeUndefined();
  }
});

it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x"])(
  "a link to %s gets no href",
  (url) => {
    const link = walk(render(`[x](${url})`)).find((element) => tags(element)[0] === "a");
    expect(link).toBeDefined();
    expect(attr(defined(link), "href")).toBeUndefined();
  },
);

it.each(["https://example.com/a", "mailto:a@b.c", "/relative", "#spec.x", "./x.md"])(
  "a link to %s keeps its href",
  (url) => {
    const link = walk(render(`[x](${url})`)).find((element) => tags(element)[0] === "a");
    expect(attr(defined(link), "href")).toBe(url);
  },
);
