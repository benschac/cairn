import { readFileSync } from "node:fs";

import { it } from "@effect/vitest";
import { Array, Effect, Exit, Option, Stream, String } from "effect";
import { liveViewStateChanges } from "foldkit/mount";
import { Mount, expect, given, scene, selector } from "foldkit/scene";
import { expect as assert } from "vitest";

import {
  DrawDiagram,
  diagramView,
  drawDiagram,
  paintDiagram,
  type DiagramHost,
} from "../src/diagram.ts";
import { Message } from "../src/message.ts";

const spec = readFileSync(new URL("../../../.cairn/spec.md", import.meta.url), "utf8");

/** The first Mermaid block in the spec. */
const specDiagram = Option.getOrThrow(
  Option.flatMap(String.match(/```mermaid\n([\s\S]*?)\n```/u)(spec), Array.get(1)),
);

const flowchart = "flowchart LR\n  A[Draft] --> B[Published]";
const broken = "flowchart LR\n  A --> ";

it.effect("the spec's own diagram draws as an SVG", () =>
  Effect.gen(function* () {
    const svg = yield* drawDiagram(specDiagram, 456);
    assert(svg).toMatch(/^<svg /u);
    assert(svg).toContain("Stack 1");
  }),
);

it.effect("a diagram that does not parse fails with a one-line reason", () =>
  Effect.gen(function* () {
    const reason = yield* Effect.flip(drawDiagram(broken, 456));
    assert(reason).toContain("Parse error");
    assert(reason).not.toContain("\n");
  }),
);

it.effect("text that is not a diagram fails and does not throw", () =>
  Effect.gen(function* () {
    const reasons = yield* Effect.forEach(["not a diagram at all", ""], (source) =>
      Effect.flip(drawDiagram(source, 456)),
    );
    assert(reasons.length).toBe(2);
  }),
);

it.effect("a width of nothing draws the diagram at its own size", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(drawDiagram(flowchart, 0));
    assert(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.effect("diagram text and links never become markup, scripts or navigation", () =>
  Effect.gen(function* () {
    const svg = yield* drawDiagram(
      Array.join(
        [
          "flowchart LR",
          '  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]',
          '  C["<iframe src=https://evil.example></iframe>"]',
          '  click A href "javascript:alert(1)"',
          '  click B href "https://evil.example"',
          "  click C call alert()",
        ],
        "\n",
      ),
      456,
    );
    Array.forEach(
      [
        "<script",
        "<img",
        "<iframe",
        "<a ",
        "<a>",
        "href=",
        "xlink:href",
        "<foreignObject",
        "<style",
      ],
      (markup) => {
        assert(svg).not.toContain(markup);
      },
    );
    assert(svg).not.toMatch(/<[^>]*\son[a-z]+=/u);
  }),
);

const idsOf = (svg: string) =>
  Array.getSomes(
    Array.map(Array.fromIterable(String.matchAll(/[^-]\bid="([^"]+)"/gu)(svg)), Array.get(1)),
  );

it.effect("two diagrams on a page do not share ids", () =>
  Effect.gen(function* () {
    // A diagram with an accessible title has ids, which are the ones that could clash.
    const firstSvg = yield* drawDiagram("flowchart LR\n  accTitle: One\n  A --> B", 456);
    const secondSvg = yield* drawDiagram("flowchart LR\n  accTitle: Two\n  C --> D", 456);
    const first = idsOf(firstSvg);
    assert(first.length).toBeGreaterThan(0);
    assert(Array.intersection(first, idsOf(secondSvg))).toEqual([]);
  }),
);

/** A host that records what it was told to show. */
const recording = (width: number) => {
  const shown: Array<readonly [string, ...Array<string>]> = [];
  const host: DiagramHost = {
    showSource: (source, reason) => shown.push(["source", source, reason]),
    showSvg: (svg) => shown.push(["svg", svg]),
    width,
  };
  return { host, shown };
};

it.effect("a diagram that draws is shown as its SVG", () =>
  Effect.gen(function* () {
    const { host, shown } = recording(456);
    yield* paintDiagram(host, flowchart);
    assert(shown.length).toBe(1);
    assert(shown[0]?.[0]).toBe("svg");
    assert(shown[0]?.[1]).toMatch(/^<svg /u);
  }),
);

it.effect("a diagram that fails to parse shows its source and why, never nothing", () =>
  Effect.gen(function* () {
    const { host, shown } = recording(456);
    yield* paintDiagram(host, broken);
    assert(shown.length).toBe(1);
    assert(shown[0]?.[0]).toBe("source");
    assert(shown[0]?.[1]).toBe(broken);
    assert(shown[0]?.[2]).toContain("Parse error");
  }),
);

it("a Mermaid block is an empty placeholder with a mount, not its text", () => {
  scene(
    {
      update: (model: null, _message: Message) => ({ model }),
      view: (_model: null, h) => ({
        body: diagramView(h, flowchart, "diagram:test"),
        title: "diagram",
      }),
    },
    given(null),
    Mount.expectExact(DrawDiagram),
    expect(selector("[data-diagram]")).toBeEmpty(),
    Mount.resolve(DrawDiagram, Message.MeasuredLayout({ positions: {} })),
  );
});

/** A node the mount makes, recorded instead of built. */
interface MadeNode {
  readonly tag: string;
  textContent: string;
  readonly attributes: Record<string, string>;
  children: ReadonlyArray<MadeNode>;
  readonly style: { readonly setProperty: () => void };
  readonly setAttribute: (name: string, value: string) => void;
  readonly append: (...nodes: ReadonlyArray<MadeNode>) => void;
}

const madeNode = (tag: string): MadeNode => {
  const node: MadeNode = {
    append: (...nodes) => {
      node.children = Array.appendAll(node.children, nodes);
    },
    attributes: {},
    children: [],
    setAttribute: (name, value) => {
      node.attributes[name] = value;
    },
    style: { setProperty: () => undefined },
    tag,
    textContent: "",
  };
  return node;
};

/** The pieces of an element the mount touches, with no layer around it. */
const standIn = () => {
  const replaced: { nodes: ReadonlyArray<MadeNode> } = { nodes: [] };
  const element = {
    clientWidth: 456,
    closest: () => null,
    innerHTML: "",
    ownerDocument: { createElement: madeNode },
    replaceChildren: (...nodes: ReadonlyArray<MadeNode>) => {
      replaced.nodes = nodes;
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- no DOM here, so a stand-in for the Element the mount receives
  return { element, mounted: element as unknown as Element, replaced };
};

const sent = (mounted: Element, source: string) =>
  Stream.runCollect(DrawDiagram({ source }).f(mounted, liveViewStateChanges));

it.effect("the mount puts a diagram's SVG into its element", () =>
  Effect.gen(function* () {
    const { element, mounted, replaced } = standIn();
    const messages = yield* sent(mounted, flowchart);
    // Nothing to measure outside a layer, so nothing is sent.
    assert(messages).toEqual([]);
    assert(element.innerHTML).toMatch(/^<svg /u);
    assert(replaced.nodes).toEqual([]);
  }),
);

it.effect("the mount shows a broken diagram's source and its error instead of a blank", () =>
  Effect.gen(function* () {
    const { element, mounted, replaced } = standIn();
    yield* sent(mounted, broken);
    assert(element.innerHTML).toBe("");
    const [note, pre] = replaced.nodes;
    assert(note?.attributes["role"]).toBe("alert");
    assert(note?.textContent).toContain("could not be drawn");
    assert(note?.textContent).toContain("Parse error");
    assert(pre?.tag).toBe("pre");
    assert(pre?.children[0]?.textContent).toBe(broken);
  }),
);
