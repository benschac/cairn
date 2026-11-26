# Effect UI: what the spike found

Spike for `spec.viewer.effect-ui.spike`, against Effect-TS/ui at `87a704b`
(`@effect/ui` and `@effect/ui-kit` from pkg.pr.new, Effect 4.1.6).

## Verdict

**The bridge works, and nothing found blocks the move.** Through `effect-ui/bridge.ts`, the
whole reader screen (the viewer's `view` body over the demo trace, about 13,000 HTML tokens)
renders the same DOM under Effect UI as under Foldkit, a bridged click sends the Message the
Foldkit button sends, a Foldkit `Mount` runs as an Effect UI mount on the same element, and a
render that leaves a `createLazy` view alone reuses its nodes. The host step can go ahead as
written, with two additions, and two later steps change:

1. **Host step: the pane divider.** Effect UI's event payloads carry no `pointerId` and no target
   element, and `HtmlSubscription` has no `pointermove`. The divider's `OnPointerDown` reads both
   (`dividerView.ts` `pressOnDivider`), so through the bridge a press builds a `PressedDivider`
   with no `pointerId`, and building it fails Schema validation (checked by firing `pointerdown` on the bridged divider in an `HtmlScene`). The host step ports the
   divider's press to an Effect UI mount (`Mount.makeStream` on the divider, reading
   `pointerdown` from the node) and keeps `subscription/resize.ts`'s document stream as a raw
   Stream in `Subscription.make`. Add `apps/viewer/src/view/dividerView.ts` to that step's files.
2. **Host step: the address.** Effect UI's Router is typed by a `Route` union and intercepts only
   anchors whose href the routes parse. The viewer's address is a link path that
   `@cairn/contract`'s `decodeLink` reads, so the host gives `BrowserRouter` one catch-all route
   (`Route.make("/*")`) and builds `ChangedUrl` and `ClickedLink` from it. Whether a catch-all
   route carries the hash, which `hashchange` sends today, was not checked; if it does not, a
   `hashchange` stream in `Subscription.make` sends `ChangedUrl`.
3. **Views step: disclosures in Scene tests.** `effect-ui/controls.ts`'s `DisclosureView` is
   `@effect/ui-kit`'s `Collapsible`, a headless component with its own `update`. An `HtmlScene`
   runs only the component it starts from, so clicking a Collapsible's trigger from the viewer's
   scene throws ("A scene doesn't run a child's update"). While the views are bridged (host and
   scene-tests steps) every disclosure is still Foldkit's and clicks work. Once a view renders
   `DisclosureView`, each Scene test that clicks a PRD fold or a spec card has to either send the
   kit's event (`s.childEmit(Collapsible, key, CollapsibleEvents.Toggled(...))`) or become an
   `HtmlPlay`, which runs children. That breaks the views step's rule that its Scene tests pass
   unchanged. Choose one: those tests move to `HtmlPlay` in the part that moves them, or the views
   step draws disclosures as a plain `aria-expanded` button (no Collapsible) and Collapsible waits
   for the components step. `controls.scene.test.ts` does both kinds, so either works.
4. **Views and Foldkit removal: SVG.** `@effect/ui/html` has no SVG tags (`h.svg` does not
   exist), though both hosts already create the tags in `svgTags` in the SVG namespace. The bridge
   builds element nodes as data, which is why the topbar logo, `arrowsView` and `wiresView` work
   through it. When those views move, they build `View.Element` data the same way, through a small
   `effect-ui/svg.ts` helper, unless upstream adds an SVG vocabulary first (report 1 below). Add
   that file to the views step.

Everything else in the plan stands. The scene-tests step changes more harness calls than "role and
selector become locators" suggests (see `foldkit/scene` below), but no assertion has to change.

## How the bridge works

`makeFoldkitBridge({ message, mounts })` returns `build`, `foldkitView` and `mountOf`:

- `build(view)` runs a Foldkit view under the bridge's own dispatch frame, with a Foldkit `h`, as
  Foldkit's runtime does: one boundary registry across renders, so `createLazy` and
  `createKeyedLazy` hit, and a render transaction around each pass. Foldkit's public entry has no
  way to push a frame, so the bridge imports `__setRuntime` and its siblings from
  `node_modules/foldkit/dist/html/index.js` by path. That import goes with Foldkit.
- `foldkitView(h, html)` turns a `VNode` into Effect UI `View` nodes, built as data: the tag;
  snabbdom's `attrs`, `class`, `dataset` and `style` as attributes; Foldkit's reflected
  properties (`h.Id`, `h.Type`, `h.Href`, `h.Tabindex`, ...) as the attributes they reflect;
  `value`, `checked`, `selected`, `open` as Effect UI's controlled properties; the key; text
  nodes, merged as Effect UI keeps them. A VNode it has seen converts to the node it returned
  last time, so an unchanged lazy subtree costs nothing and Effect UI's patch sees the same nodes.
- Each Foldkit listener becomes an Effect UI handler. The handler builds a DOM-shaped event from
  Effect UI's payload (key and modifiers, button and position, an input's `target.value`), calls
  the Foldkit listener, catches what it dispatches, checks it against `message`, and returns it.
  `keydown` and `keyup` set `preventDefault: true`, which cancels the default exactly when a
  Message comes back, as `OnKeyDownPreventDefault` and `@foldkit/ui`'s key handlers do.
- A Foldkit `OnMount` leaves only `{ name, args }` on the VNode, so the bridge is given every
  Mount definition the views issue and makes one Effect UI `Mount.makeStream` per definition. Its
  body is the Foldkit Mount's own `f(element, liveViewStateChanges)`. A Scene names it with
  `bridge.mountOf(TrackPrdScroll)`. An unknown Mount name throws at render.

Known limits, none of which the viewer hits today except the divider:

- A field no payload carries is missing from the synthetic event: `pointerId`, `screenX`,
  `timeStamp`, a real `target` or `currentTarget` element, `relatedTarget`. Handlers that read
  them need a mount (the divider).
- Effect UI gives an event to the innermost element with a handler for it, and only that one.
  Foldkit's DOM listeners bubble, so an outer handler for the same event also ran. A view that
  relies on both firing would differ; the scene-tests step finds any.
- A Foldkit handler that calls `preventDefault` on an event other than `keydown` or `keyup`
  (`OnClick` with `DefaultAction.Prevent`, `OnDragOver`) is not prevented: Effect UI decides
  prevention from options set at render, not from the handler. The viewer uses none.
- A handler that dispatches more than one Message sends the first.
- `OnUnmount`, `OnCustomEvent` and Submodel boundaries are not bridged. The viewer uses none.
- Foldkit lets a Mount's args change without restarting it, and so does the bridge: new args reach
  the Effect UI mount's `changes`, which the body ignores, as Foldkit's does.
- `build` is one Foldkit render pass; call it once per Effect UI render.

## The update adapter (host step)

Foldkit's `update` returns `{ model, commands }`, where a Command is `{ name, args?, effect }` and
`effect` is an `Effect<Message>`. Effect UI's `update` returns a step: `$.evolve(...)` or `$.set`
for the Model, then `.run(issued)` for each Command. The adapter goes in `bridge.ts`:

- One Effect UI Command definition per Foldkit Command name, made once from the definitions the
  viewer exports (as the Mounts are), with `args: { command: Schema.declare(isFoldkitCommand) }`
  and the body `({ command }) => command.effect`. Declared args compare by identity, which is
  right: each Foldkit Command value is new. One definition per name keeps a Story's
  `s.resolve(Definition, message)` and the message log naming the Command as Foldkit did.
- `Viewer`'s `update` is `($, message) => { const { model, commands } = withAddress(update)($.model, message); return Array.reduce(commands, $.set(model), (step, command) => step.run(adapted(command))) }`.
  A union-shaped or class Model has no `$.evolve`, so `$.set` is the safe start.
- A Foldkit Command's `effect` may need Foldkit services (`Dom`, `Navigation`); they are Effects
  over `document` and `window` with no Foldkit runtime behind them, so they run as they are.
- Commands with no result end in a `Completed*` Message today; keep them until the components
  step, where `Command.asNoop` can replace them.

## Each Foldkit API the viewer imports

| Foldkit                                                                          | Effect UI                                                                                                                                                                                     | Bridge, host step                                                                                                                                                                                                                                                                                                                                                    | Later                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Runtime.makeApplication`, `Runtime.run` (`entry.ts`)                            | `Html.component({ name, model, message })` with `init`, `update`, `view`, `subscriptions`; `BrowserHost.mount(Viewer, props, element)` and `Layer.launch`                                     | `Viewer` wraps today's `init`, `withAddress(update)` through the adapter, and `view` through `foldkitView`. Works: the bridge test renders the reader as a component.                                                                                                                                                                                                |                                                                                                                                                                                                                         |
| `routing` (`onUrlChange`, `onUrlRequest`)                                        | `BrowserRouter.layer` (or `layerHash`), `Router.props`, `Router.subscription(routes, model, toMessage)`, `Router.push`/`replace`                                                              | Catch-all route; see Verdict 2. A click on an anchor the routes don't parse is a full load, so `ClickedLink(External)` may go.                                                                                                                                                                                                                                       | `route.ts` on `Route` at removal.                                                                                                                                                                                       |
| `devTools: { Message }`                                                          | `@effect/ui-devtools` `DevTools.layer`: an overlay on the message log and an MCP server. pkg.pr.new serves `@effect/ui-devtools@87a704b` (not installed by the spike).                        | Optional, development only.                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                         |
| `Subscription.aggregate`, `Subscription.make`, `Subscription.persistentEntry`    | `subscriptions: ($) => [...]` with `Subscription.make(name, deps, build)`, keyed by name and deps; `HtmlSubscription.onDocument`, `onWindow`, `shortcuts`, `onAnimationFrame`, `onMediaQuery` | Each subscription becomes `Subscription.make` over the Stream it has. Escape can be `HtmlSubscription.onDocument("keydown")`; resize cannot (no `pointermove`, no `pointerId`) and stays a raw Stream.                                                                                                                                                               |                                                                                                                                                                                                                         |
| `Command.define`, Command values                                                 | `Command.make(name, { args }, body)`, `Command.Service`, `$.run`                                                                                                                              | The adapter above.                                                                                                                                                                                                                                                                                                                                                   | Rewritten per pane in the components step.                                                                                                                                                                              |
| `Mount.define`, `Mount.defineStream`, `h.OnMount`                                | `Mount.make`, `Mount.makeStream`, `.onMount(issued)`, `Mount.map`; one mount per element, as in Foldkit                                                                                       | Works: each Foldkit Mount runs as an Effect UI mount on its element (`TrackPrdScroll` in the test). The bridge needs the list of definitions.                                                                                                                                                                                                                        | `DrawDiagram`, `RenderDiff` move in the views step.                                                                                                                                                                     |
| `AsyncData` (`Schema`, `match`, `getData`, `settle`)                             | No Model type. Effect UI keeps fetched data out of the Model: a `Query` holds results beside it, and `AsyncResult` appears in fallbacks.                                                      | `foldkit/asyncData` is a Schema and keeps working.                                                                                                                                                                                                                                                                                                                   | At removal, a local `UiSchema.TaggedEnum` with the same four cases, or the trace load and poll become a `Query` (a design change for the components step).                                                              |
| `Dom.focus`, `Dom.scrollIntoView`, `Dom.scrollIntoViewAfterPaint`                | `HtmlCommand.focus`, `scrollIntoView`, `waitForPaint`, `measure`; each targets a `Renderer.Ref` (`Html.ref(name, tag)` and `.ref(ref)` on the element), not a selector                        | The Foldkit Commands query `document` and run through the adapter unchanged.                                                                                                                                                                                                                                                                                         | Targets get refs in the views step; rows such as search results use per-row refs.                                                                                                                                       |
| `Url` (`Url.Url`, `Url.toString`), `Navigation` (`UrlRequest`, `load`)           | The Router's route value and `Router.push`/`replace`/`patchSearch`. No Router command loads an external URL; that stays a Command over `window.location`.                                     | Kept; the Router's location is turned into a `Url` for `ChangedUrl`.                                                                                                                                                                                                                                                                                                 | Replaced with `route.ts` at removal.                                                                                                                                                                                    |
| `foldkit/route` (`defineRouteUnion`, `literal`, `mapTo`, `slash`, `string`)      | `Route.make(template, { params, search })`, `Route.union`, `print`, `parse`, `Route.redirect`                                                                                                 | Kept as it is; nothing in the host step needs it moved.                                                                                                                                                                                                                                                                                                              | At removal, as the spec says.                                                                                                                                                                                           |
| `foldkit/html` (`Html`, `HtmlBuilder`, `Attribute`, `Document`)                  | `@effect/ui/html`: `Html.H<Msg>`, chained builders (`h.div.class("x").attr(...).on("click", m).children(...)`), `head` with `Head`/`HtmlHead` for the title                                   | The bridge.                                                                                                                                                                                                                                                                                                                                                          | Views step. No SVG tags: Verdict 4. Attribute arrays (`h.Class`, `h.DataAttribute`) become chained calls, and an attribute bundle a helper returns (`searchedAttributesOf`) becomes a function from builder to builder. |
| `createLazy`, `createKeyedLazy`                                                  | `h.lazy(fn, key, ...args)`, compared with `===` per first argument                                                                                                                            | Foldkit's lazies keep working under `build`, and the bridge reuses their converted nodes (tested).                                                                                                                                                                                                                                                                   | Views step.                                                                                                                                                                                                             |
| `foldkit/struct` `modifyFields`                                                  | `$.evolve`, `UiStruct.evolve` (no unions, no class instances: match first, or `$.set`)                                                                                                        | Not needed; `update` is unchanged.                                                                                                                                                                                                                                                                                                                                   | Removal.                                                                                                                                                                                                                |
| `defineMessageUnion` (`foldkit/message`), `defineTaggedUnion` (`foldkit/schema`) | `UiSchema.TaggedEnum`                                                                                                                                                                         | Foldkit's unions are Effect Schemas; `Html.component` takes the viewer's `Message` as it is (the bridge test does).                                                                                                                                                                                                                                                  | Removal; names stay.                                                                                                                                                                                                    |
| `foldkit/scene`                                                                  | `HtmlScene` with `HtmlLocator.role`, `Locator.attr`, `Locator.text`, `Locator.inside`; `s.mounted`, `s.expectMount`, `s.resolve`, `s.childEmit`; `HtmlPlay` to run children                   | Scene-tests step. A CSS `selector(...)` becomes `Locator.attr` (and `Locator.inside` for a descendant selector); `all.selector` becomes `s.all` or `toHaveCount`; `Mount.resolve(Def, m)` becomes `s.mounted(bridge.mountOf(Def), m)`; `Command.resolve` resolves the adapter's definition. A mount nothing acknowledged fails the next message step, as in Foldkit. | Headless kit children cannot be clicked in a Scene: Verdict 3.                                                                                                                                                          |
| `foldkit/story`                                                                  | `Story` (`Story.make`, `send`, `resolve`, `expectExact`, `emitted`)                                                                                                                           | Scene-tests step.                                                                                                                                                                                                                                                                                                                                                    |                                                                                                                                                                                                                         |
| `foldkit/test` `Lazy.expectAllReused` (fixtures, presence and wires scenes)      | None: no test API shows whether `h.lazy` reused a node.                                                                                                                                       | While views are Foldkit's, assert that a render reuses the bridged node by identity, as `bridge.test.ts` does, or count calls of the lazy view function.                                                                                                                                                                                                             | Count calls of the `h.lazy` function (report 4).                                                                                                                                                                        |
| `@foldkit/ui` `Switch`, `Disclosure`                                             | `@effect/ui-kit` `Switch` (a view function) and `Collapsible` (headless, stateful)                                                                                                            | `effect-ui/controls.ts` rebuilds both with the same classes, roles, labels and IDs. The kit switch adds `data-checked`/`data-unchecked` and relies on the native button for Space and Enter instead of a `keyup` handler.                                                                                                                                            | Verdict 3.                                                                                                                                                                                                              |
| `@foldkit/vite-plugin`                                                           | None needed to mount components. Effect UI's hot swap is its `#hot` import (`html/internal/hotOn.ts`); `@effect/ui/html/MarkdownVite` is only for Markdown pages.                             | The host step removes the plugin and checks hot reload by hand; the proxy stays.                                                                                                                                                                                                                                                                                     |                                                                                                                                                                                                                         |
| `@foldkit/oxlint-plugin`                                                         | No lint plugin for apps. `packages/tools/oxc` (`@effect/oxc`) is Effect-TS's own private config.                                                                                              | Kept while Foldkit is.                                                                                                                                                                                                                                                                                                                                               | Its rules are dropped at removal with nothing in their place.                                                                                                                                                           |

## What else the spike changed

- `pnpm-workspace.yaml` has a named catalog `effect-ui` with both tarball URLs, and
  `apps/viewer/package.json` uses `catalog:effect-ui`; the lockfile records the tarballs'
  integrity.
- `apps/viewer/tsconfig.json` allows `@effect/ui` and `@effect/ui-kit` in
  `allowedExperimentalApis`: every export is `@stability experimental`, and the language
  service's warnings fail `tsc`.
- `scripts/effect-api/refresh-effect-api.ts` reads named catalogs and accepts a tarball URL as a
  pin (the package's own version is `0.0.0`), and `.agent_sources/effect/index.md` now lists both
  packages, so `pnpm check:effect-api` passes.

## To report upstream

Written up for the owner; nothing has been filed.

1. **Effect-TS/ui: an SVG vocabulary.** `@effect/ui/html` has no `svg`, `path`, `g`, `marker`
   builders, though `html/internal/elements.ts` lists `svgTags` and both the DOM host and the
   server serializer already create them in the SVG namespace and normalise their attribute names.
   An app drawing icons or diagrams writes `View.Element` data by hand.
2. **Effect-TS/ui: `pointerId` and pointer moves.** `PointerPayload` has no `pointerId`, and
   neither elements nor `HtmlSubscription.onDocument` deliver `pointermove`. A drag that follows
   one pointer (a resize handle with pointer capture) needs a mount for both the press and the
   moves.
3. **Effect-TS/ui: clicking a kit component in a consumer's Scene.** A click on a part of a
   headless child (`Collapsible`'s trigger) fails with "A scene doesn't run a child's update". For
   `@effect/ui-kit`, whose components every app uses, an option to run kit children's `update` in
   a Scene, or a documented recipe, would keep consumer Scene tests clicking as a person does.
4. **Effect-TS/ui: asserting `h.lazy` reuse.** Neither `Scene` nor `TestHost` shows whether a
   render reused a lazy node, so a test that a hover does not rebuild a document has nothing to
   assert on.
5. **Effect-TS/ui (small): a CSS selector locator.** `Locator` has `attr`, `tag`, `text` and
   `inside`; `data-*` attribute selectors with a value map onto `attr`, but compound selectors
   need nesting.
6. **Foldkit: no public frame API.** `foldkit/html` exports no way to build a view under a
   host-supplied dispatch (`__setRuntime` is reachable only past the `exports` map). Any
   integration that renders Foldkit views under another runtime needs it. Low priority, since the
   viewer drops Foldkit.

## SVG

`@effect/ui/html` has no SVG builders. `src/effect-ui/svg.ts` gives `svgFor<Message>()`: one builder per SVG tag
(`svg`, `g`, `path`, `line`, `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `text`, `tspan`, `defs`,
`marker`, `use`, `symbol`, `clipPath`, `linearGradient`, `stop`). Each is Effect UI's own HTML element builder under
an SVG tag, so it reads as `h` does (`attr`, `class`, `style`, `key`, `on`, `ref`, `onMount`, `children`, and a call as
shorthand for `children`). The host creates an element whose tag it lists in `svgTags` in the SVG namespace, and the
server writes its attributes in SVG case, so `viewBox` stays `viewBox`. There is no `title`: the host does not list it,
so it would be an HTML element. Use `aria-label`.

```ts
const svg = svgFor<Message>();

h.div.children(
  svg.svg
    .attr("viewBox", "0 0 100 40")
    .attr("aria-hidden", "true")
    .children(
      svg.defs.children(svg.marker.attr("id", "head").children(svg.path.attr("d", "M0 0L4 2"))),
      svg.path
        .key("edge")
        .attr("d", "M10 20L90 20")
        .attr("marker-end", "url(#head)")
        .style({ stroke: "var(--ink)" }),
      svg.circle
        .key("a")
        .attr("r", "6")
        .on("click", () => Message.ClickedNode({ id: "a" })),
    ),
);
```

`test/effect-ui/svg.test.ts` renders one and clicks a shape in a `HtmlScene`.

## Writing views

The frame moved first (`spec.viewer.effect-ui.views`, task t240): `view/view.ts`, `readerView.ts`
(the top bar, the notice, the grid and its dividers), `topBarView.ts`, `dividerView.ts`,
`linkNoticeView.ts`, `copyLinkView.ts`, `searchView.ts`, `nodeView.ts`, `modelView.ts`,
`ui/marks.ts` and `effect-ui/controls.ts`. Everything below them is still Foldkit and renders through
the bridge. A part that moves next copies what these files do.

**The DOM does not change.** A view keeps its tags, classes, roles, labels, IDs, keys, attributes,
inline styles and Messages, so the Scene tests pass unchanged. Before t240 was committed, the whole
reader screen rendered by the new frame was compared token by token with the Foldkit one (the
`tokensOf` comparison in `test/effect-ui/bridge.test.ts`); do the same for a part before you move it,
with the Foldkit original from `git show`.

In development Vite serves `foldkit` and `@foldkit/ui` from `node_modules` unbundled
(`optimizeDeps.exclude` in `vite.config.ts`): the bridge imports Foldkit's html module by its path,
and a pre-bundled `foldkit/html` would be a second copy with its own render frame, so a bridged view
would throw that it was built outside a render. The tests and the production build have one copy
either way.

### A view function

`h` comes first, then the data, and the function returns the builder, with no return type written.
Names stay as they were (`fooView`), so a moved view keeps its importers' names. A view of the
viewer types `h` as `Html.H<Message>`; a leaf a test hosts with its own Messages is generic.

```ts
export const linkNoticeView = <Message>(
  h: Html.H<Message>,
  text: string,
  messages: LinkNoticeMessages<Message>,
) =>
  h.div
    .class("link-notice")
    .attr("role", "status")
    .attr("data-link-notice", "")
    .children(
      h.p(text),
      h.button
        .attr("type", "button")
        .class("btn")
        .on("click", messages.onDismiss)
        .children("Dismiss"),
    );
```

`h` first is what `h.lazy` needs (it calls `fn(h, ...args)`). A helper that returns several
children returns an array, and a parameter that takes text or marked nodes is `View.Input<Msg>`
(`tagView(h, kind, text: View.Input<Msg>)`). Children nest one array deep in the types, so flatten a
list of lists with `Array.flatten` before passing it (`searchView`'s `snippetView`).

Attributes are chained calls: `h.Class` is `.class`, `h.Id` is `.id`, `h.Value` is `.value`
(controlled), `h.Disabled` is `.disabled`, and everything else is `.attr(name, text)`: roles,
`aria-*` as `"true"`/`"false"`, `data-*`, `tabindex` as `"0"`, `title`, `placeholder`,
`autocomplete`. `.attr(name, undefined)` leaves an attribute off, which is how a conditional
attribute is written:

```ts
.attr("aria-controls", hasResults ? SEARCH_LISTBOX_ID : undefined)
.attr("aria-activedescendant", Option.getOrUndefined(Option.map(search.maybeActive, optionIdOf)))
```

Native buttons keep `.attr("type", "button")`. Disclosures and switches are the plain buttons in
`effect-ui/controls.ts`, not `@effect/ui-kit`'s `Collapsible` and `Switch` (Verdict 3): a click on
them reaches the viewer's `update` in a Scene.

**Inline style.** Write `.attr("style", styleText({ ... }))` from `effect-ui/attributes.ts`, with
the kebab-case names Foldkit's `h.Style` had. Effect UI's `.style` writes `a:b;c:d`, and the Scene
tests read Foldkit's `a: b; c: d` (`styled`, `styleDeclaring`). Use `.style` in the components step.

**An attribute bundle** (a Foldkit `ReadonlyArray<Attribute>`, such as `searchedAttributesOf`)
becomes a function that takes the builder and returns it:

```ts
export const withSearched = <B>(builder: B & Attributable<B>, search: NodeSearch): B =>
  builder.attrs({ "data-searched": search.isActive ? "active" : ... });

withSearched(h.li.class("row"), search).children(...)
```

Type the parameter `B & Attributable<B>`, not `B extends Attributable<B>`: a bare `h.div` is a
callable shorthand that the `extends` form does not infer. Call `attrs` once; `B` has nothing else.

### Calling a child

A child that has moved is called with the parent's `h`: `dividerView(h, "prd", model.widths)`.
A child still on Foldkit goes through the bridge, with the Foldkit `h` the bridge hands in, in the
position the child had:

```ts
viewerBridge.bridged(h, (foldkit) => specPaneView(trace, maybeCurrent, ..., foldkit)),
dividerView(h, "spec", model.widths),
```

`Viewer`'s `view` is `(h, model) => viewerBridge.render(() => view(h, model))`: one Foldkit render
pass per Effect UI render, which every `bridged` call inside shares, so `createKeyedLazy` keeps the
entries each pane used. Never call `viewerBridge.build` from a view, and never pass an Effect UI node
into a Foldkit view: the bridge runs one way. When you move a child, replace its `bridged` call
with a direct one; that is the only change its parent needs.

A leaf both sides still use (`dotView`, `copyButtonView`, `dividerView`, the controls, ...) has
its Effect UI version at its own path and a Foldkit copy under `src/foldkit/`, which the Foldkit
views import. Move a view, switch its imports from `../foldkit/...` to the Effect UI file, and
delete a `src/foldkit/` file in the change that removes its last importer. Pure helpers
(`copyLabelOf`, `passageButtonFor`, `handleWidthOf`, `modelTitleOf`) live only in the Effect UI
file, and the Foldkit copy imports them from there.

### Keys, empty children and lists

`h.keyed("div")(key, ...)` is `.key(key)` on the builder; give a key exactly where Foldkit had one.
An empty child is a hole (`false`, `null`, `undefined`), not an empty array:

```ts
model.isOpen && panel(h.div).children("The spec section in full"),
Option.getOrUndefined(Option.map(model.maybeLinkNotice, (text) => linkNoticeView(h, text, ...))),
Array.match(model.detail, { onEmpty: () => null, onNonEmpty: (trail) => ... }),
```

A list is `Array.map` into `.children(...)`; an array is flattened, so it can sit beside other
children.

### SVG

Through `effect-ui/svg.ts` (see SVG above), with every attribute as `.attr` in SVG case:

```ts
const svg = svgFor<Message>();
svg.svg
  .attr("viewBox", "0 0 22 22")
  .attr("aria-hidden", "true")
  .children(svg.ellipse.attr("cx", "11").attr("cy", cy).attr("fill", "currentColor"));
```

### Mounts

A Mount becomes an Effect UI mount with the same name, issued with `.onMount`:
`.onMount(PressDivider({ pane }))`. When it moves, the Foldkit definition leaves
`viewerBridge`'s `mounts` list and the fixtures' `viewerBridge.mountOf(X)` becomes `X`. While the
view that owns a Mount is still Foldkit, an Effect UI element can issue the bridged one, as the
reader grid does until the wires move: `.onMount(viewerBridge.mountOf(MeasureWires)({ args: undefined }))`
(`args` is what the Foldkit Mount was called with).

### Lazy views

`createLazy` and `createKeyedLazy` become `h.lazy(fn, ...args)`. `fn` is declared at module level
as `(h, ...args) => ...`, the args are compared with `===`, and the first argument tells calls
apart, so a keyed lazy puts its key (the row, the section ID) first. Pass the plain values the
Foldkit lazy was given, so a hit is as likely as before. A reused `h.lazy` node is the same object,
so `sameNodes` in the wires scenes still sees the reuse.

### Event data

A handler gets Effect UI's payload, not a DOM event. Return the Message, or `undefined` to ignore
the event; `{ preventDefault: true }` cancels the default only when a Message comes back, which is
`OnKeyDownPreventDefault`:

```ts
.on("input", ({ value }) => Message.ChangedSearchQuery({ query: value }))
.on("keydown", ({ key }) => Option.getOrUndefined(searchKeyMessage(key)), { preventDefault: true })
```

A payload has no `pointerId`, no target element and no `pointermove`: a handler that needs them is
a mount on the element (`PressDivider`). An event goes to the innermost element with a handler for
it, and only there.

### Focus and blur

`.on("focus", Message.FocusedX())` and `.on("blur", Message.BlurredX())`, two Messages, as the
naming rules say. Moving focus stays a Foldkit Command (`Dom.focus` on an ID, through the update
adapter) until the components step gives targets `Html.ref`s, so keep the IDs it looks up
(`SEARCH_INPUT_ID`, the detail heading's).
