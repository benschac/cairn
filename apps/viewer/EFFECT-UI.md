# Effect UI in the viewer

The viewer is one Effect UI component (`Viewer` in `src/app.ts`), mounted by `src/entry.ts` with
`BrowserHost.mount`. `@effect/ui` and `@effect/ui-kit` come from the pkg.pr.new snapshot of one
Effect-TS/ui commit, pinned in `pnpm-workspace.yaml`'s `effect-ui` catalog
(`.agent_sources/effect-ui/index.md` has the commit, the guides and the source). The viewer moved
here from Foldkit in `spec.viewer.effect-ui`; this file is how its code uses Effect UI, and what
Effect UI lacks that it works around.

## The component

- `init` and `update` (`src/init.ts`, `src/update.ts`) are pure functions that return a
  `Return`: the next Model and the Commands to run. `Viewer`'s `init` and `update` start a step
  with `$.set(model)` and `.run` each Command. `update` is wrapped in `withAddress`, which adds
  the history writes. Tests call `update(model, message)` directly, read `.model`, and read a
  Command's `name` and `args`.
- A struct in the Model changes with `UiStruct.evolve(struct, { field: (old) => next })`, which is
  what `$.evolve` does to the Model. It takes no union: match the union first.
- Messages (`src/message.ts`) and every tagged union in the Model are `UiSchema.TaggedEnum`: a
  Schema with one constructor per case (`Message.ClickedTask({ id })`, unchecked), `match`,
  `guards`, `is(tag)` and `isAnyOf`. A case's Schema is `Message.cases.X`.
- The trace as it loads is `TraceData` in `model.ts`: `Loading`, `Failure`, `Success` and
  `Stale` (the last good trace beside a failure). `loadedTraceOf` reads the trace from it, and
  `settledTrace(result)` folds a load's result in.
- Subscriptions are `subscriptions: ($) => [...]` (`src/subscription/`), each a
  `Subscription.make` over a Stream, or `Subscription.direct` for the presence socket.

## Commands

A Command is `Command.make(name, { args }, body)` at module level, in the file that issues it
(`command.ts`, `route.ts`, `update.ts`), and `update` issues it with `X.make(args)`. A Command with
no args takes `{ args: {} }` and is issued with `X.make()`. Its body returns the Message that says
it finished; the `Completed*` Messages stay until the components step, where `Command.asNoop` can
replace the ones nothing reads. A Story or a Scene answers one with `s.resolve(X, message)`, and
`s.expectExact(X)` checks what is pending.

The DOM Commands (`src/dom.ts`) look their element up by a selector: `focusElement`,
`scrollElementIntoView` and `scrollElementIntoViewAfterPaint`. Effect UI's own `HtmlCommand.focus`,
`scrollIntoView` and `waitForPaint` take a `Renderer.Ref`, and the views do not give their targets
refs yet, so keep the IDs and data attributes the selectors name (`SEARCH_INPUT_ID`, the detail
heading's). A Command starts once the render its update caused is committed; these wait one
animation frame more, two for the after-paint scroll, so a target the same Message brought into the
page has been laid out.

## The address

The viewer owns the address with no Router. A link is a list of steps of any length, which a
`Route` template does not describe, so `linkRoute` (`src/route.ts`) runs the path through the
contract's `LinkFromPath`. `src/url.ts` has `Url` (path, search and fragment), `urlFromString`
and `UrlRequest`. `subscription/address.ts` sends `ChangedUrl` on Back, Forward or a followed
fragment, and `ClickedLink` for a click on an anchor, which it cancels. `PushUrl` and `ReplaceUrl`
write history, and `LoadUrl` sends the page where the browser would. The code view's patch routes
(`codeView.ts`) are a `Route.union`, printed with `printPath`.

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

**The DOM is what the Scene tests read.** A view keeps its tags, classes, roles, labels, IDs, keys,
attributes, inline styles and Messages unless a test changes with it.

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
`effect-ui/controls.ts`, not `@effect/ui-kit`'s `Collapsible` and `Switch`: a Scene runs only the
component it starts from, so a click on a headless kit child fails there (report 3), and a click on
these reaches the viewer's `update`.

**Inline style.** Write `.attr("style", styleText({ ... }))` from `effect-ui/attributes.ts`, with
kebab-case names. Effect UI's `.style` writes `a:b;c:d`, and the Scene tests read `a: b; c: d`
(`styled`, `styleDeclaring`). Use `.style` in the components step.

**An attribute bundle**, a set of attributes several elements take, is a function that takes the
builder and returns it:

```ts
export const withSearched = <B>(builder: B & Attributable<B>, search: NodeSearch): B =>
  builder.attrs({ "data-searched": search.isActive ? "active" : ... });

withSearched(h.li.class("row"), search).children(...)
```

Type the parameter `B & Attributable<B>`, not `B extends Attributable<B>`: a bare `h.div` is a
callable shorthand that the `extends` form does not infer. Call `attrs` once; `B` has nothing else.

### Keys, empty children and lists

A keyed element is `.key(key)` on the builder.
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

A mount is `Mount.make` or `Mount.makeStream` at module level, issued with `.onMount`:
`.onMount(PressDivider({ pane }))`. A Scene acknowledges one with `s.expectMount(X(args))` and
answers it with `s.mounted(X, message)`; a mount nothing acknowledged fails the next message step.

### Lazy views

`createLazy` and `createKeyedLazy` become `memoView(h, fn, first, ...rest)`
(`src/effect-ui/memo.ts`), not `h.lazy`. `h.lazy` keeps its nodes in the component instance's
store, and a Scene draws a view without one, so under a Scene it builds every time and a test
cannot tell that a hover left a document alone (report 4). `memoView` keeps the last node of each
slot in the module instead, weakly, on its first argument: the slot is `fn` and `first`, the args
are compared with `===`, and a call with the same ones gives back the node it gave, which the
runtime's patch finds unchanged. `fn` is declared at module level as `(h, first, ...rest) => ...`
and depends only on its arguments, and `first` is an object (the trace, a section), so a keyed lazy
puts its key first. Pass plain values: an `Option` made fresh for each render never matches. A
reused node is the same object, so `sameNodes` in the wires scenes still sees the reuse. Move to
`h.lazy` when a Scene draws with a store.

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
naming rules say. Moving focus is a DOM Command over a selector (see Commands above) until the
components step gives targets `Html.ref`s.

## Tests

- A Scene test starts `viewerScene(model)` from `test/fixtures.ts` (an `HtmlScene` on `Viewer`),
  clicks with `HtmlLocator.role` and `Locator.attr`, and checks with `expect(locator)`. The
  fixtures answer the reader's mounts (`readerMounted`) and the history write (`pushedUrl`).
- A Story (`Story.make(Viewer, viewerProps)`) checks the Model and the pending Commands.
- `test/effect-ui/host.play.test.ts` runs the whole viewer on `TestHost`, where Commands run.

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
