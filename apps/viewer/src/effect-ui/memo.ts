import { View } from "@effect/ui";
import { Array, Function, Option } from "effect";

/**
 * What a memoised call last built: the function, the arguments it was called with and the node.
 */
interface Entry {
  readonly args: ReadonlyArray<unknown>;
  readonly node: unknown;
}

// NOTE: the entries hang off the first argument, weakly, so a trace the viewer has dropped takes
// its entries with it. A slot is the function and its first argument, as `h.lazy`'s is.
const slots = new WeakMap<object, WeakMap<object, Entry>>();

/**
 * `h.lazy`, where a Scene can see it. `h.lazy` keeps its nodes in the instance's store, and a
 * Scene draws a view without one, so there it builds every time and a test cannot tell that a
 * hover left a document alone. This keeps the last node of each slot instead, in the module: the
 * slot is `fn` and its first argument, the arguments are compared with `===`, and a call with
 * the same ones gives back the node it gave, which the runtime's patch finds unchanged.
 *
 * `fn` is declared at module level, as `(h, first, ...rest)`, and depends only on its arguments.
 * Give it the plain values `h.lazy` would get: an `Option` made fresh for each render never
 * matches. Move to `h.lazy` when a Scene draws with a store.
 */
export const memoView = <H, First extends object, Rest extends ReadonlyArray<unknown>, Msg, R>(
  h: H,
  fn: (h: H, first: First, ...rest: Rest) => View.Content<Msg, R>,
  first: First,
  ...rest: Rest
): View.Node<Msg, R> => {
  const args: ReadonlyArray<unknown> = Array.prepend(rest, first);
  const bySlot = Option.getOrElse(Option.fromNullishOr(slots.get(first)), () => {
    const created = new WeakMap<object, Entry>();
    slots.set(first, created);
    return created;
  });
  return Option.match(
    Option.filter(
      Option.fromNullishOr(bySlot.get(fn)),
      (entry) =>
        Array.length(entry.args) === Array.length(args) &&
        Array.every(args, (arg, index) => arg === entry.args[index]),
    ),
    {
      onNone: () => {
        const node = View.toNode(fn(h, first, ...rest));
        bySlot.set(fn, { args, node });
        return node;
      },
      onSome: (entry) => Function.cast(entry.node),
    },
  );
};
