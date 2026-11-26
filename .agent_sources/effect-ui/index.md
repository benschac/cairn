# Effect UI sources

Effect UI (`@effect/ui`, `@effect/ui-kit`) is not on npm. The viewer installs both from the
pkg.pr.new snapshot of one commit of Effect-TS/ui's `main`, pinned once in
`pnpm-workspace.yaml`'s `effect-ui` catalog. The commit is `87a704b`
(`87a704bef41b40de8fa7bced97cae5d69c4233a0`), and `github.com/Effect-TS/ui/` here is a clone of
the same commit. The clone is ignored by git; this index is tracked. Moving to a newer commit
moves the catalog, the clone and this line together.

The installed packages carry their own guides, at the version the lockfile pins, and they win over
the clone if the two ever differ:

| Path | What it holds |
| --- | --- |
| `apps/viewer/node_modules/@effect/ui/AGENTS.md` | The Effect UI guide: components, naming, Commands, the Model, view functions, data, slots, headless components, shared state, ownership, mounts, events, forms, history, layout of an app, code splitting. The clone's `LLMS.md` is the same text. |
| `apps/viewer/node_modules/@effect/ui/ai-docs/src/` | The worked examples the guide links, as runnable TypeScript. |
| `apps/viewer/node_modules/@effect/ui/dist/*.d.ts` | Declarations with JSDoc. `.agent_sources/effect/index.md` lists every module with its size and summary. |
| `apps/viewer/node_modules/@effect/ui-kit/dist/*.d.ts` | The headless kit: `Switch`, `Collapsible`, `Dialog`, `Menu`, `Tabs`, ... Each module's leading JSDoc gives its anatomy, data attributes and keyboard. |
| `apps/viewer/node_modules/@effect/ui-kit/AGENTS.md` | The kit's guide. |

Do not read a whole file. Find the section here, then read its range.

## LLMS.md

`.agent_sources/github.com/Effect-TS/ui/LLMS.md`, by section:

| Section | Start line | End line |
| --- | ---: | ---: |
| Building user interfaces with `@effect/ui` | 14 | 56 |
| Keep-alive children | 57 | 165 |
| Naming | 166 | 277 |
| Command results | 278 | 332 |
| Changing the Model | 333 | 442 |
| Stateless view wrappers | 443 | 491 |
| Loading data | 492 | 535 |
| Slots | 536 | 573 |
| Headless components | 574 | 607 |
| Shared state | 608 | 670 |
| Who owns the state | 671 | 755 |
| Mounts | 756 | 773 |
| Document and window events | 774 | 793 |
| Drawing on a canvas | 794 | 812 |
| Forms | 813 | 862 |
| History restore | 863 | 912 |
| Organizing an app | 913 | 1026 |
| Code splitting | 1027 | 1192 |

## Worked examples

`ai-docs/src/10_ui/`, one file per topic. `index.md` beside them is the guide again. The notes app
they build is in `fixtures/`, laid out as an app's `src/` would be.

| File | Topic |
| --- | --- |
| [10_basics.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/10_basics.ts) | Building a component with @effect/ui |
| [20_composition.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/20_composition.ts) | Composing components, data and Layers |
| [21_view-functions.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/21_view-functions.ts) | Reusing view functions with children |
| [22_headless-components.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/22_headless-components.ts) | Headless components |
| [22_headless-composition.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/22_headless-composition.ts) | Composing headless components |
| [23_shared-state.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/23_shared-state.ts) | Shared state |
| [24_custom-elements.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/24_custom-elements.ts) | Custom elements |
| [24_mounts.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/24_mounts.ts) | Mounts |
| [25_document-events.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/25_document-events.ts) | Document and window events |
| [25_drawing-on-canvas.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/25_drawing-on-canvas.ts) | Drawing on a canvas |
| [26_forms.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/26_forms.ts) | Validating forms |
| [27_state-ownership.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/27_state-ownership.ts) | Who owns the state |
| [28_files.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/28_files.ts) | Files |
| [30_routing.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/30_routing.ts) | Routing and the document head |
| [32_view-transitions.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/32_view-transitions.ts) | View transitions |
| [35_url-state.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/35_url-state.ts) | Search, filters and pagination in the URL |
| [40_server-rendering.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/40_server-rendering.ts) | Rendering on the server |
| [45_hydration.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/45_hydration.ts) | Hydrating in the browser |
| [47_markdown.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/47_markdown.ts) | Markdown content |
| [50_testing.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/50_testing.ts) | Testing @effect/ui components |
| [60_opentui.ts](../github.com/Effect-TS/ui/ai-docs/src/10_ui/60_opentui.ts) | Terminal apps with OpenTUI |

## Source

| Path | Start here for |
| --- | --- |
| `packages/ui/src/Component.ts` | `Component.define`, `make`, `update` and its `$` (`evolve`, `run`, `emit`, `set`), children, `provide`, `lazy` |
| `packages/ui/src/View.ts` | The view value (`Element`, `Text`, `Child`), `ElementBuilder` (`attr`, `prop`, `on`, `key`, `onMount`, `forward`), `h.lazy`, `h.keepAlive` |
| `packages/ui/src/html/Html.ts` | The HTML vocabulary: tags, event payloads (`PointerPayload`, `KeyPayload`, ...), `style`, `class`, controlled `value`/`checked`/`open`, `Html.component` |
| `packages/ui/src/Command.ts`, `html/HtmlCommand.ts` | Commands, and the DOM ones (`focus`, `scrollIntoView`, `measure`, `waitForPaint`) that act on a `ref` |
| `packages/ui/src/Mount.ts` | `Mount.make`, `Mount.makeStream`, `Mount.map` |
| `packages/ui/src/Subscription.ts`, `html/HtmlSubscription.ts` | Keyed Streams, and document and window events |
| `packages/ui/src/Route.ts`, `Router.ts`, `html/BrowserRouter.ts` | Routes, the Router, link interception |
| `packages/ui/src/html/BrowserHost.ts`, `html/HtmlServer.ts` | Mounting in a page, and rendering to HTML |
| `packages/ui/src/testing/`, `html/testing/` | `Story`, `Scene`, `Play`, `TestHost`, `Locator`, and the HTML ones: `HtmlScene`, `HtmlPlay`, `HtmlLocator` |
| `packages/ui/src/UiSchema.ts`, `UiStruct.ts` | `UiSchema.TaggedEnum`, `UiStruct.evolve` |
| `packages/ui-kit/src/` | One file per kit component, with its tests in `packages/ui-kit/test/` |
| `packages/ui-devtools/` | The message-log inspector and its MCP server |

```sh
rg -n '^#+ ' .agent_sources/github.com/Effect-TS/ui/LLMS.md
sed -n '<start>,<end>p' .agent_sources/github.com/Effect-TS/ui/LLMS.md
rg -n '^export ' apps/viewer/node_modules/@effect/ui/dist/View.d.ts
```

For how the viewer uses Effect UI and what it lacks, read `apps/viewer/EFFECT-UI.md`.
