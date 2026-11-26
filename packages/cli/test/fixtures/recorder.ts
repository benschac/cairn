import { Array, Context, Effect, Layer, Ref } from "effect";

/** What a recorder keeps: everything it was given, in order. */
export interface Recording<A> {
  readonly record: (item: A) => Effect.Effect<void>;
  readonly seen: Effect.Effect<ReadonlyArray<A>>;
}

/** The class `Recorder` returns: the key of a `Recording` of `A`, and a layer that starts it empty. */
export interface Recorder<Self, Id extends string, A> extends Context.ServiceClass<
  Self,
  Id,
  Recording<A>
> {
  readonly layer: Layer.Layer<Self>;
}

/**
 * A service that records what a test double was given, so the test can read it back.
 * `class Wire extends Recorder<Wire, Request>()("@cairn/cli/test/Wire") {}` declares one, and
 * `Wire.layer` provides it empty.
 */
export const Recorder =
  <Self, A>() =>
  <const Id extends string>(id: Id): Recorder<Self, Id, A> => {
    const Key = Context.Service<Self, Recording<A>>()(id);
    class Tag extends Key {
      static readonly layer = Layer.effect(
        Tag,
        Effect.map(Ref.make<ReadonlyArray<A>>([]), (items) =>
          Tag.of({ record: (item) => Ref.update(items, Array.append(item)), seen: Ref.get(items) }),
        ),
      );
    }
    return Tag;
  };
