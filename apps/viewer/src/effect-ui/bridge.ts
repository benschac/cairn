import { Command as UiCommand, Mount as UiMount, View } from "@effect/ui";
import type { Html as UiHtml } from "@effect/ui/html";
import {
  Array,
  Context,
  Effect,
  Function,
  MutableHashMap,
  MutableRef,
  Option,
  Predicate,
  Record,
  Schema,
  String,
  pipe,
} from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

// NOTE: `foldkit/html`'s public entry has no way to build a view under a dispatch the host owns.
// Foldkit's runtime, its server render and its Scene harness each push a frame with
// `__setRuntime`, which only the module behind that entry exports, and the package's `exports`
// map hides the module from a bare specifier. So the bridge names the file. It is the same module
// the public entry re-exports, so the frame stack is the one Foldkit's handlers read. The import
// goes when Foldkit does (`spec.viewer.effect-ui.foldkit-removal`).
import {
  FOLDKIT_MOUNT_KEY,
  __abandonRender,
  __beginRenderTransaction,
  __clearRuntime,
  __createBoundaryRegistry,
  __endRender,
  __htmlBuilder,
  __setRuntime,
} from "../../node_modules/foldkit/dist/html/index.js";

/**
 * Renders a Foldkit view under Effect UI, so the viewer can move one part of the screen at a time
 * (`spec.viewer.effect-ui`). `foldkitView` turns a Foldkit `Html` value into Effect UI nodes: each
 * element with its tag, attributes, properties, classes, styles and key, each text node, each
 * event handler, which sends the Message the Foldkit handler dispatches, and each `Mount`, which
 * becomes an Effect UI mount on the same element. The bridge runs one way: an Effect UI view holds
 * a Foldkit one, never the reverse.
 */

type VNode = NonNullable<Html>;

/** A Foldkit Mount definition whose results are the viewer's Messages. */
export type FoldkitMount<Msg> = Mount.MountDefinition<string, Msg>;

/** What the bridge needs to know about the program it renders. */
export interface FoldkitBridgeOptions<Msg> {
  /** The program's Messages: a handler that dispatches anything else is a bug the bridge reports. */
  readonly message: Schema.Schema<Msg>;
  /**
   * Every Foldkit Mount the bridged views issue. A vnode records only a Mount's name and args, so
   * the bridge finds the definition here by name and runs it on the element Effect UI mounts.
   */
  readonly mounts: ReadonlyArray<FoldkitMount<Msg>>;
}

/** A Foldkit Command, as `update` returns it: its name, its args, and the Effect whose result is a Message. */
export interface FoldkitCommand<Msg> {
  readonly name: string;
  readonly args?: Record.ReadonlyRecord<string, unknown> | undefined;
  readonly effect: Effect.Effect<Msg>;
}

/** The args of the Effect UI Command a Foldkit Command runs as: the Foldkit Command itself. */
export interface BridgedCommandArgs<Msg> {
  readonly command: FoldkitCommand<Msg>;
}

/** The Effect UI Command definition one Foldkit Command name becomes. */
export type BridgedCommand<Msg> = UiCommand.Factory<BridgedCommandArgs<Msg>, Msg>;

/** The args an Effect UI mount made from a Foldkit Mount carries: the Foldkit Mount's own args. */
export interface BridgedMountArgs {
  readonly args: unknown;
}

/** The Effect UI mount a Foldkit Mount becomes. */
export type BridgedMount<Msg> = UiMount.Factory<BridgedMountArgs, Msg, Element>;

export interface FoldkitBridge<Msg> {
  /**
   * Runs a Foldkit view under the bridge's dispatch, with a Foldkit `h`. A Foldkit handler closes
   * over the dispatch of the frame it was built in, so a view `foldkitView` renders is built here.
   * Call it once per render: it is one Foldkit render pass, whose lazy caches carry to the next.
   */
  readonly build: <A>(view: (h: HtmlBuilder<Msg>) => A) => A;
  /**
   * Runs an Effect UI view that holds bridged Foldkit views as one Foldkit render pass: every
   * `bridged` call inside it shares the pass, so `createKeyedLazy` keeps the entries any of them
   * used. Wrap a component's whole `view` in it, once per render.
   */
  readonly render: <A>(view: () => A) => A;
  /**
   * A Foldkit view as Effect UI nodes, built in the pass `render` opened: what an Effect UI view
   * calls for a child that has not moved yet. Outside `render` it builds its own pass, as `build`.
   */
  readonly bridged: (
    h: UiHtml.H<Msg>,
    view: (h: HtmlBuilder<Msg>) => Html,
  ) => View.Node<Msg> | null;
  /**
   * Several Foldkit nodes and bare strings as Effect UI children, built as `bridged` builds one:
   * what an Effect UI view calls for rendered markdown that is a list, such as a section's title.
   */
  readonly bridgedAll: (
    h: UiHtml.H<Msg>,
    view: (h: HtmlBuilder<Msg>) => ReadonlyArray<Html | string>,
  ) => ReadonlyArray<View.Node<Msg> | string>;
  /** A Foldkit `Html` value as Effect UI nodes; `null` is nothing, as Foldkit renders it. */
  readonly foldkitView: (h: UiHtml.H<Msg>, html: Html) => View.Node<Msg> | null;
  /** The Effect UI mount a Foldkit Mount definition becomes, for a Scene's `expectMount`. */
  readonly mountOf: (definition: FoldkitMount<Msg>) => BridgedMount<Msg>;
  /**
   * A Foldkit Command as an Effect UI Command, for `$.run`: the definition named after it, issued
   * with the Foldkit Command as its args, whose body runs the Foldkit Command's Effect.
   */
  readonly command: (command: FoldkitCommand<Msg>) => ReturnType<BridgedCommand<Msg>["make"]>;
  /** The Effect UI Command definition a Foldkit Command definition runs as, for a Story's `resolve`. */
  readonly commandOf: (definition: { readonly name: string }) => BridgedCommand<Msg>;
}

// --- dispatch ------------------------------------------------------------------------------

/**
 * What the bridged handlers dispatched while one Effect UI event ran: `Some` only inside
 * `captured`. Foldkit handlers dispatch synchronously, so the event that ran one is the one its
 * Message belongs to.
 */
const inbox = MutableRef.make<Option.Option<ReadonlyArray<unknown>>>(Option.none());

const dispatch = (message: unknown): void =>
  Option.match(MutableRef.get(inbox), {
    onNone: () => {
      throw new Error(
        "foldkitView: a bridged Foldkit handler dispatched outside the Effect UI event that ran it",
      );
    },
    onSome: (messages) => {
      MutableRef.set(inbox, Option.some(Array.append(messages, message)));
    },
  });

/** Runs `f` and returns what it dispatched. */
const captured = (f: () => void): ReadonlyArray<unknown> => {
  MutableRef.set(inbox, Option.some([]));
  try {
    f();
    return Option.getOrElse(MutableRef.get(inbox), Array.empty);
  } finally {
    MutableRef.set(inbox, Option.none());
  }
};

// --- events --------------------------------------------------------------------------------

/**
 * The events whose Foldkit handlers call `preventDefault` only when they dispatch:
 * `OnKeyDownPreventDefault`, `OnKeyUpPreventDefault` and `@foldkit/ui`'s key handlers. Effect UI's
 * `preventDefault: true` cancels the default exactly then. Every other bridged handler leaves the
 * default alone, as Foldkit's `OnClick`, `OnInput` and the rest do.
 */
const preventsWhenHandled: ReadonlyArray<string> = ["keydown", "keyup"];

const field = (payload: unknown, name: string): unknown =>
  Predicate.hasProperty(payload, name) ? payload[name] : undefined;

/**
 * A DOM-shaped event for a Foldkit handler, from the plain payload Effect UI gives a handler. It
 * holds the fields Foldkit's handlers read: the key and modifiers, the pointer's button, position
 * and type, and the value an `input` reports through `target`. Effect UI sends no host event, so
 * a field no payload carries, such as `pointerId` or a real `target` element, is missing.
 */
const eventOf = (type: string, payload: unknown, node: VNode): Record<string, unknown> => {
  const target = {
    checked: field(payload, "checked"),
    files: field(payload, "files"),
    open: field(payload, "open"),
    scrollLeft: field(payload, "left"),
    scrollTop: field(payload, "top"),
    value: field(payload, "value"),
  };
  return {
    altKey: field(payload, "alt") === true,
    button: field(payload, "button"),
    clientX: field(payload, "x"),
    clientY: field(payload, "y"),
    ctrlKey: field(payload, "ctrl") === true,
    currentTarget: node.elm,
    data: field(payload, "text"),
    defaultPrevented: false,
    inputType: field(payload, "inputType"),
    isComposing: field(payload, "composing") === true,
    key: field(payload, "key"),
    metaKey: field(payload, "meta") === true,
    newState: field(payload, "newState"),
    oldState: field(payload, "oldState"),
    pointerType: field(payload, "pointerType"),
    preventDefault: Function.constVoid,
    relatedTarget: null,
    repeat: field(payload, "repeat") === true,
    shiftKey: field(payload, "shift") === true,
    stopPropagation: Function.constVoid,
    target,
    type,
  };
};

/** Calls one Foldkit listener, or each of a list, as snabbdom's event module does. */
const callListeners = (listeners: unknown, event: Record<string, unknown>, node: VNode): void => {
  Array.forEach(Array.ensure(listeners), (listener) => {
    if (Predicate.isFunction(listener)) {
      listener(event, node);
    }
  });
};

// --- attributes ----------------------------------------------------------------------------

/** The properties Effect UI controls on its own elements; the bridge passes them as properties. */
const controlledProperties: ReadonlyArray<string> = [
  "value",
  "checked",
  "selected",
  "open",
  "indeterminate",
];

const isControlled = (name: string): boolean => Array.contains(controlledProperties, name);

/** Reflected properties whose attribute is not their lowercased name. */
const renamedProperties: Record.ReadonlyRecord<string, string> = {
  acceptCharset: "accept-charset",
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
};

/** Attributes whose value is the word `true` or `false`, not present or absent. */
const enumeratedAttributes: ReadonlyArray<string> = ["draggable", "spellcheck", "contenteditable"];

const attributeNameOf = (property: string): string =>
  Option.getOrElse(Record.get(renamedProperties, property), () => String.toLowerCase(property));

/** The attribute text of a Foldkit attribute or reflected property, or `None` to leave it off. */
const attributeText = (name: string, value: unknown): Option.Option<string> =>
  Predicate.isBoolean(value)
    ? Array.contains(enumeratedAttributes, name)
      ? Option.some(`${value}`)
      : value
        ? Option.some("")
        : Option.none()
    : Predicate.isNumber(value) || Predicate.isString(value)
      ? Option.some(`${value}`)
      : Option.none();

const kebabCase = (name: string): string =>
  String.startsWith("--")(name) || String.includes("-")(name)
    ? name
    : pipe(name, String.replaceAll(/[A-Z]/g, "-$&"), String.toLowerCase);

/** The `style` attribute of snabbdom's style record; `delayed`, `remove` and `destroy` are transitions. */
const styleText = (style: Record.ReadonlyRecord<string, unknown>): Option.Option<string> =>
  pipe(
    Record.toEntries(style),
    Array.map(([name, value]) =>
      Predicate.isString(value) &&
      String.isNonEmpty(value) &&
      !Array.contains(["delayed", "remove", "destroy"], name)
        ? Option.some(`${kebabCase(name)}: ${value}`)
        : Option.none(),
    ),
    Array.getSomes,
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map(Array.join("; ")),
  );

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const recordOf = (value: unknown): Record.ReadonlyRecord<string, unknown> =>
  isRecord(value) ? value : {};

interface Fields {
  readonly attrs: Record.ReadonlyRecord<string, string>;
  readonly props: Record.ReadonlyRecord<string, unknown>;
}

/**
 * An element's attributes and properties, from snabbdom's `attrs`, `class`, `dataset`, `style`
 * and `props`. Foldkit writes many attributes as reflected properties (`h.Id` sets `id`, `h.Type`
 * sets `type`), which Effect UI renders, and a test reads, as attributes. A controlled property
 * stays one, and a property with no attribute, such as one `h.Prop` sets, passes through.
 */
const fieldsOf = (data: Record.ReadonlyRecord<string, unknown>): Fields => {
  const properties = recordOf(data["props"]);
  const fromProps = Record.getSomes(
    Record.mapKeys(
      Record.map(
        Record.filter(properties, (_, name) => !isControlled(name)),
        (value, name) => attributeText(attributeNameOf(name), value),
      ),
      attributeNameOf,
    ),
  );
  const fromAttrs = Record.getSomes(
    Record.map(recordOf(data["attrs"]), (value, name) => attributeText(name, value)),
  );
  const fromDataset = Record.getSomes(
    Record.mapKeys(
      Record.map(recordOf(data["dataset"]), (value) =>
        Option.liftPredicate(value, Predicate.isString),
      ),
      (name) => `data-${kebabCase(name)}`,
    ),
  );
  const classes = pipe(
    Record.toEntries(recordOf(data["class"])),
    Array.filter(([, isOn]) => isOn === true),
    Array.map(([name]) => name),
  );
  const named = Record.union(
    Record.union(fromProps, fromAttrs, (_, attr) => attr),
    fromDataset,
    (_, dataset) => dataset,
  );
  const withClass = Array.isReadonlyArrayNonEmpty(classes)
    ? Record.set(
        named,
        "class",
        Array.join(Array.appendAll(Array.fromOption(Record.get(named, "class")), classes), " "),
      )
    : named;
  const attrs = Option.match(styleText(recordOf(data["style"])), {
    onNone: () => withClass,
    onSome: (style) => Record.set(withClass, "style", style),
  });
  const props = Record.filter(
    properties,
    (value, name) => isControlled(name) || Option.isNone(attributeText(name, value)),
  );
  return { attrs, props };
};

// --- nodes ---------------------------------------------------------------------------------

/**
 * Children as Effect UI keeps them: no empty text, and no two text nodes side by side, so the
 * server's HTML hydrates without separators. Snabbdom keeps a view's strings as it wrote them.
 */
const mergedText = <Msg>(children: ReadonlyArray<View.Node<Msg>>): ReadonlyArray<View.Node<Msg>> =>
  Array.reduce(children, Array.empty<View.Node<Msg>>(), (out, child) => {
    if (!Predicate.isTagged(child, "Text")) {
      return Array.append(out, child);
    }
    if (String.isEmpty(child.text)) {
      return out;
    }
    return Option.match(Array.last(out), {
      onNone: () => Array.append(out, child),
      onSome: (last) =>
        Predicate.isTagged(last, "Text")
          ? Array.append(Array.dropRight(out, 1), View.text(last.text + child.text))
          : Array.append(out, child),
    });
  });

/** A Foldkit node as Effect UI content: an element, a text node, or nothing for a comment. */
const isVNode = (value: unknown): value is VNode =>
  Predicate.hasProperty(value, "sel") || Predicate.hasProperty(value, "text");

/** A Foldkit Command: a name and an Effect. Its Effect's result is a Message, as `update` typed it. */
const isFoldkitCommand = <Msg>(value: unknown): value is FoldkitCommand<Msg> =>
  Predicate.hasProperty(value, "name") &&
  Predicate.isString(value.name) &&
  Predicate.hasProperty(value, "effect") &&
  Effect.isEffect(value.effect);

/**
 * Builds a bridge for one program. Make it once, at module level: the Effect UI mounts it makes
 * from the Foldkit ones keep their identity from one render to the next.
 */
export const makeFoldkitBridge = <Msg>(options: FoldkitBridgeOptions<Msg>): FoldkitBridge<Msg> => {
  const isMessage = Schema.is(options.message);
  const registry = __createBoundaryRegistry();

  const bridgedMounts: Record.ReadonlyRecord<string, BridgedMount<Msg>> = Record.fromEntries(
    Array.map(options.mounts, (definition) => [
      definition.name,
      UiMount.makeStream(
        definition.name,
        { args: { args: Schema.Unknown } },
        (node: Element, { args }) => definition(recordOf(args)).f(node, Mount.liveViewStateChanges),
      ),
    ]),
  );

  // Declared args compare by identity, which is right: each Foldkit Command value is new.
  const commandArgs = { command: Schema.declare(isFoldkitCommand<Msg>) };

  // One Effect UI definition per Foldkit Command name, made the first time a Command of that name
  // runs, so the message log and a Story name each Command as Foldkit did.
  const commandDefinitions = MutableHashMap.empty<string, BridgedCommand<Msg>>();

  const commandNamed = (name: string): BridgedCommand<Msg> =>
    Option.getOrElse(MutableHashMap.get(commandDefinitions, name), () => {
      const definition = UiCommand.make(
        name,
        { args: commandArgs },
        ({ command }) => command.effect,
      );
      MutableHashMap.set(commandDefinitions, name, definition);
      return definition;
    });

  const mountNamed = (name: string): BridgedMount<Msg> =>
    Option.getOrThrowWith(
      Record.get(bridgedMounts, name),
      () => new Error(`foldkitView: the Foldkit Mount ${name} was not given to the bridge`),
    );

  const messageOf = (messages: ReadonlyArray<unknown>): Msg | undefined =>
    Option.getOrUndefined(
      Option.map(Array.head(messages), (message) => {
        if (!isMessage(message)) {
          throw new Error(
            "foldkitView: a bridged Foldkit handler dispatched a value that is not a Message",
          );
        }
        return message;
      }),
    );

  const handlersOf = (node: VNode, on: Record.ReadonlyRecord<string, unknown>) =>
    Record.map(
      on,
      (listeners, type) =>
        (payload: unknown): Msg | undefined =>
          messageOf(captured(() => callListeners(listeners, eventOf(type, payload, node), node))),
    );

  const mountFor = (marker: unknown): View.Mount<Msg> | undefined =>
    Option.getOrUndefined(
      Option.map(Option.liftPredicate(field(marker, "name"), Predicate.isString), (name) =>
        mountNamed(name)({ args: field(marker, "args") }),
      ),
    );

  // NOTE: `createLazy` and `createKeyedLazy` hand back the VNode of the last render when their
  // inputs are the same, so a VNode the bridge has seen converts to the node it gave last time.
  // A render that keeps most of the screen then converts only what changed, and Effect UI's patch
  // finds the same node objects. Keyed by identity and weakly, so a VNode Foldkit drops is freed.
  const converted = new WeakMap<VNode, View.Node<Msg> | null>();

  const nodeOf = (vnode: VNode): View.Node<Msg> | null =>
    Option.getOrElse(Option.fromUndefinedOr(converted.get(vnode)), () => {
      const node = convert(vnode);
      converted.set(vnode, node);
      return node;
    });

  const convert = (vnode: VNode): View.Node<Msg> | null => {
    if (Predicate.isUndefined(vnode.sel)) {
      return View.text(Option.getOrElse(Option.fromNullishOr(vnode.text), () => ""));
    }
    if (vnode.sel === "!") {
      return null;
    }
    const data = recordOf(vnode.data);
    const { attrs, props } = fieldsOf(data);
    const on = recordOf(data["on"]);
    const children = Predicate.isUndefined(vnode.children)
      ? Array.map(Array.fromNullishOr(vnode.text), View.text)
      : Array.getSomes(
          Array.map(vnode.children, (child) =>
            isVNode(child)
              ? Option.fromNullOr(nodeOf(child))
              : Option.some<View.Node<Msg>>(View.text(child)),
          ),
        );
    return {
      _tag: "Element",
      attrs,
      children: mergedText(children),
      elementKey:
        Predicate.isString(vnode.key) || Predicate.isNumber(vnode.key) ? `${vnode.key}` : undefined,
      eventOptions: Record.fromEntries(
        Array.map(
          Array.filter(Record.keys(on), (type) => Array.contains(preventsWhenHandled, type)),
          (type) => [type, { preventDefault: true }],
        ),
      ),
      handlers: handlersOf(vnode, on),
      mount: mountFor(data[FOLDKIT_MOUNT_KEY]),
      props,
      refKey: undefined,
      tag: vnode.sel,
    };
  };

  /** Whether a `render` pass is open, so `bridged` builds in it rather than in a pass of its own. */
  const isRendering = MutableRef.make(false);

  const build = <A>(view: (h: HtmlBuilder<Msg>) => A): A => {
    // As Foldkit's runtime renders: one registry across renders, so a lazy view built with the
    // same arguments hits, and a transaction around each render, so a failed one is undone.
    __beginRenderTransaction(registry);
    __setRuntime(dispatch, Context.empty(), registry);
    try {
      const html = view(__htmlBuilder<Msg>());
      __endRender(registry);
      return html;
    } catch (cause) {
      __abandonRender(registry);
      throw cause;
    } finally {
      __clearRuntime();
    }
  };

  /** One Foldkit view built under the dispatch frame, inside the pass that is open. */
  const buildInPass = <A>(view: (h: HtmlBuilder<Msg>) => A): A => {
    __setRuntime(dispatch, Context.empty(), registry);
    try {
      return view(__htmlBuilder<Msg>());
    } finally {
      __clearRuntime();
    }
  };

  const foldkitView = (_h: UiHtml.H<Msg>, html: Html): View.Node<Msg> | null =>
    html === null ? null : nodeOf(html);

  return {
    build,
    render: (view) => {
      __beginRenderTransaction(registry);
      MutableRef.set(isRendering, true);
      try {
        const rendered = view();
        __endRender(registry);
        return rendered;
      } catch (cause) {
        __abandonRender(registry);
        throw cause;
      } finally {
        MutableRef.set(isRendering, false);
      }
    },
    bridged: (h, view) =>
      foldkitView(h, MutableRef.get(isRendering) ? buildInPass(view) : build(view)),
    bridgedAll: (h, view) =>
      Array.getSomes(
        Array.map(MutableRef.get(isRendering) ? buildInPass(view) : build(view), (child) =>
          Predicate.isString(child) ? Option.some(child) : Option.fromNullOr(foldkitView(h, child)),
        ),
      ),
    foldkitView,
    mountOf: (definition) => mountNamed(definition.name),
    command: (command) => commandNamed(command.name).make({ command }),
    commandOf: (definition) => commandNamed(definition.name),
  };
};
