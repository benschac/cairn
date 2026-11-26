# Effect checklist

Run this list while you write code in this repository and again over your diff before you commit. Every package, app and script that imports `effect` is Effect code. Use the core modules there instead of native JavaScript.

Each row gives the smell, the Effect API that replaces it, and where to read that API. The APIs were checked against the installed `effect@4.1.5`. Read the declaration before you call an export, because argument order and data-first or data-last forms differ between modules:

```sh
rg -n '^\| Array \| (dedupeWith|cartesian) \|' .agent_sources/effect/core-index.md   # gives Start and End
sed -n '<Start>,<End>p' node_modules/effect/dist/Array.d.ts
```

The **Check** column names what enforces a row: a `core/*` rule from `lint/effect-core-plugin.mjs` or an `@effect/tsgo` diagnostic set in `tsconfig.base.json`. A row with no check is a review item, and you are the check. [native-to-effect.md](native-to-effect.md) has the one-line replacement for each native call.

## Scan your diff

Run these over the lines you added. Every hit is either a row below or a case you can justify.

```sh
# lines you added since the branch below yours (main for a single branch), committed or not
base=main
added() { git diff "$base" -U0 -- packages apps scripts | rg '^\+[^+]'; }
added | rg 'new (Map|Set)\b|Map\.groupBy|Object\.(keys|values|entries|fromEntries|hasOwn|assign|groupBy)'  # collections
added | rg '\[\.\.\.|Array\.(from|of)\('                                    # spreads and native builders
added | rg '\b(for|while)\s*\(|\bdo\s*\{'                                      # loops
added | rg '\?\?|\?\.|[!=]== (null|undefined)'                                 # absence handled by hand
added | rg '\.length\b|\[0\]|\[\w+ - 1\]|\.at\('                              # emptiness and indexing
added | rg 'switch \(|typeof |instanceof |else if'                           # branching
added | rg '\{ ?\.\.\.\w+|Object\.assign'                                     # object spread updates
added | rg 'JSON\.|Date\.|Math\.(random|max|min)|console\.|process\.(env|exit|argv)|setTimeout|setInterval|new Promise|async |await |fetch\('
added | rg 'class \w+ extends Error|throw |try \{|catch \('                    # errors
added | rg 'Schema\.(decode|encode)\w*Sync|as unknown as|as any|: any\b'       # boundaries and casts
```

The checks that `pnpm check` runs catch most of the first five lines. The rest are review items.

## Data and collections

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `xs.map`, `.filter`, `.flatMap`, `.some`, `.every`, `.join`, `.forEach`, `.findIndex`, `.includes` on an array | `Array.map(xs, f)`, `Array.filter`, `Array.flatMap`, `Array.some`, `Array.every`, `Array.join(xs, sep)`, `Array.forEach`, `Array.findFirstIndex` (`Option`), `Array.contains`. All are dual: `Array.map(xs, f)` or `pipe(xs, Array.map(f))`. Callbacks get `(a, i)` only | `preferEffectArray` | `core-index.md` rows `Array` |
| `for`, `for-of`, `for-in`, `while`, `do-while` | Pure: `Array.map`, `Array.filterMap`, `Array.reduce(xs, init, f)`, `Array.mapAccum` (state and output), `Array.scan`, `Array.forEach` for an assertion or a side effect. Effects: `Effect.forEach`, `Effect.reduce`. Sequences: `Array.makeBy(n, f)`, `Array.range(a, b)`, `Array.unfold(seed, f)`. Nested loops over pairs: `Array.cartesian(a, b)`. A loop that must stop early, poll or walk by index stays, with `// loop: <reason>` on the line above | `core/no-native-loop`, `core/no-yield-in-loop` | `packages/core/test/task-machine.test.ts` (`Array.cartesian`), `apps/viewer/test/demo.test.ts` (`Array.mapAccum`) |
| `[...a, ...b]`, `[...xs, x]`, `[x, ...xs]`, `[...iterable]`, `Array.from(it)`, `Array.of` | `Array.appendAll(a, b)`, `Array.append(xs, x)`, `Array.prepend(xs, x)`, `Array.flatten([a, b, c])`, `Array.fromIterable(it)`, `Array.copy(xs)`, `Array.make(a, b)`; an optional element, `Option.toArray(o)` | `core/no-array-spread` | `packages/contract/src/trailers.ts` |
| `new Map`, `new Set`, `Map.groupBy`, `Object.groupBy` | String keys: `Record.fromIterableWith(xs, (x) => [k, v])`, `Record.fromIterableBy(xs, key)`, read with `Record.get` (`Option`). Grouping: `Array.groupBy(xs, key)` (a `Record` of non-empty arrays). Unique: `Array.dedupe`, `Array.dedupeWith(xs, eq)`. Membership or non-string keys: `HashSet.fromIterable`, `HashSet.has`, `HashMap.fromIterable`, `HashMap.get` (immutable, `Equal`-based). Mutable local state only: `MutableHashMap`, `MutableHashSet` | `core/no-native-collection`, `core/no-set-dedupe` | `apps/viewer/src/trace.ts` (`HashSet`), `packages/core/src/section-ids.ts` |
| `xs.length === 0`, `xs.length > 0`, `!xs.length`, `if (xs.length)` | `Array.isReadonlyArrayNonEmpty(xs)` narrows to `NonEmptyReadonlyArray`, after which `Array.headNonEmpty`, `Array.lastNonEmpty`, `Array.max` need no `Option`; `Array.isReadonlyArrayEmpty`; both branches, `Array.match(xs, { onEmpty, onNonEmpty })`. Strings: `String.isEmpty`, `String.isNonEmpty` | `core/no-length-check`, `strictBooleanExpressions` | `Array` rows `isReadonlyArrayNonEmpty`, `match` |
| `xs[0]`, `xs[xs.length - 1]`, `xs[i] ?? d`, `xs.at(-1)` | `Array.head`, `Array.last`, `Array.get(xs, i)` (all `Option`); non-empty, `Array.headNonEmpty`, `Array.lastNonEmpty` | `noUncheckedIndexedAccess` makes the native form `T \| undefined` | `Array` rows `head`, `get` |
| A `Map` keyed by id just to drop duplicates | `Array.dedupeWith(xs, (a, b) => a.id === b.id)` | | `Array` row `dedupeWith` |
| Hand-written zip, chunk, window, prefix split | `Array.zip`, `Array.zipWith`, `Array.chunksOf`, `Array.window`, `Array.span`, `Array.takeWhile`, `Array.dropWhile`, `Array.splitWhere`, `Array.partition` | | `Array` rows |
| `Math.max(...xs)`, a `let` total | `Array.max(xs, Order.Number)` (non-empty only), `Number.sumAll(xs)` | | [native-to-effect.md](native-to-effect.md) |
| `.sort(...)`, `.toSorted(...)` | `Array.sort(xs, Order.Number)`, `Array.sortWith(xs, key, order)`, `Array.sortBy(...orders)` | `core/no-native-sort` | `Order` rows |
| `s.trim()`, `.split`, `.slice`, `.startsWith`, `.replace`, `.toLowerCase` | `String.trim(s)`, `String.split(s, sep)` (dual, returns a `NonEmptyArray`), `String.slice(start, end)(s)`, `String.startsWith(prefix)(s)`, `String.replace(pattern, with)(s)`: most `String` functions are data-last only, so call them curried or in a `pipe` | `preferEffectString` | `String` rows |

## Option and absence

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `x ?? fallback`, `x?.y ?? d` on a value that may be missing | `Option.fromNullishOr(x)`, then `Option.map`, `Option.flatMap`, `Option.getOrElse(o, () => d)`; `Option.fromNullOr`, `Option.fromUndefinedOr` for one kind of absence | | `Option` rows |
| A function that returns `T \| undefined` or `T \| null` | Return `Option<T>`; wrap a nullable function with `Option.liftNullishOr(f)`; a predicate, `Option.liftPredicate` | | `Option` rows |
| `if (o._tag === "Some")`, `Option.isSome` then `.value` | `Option.match(o, { onNone, onSome })`, `Option.map`, `Option.getOrElse` | | `apps/viewer/src/trace.ts`, `apps/viewer/src/markdown.ts` |
| Several optionals combined by hand | `Option.all([a, b])` or `Option.all({ a, b })`, `Option.zipWith`, `Option.firstSomeOf`, `Option.orElse` | | `apps/viewer/src/markdown.ts` (`Option.all`) |
| `.map(f).filter((x) => x != null)` | `Array.flatMapNullishOr(xs, f)`; `Option` results, `Array.getSomes(Array.map(xs, f))` | | [native-to-effect.md](native-to-effect.md) |
| `x === null`, `x !== undefined` checks in a condition | `Predicate.isNotNull`, `Predicate.isNotUndefined`, `Predicate.isNotNullish`; better, decode to `Option` at the boundary (`Schema.OptionFromNullOr`, `Schema.OptionFromNullishOr`) | `strictBooleanExpressions` for truthiness | `Predicate` rows |

## Branching

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `switch` | `Match.value(x).pipe(Match.when(...), Match.exhaustive)`; a `_tag` union, `Match.valueTags(x, { A: ..., B: ... })` or `Match.tag`; a reusable matcher, `Match.type<T>()`; a Schema union, `Schema.toTaggedUnion("kind")` and its `.match` | `core/no-switch` | `apps/viewer/src/markdown.ts` (`Match.type`), `apps/viewer/src/trace.ts` (`Node.match`) |
| `if`/`else if` chains or nested ternaries over a literal union or a `kind` field | `Match` as above, ending in `Match.exhaustive` so a new case fails to compile; `Match.orElse` only for an open set | | `Match` rows `when`, `tag`, `exhaustive` |
| `typeof x === "string"`, a hand-written `isRecord` | `Predicate.isString`, `isNumber`, `isBoolean`, `isFunction`, `isObject`, `isReadonlyObject`, `isUndefined`, `hasProperty`, `isTagged`; compose with `Predicate.and`, `Predicate.or`, `Predicate.not`; a value with a schema, `Schema.is(schema)` | `core/no-typeof-check` | `node_modules/effect/ai-docs/src/10_predicate/` |
| Non-boolean conditions: `if (s)`, `if (xs.length)`, `cond ? a : b` on a number | An explicit boolean: `String.isNonEmpty(s)`, `Array.isReadonlyArrayNonEmpty(xs)`, `Predicate.isNotUndefined(x)` | `strictBooleanExpressions` | |
| `x instanceof SchemaClass` | `Schema.is(SchemaClass)(x)` | `instanceOfSchema` | |

## Records and structs

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `Object.keys`, `Object.values`, `Object.entries`, `Object.fromEntries` | `Record.keys`, `Record.values`, `Record.toEntries`, `Record.fromEntries`, `Record.map`, `Record.filter`, `Record.filterMap`, `Record.reduce`, `Record.collect` | `preferEffectRecord` | `Record` rows |
| `obj[key]`, `key in obj`, `Object.hasOwn(obj, key)` on a dynamic key | `Record.get(r, key)` (`Option`), `Record.has(r, key)` | `preferEffectRecord` for `Object.*` | `apps/viewer/src/trace.ts` (`Record.get`) |
| `{ ...r, [k]: v }`, `delete r[k]` | `Record.set(r, k, v)`, `Record.remove(r, k)`, `Record.modify(r, k, f)`, `Record.union` | | `Record` rows |
| `{ ...s, x: f(s.x) }` updating fields of a struct | `Struct.evolve(s, { x: f })`; pick and omit, `Struct.pick(s, ["a"])`, `Struct.omit(s, ["a"])`; rename, `Struct.renameKeys` | | `packages/core/src/room-machine.ts` (`Struct.evolve`), `packages/cli/test/presence.test.ts` (`Struct.omit`) |

## Equality and ordering

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A comparator `(a, b) => a.x - b.x` | `Order.mapInput(Order.Number, (a) => a.x)`, `Order.Struct({ ... })`, `Order.combine`, `Order.flip`; `Order.max`, `Order.min`, `Order.clamp` | `core/no-native-sort` | `Order` rows |
| Deep equality by hand, `JSON.stringify(a) === JSON.stringify(b)` | `Equal.equals(a, b)` on Effect data (`Data`, Schema classes, `HashSet`, `HashMap`, `Option`); `Equivalence.mapInput`, `Equivalence.Struct`, `Struct.makeEquivalence` for plain shapes | `globalJson` | `Equal`, `Equivalence` rows |
| Value objects compared by reference | `Data.Class`, `Data.TaggedClass`, `Data.taggedEnum`, or a Schema class: they implement `Equal` | | `Data` rows |

## Schema

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A `type` or `interface` for data that crosses a boundary (file, socket, URL, CLI, Model) | A schema in `packages/contract`, with `typeof X.Type`. Do not redeclare a contract type | | `packages/contract/src/` |
| A discriminated union written by hand | `Schema.Union([...]).pipe(Schema.toTaggedUnion("kind"))`, then `.match`, `.guards`; `Schema.TaggedStruct` for a `_tag` member | `schemaStructWithTag` (advisory) | `packages/contract/src/judgments.ts`, `apps/viewer/src/trace.ts` |
| An id that is just `string` | `Schema.String.pipe(Schema.check(Schema.isPattern(...)), Schema.brand("TaskId"))` | | `packages/contract/src/ids.ts` |
| Validation with `if` and `throw` | `Schema.check(Schema.isMinLength(1), ...)`, `Schema.isGreaterThanOrEqualTo`, `Schema.isPattern`, `Schema.NonEmptyString`, `Schema.Finite`, `Schema.Int`; a custom rule, `Schema.makeFilter` | | `Schema` rows `check`, `is*` |
| `JSON.parse`, `as Foo` on unknown input | `Schema.decodeUnknownEffect(Schema.fromJsonString(Foo))`; `Schema.decodeUnknownSync` only at module load for a bundled asset or in a test | `globalJson`, `globalJsonInEffect`, `schemaSync` (advisory) | `packages/contract/src/index.ts` (`PresenceJson`), `packages/cli/src/presence.ts` |
| A class with a constructor that checks fields | `Schema.Class<X>("X")({ ... })`, `Schema.TaggedClass`; build with `X.make(...)` | `newSchemaClass` (advisory) | `node_modules/effect/ai-docs/src/01_effect/02_schema/` |
| Hand-written test fixtures | `it.prop` with the contract schemas, or `Arbitrary.schema(S)` | | `apps/viewer/test/trace.test.ts`, `apps/viewer/test/demo.test.ts` |

## Effects and errors

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A function that returns `Effect.gen(...)` | `Effect.fn("name")(function* (...) {...}, ...combinators)`, or `Effect.fnUntraced` | `effectFnOpportunity` (advisory) | `packages/cli/src/presence.ts` (`Room.join`), `node_modules/effect/AGENTS.md` |
| `class X extends Error`, `throw`, `try`/`catch` | `class X extends Schema.TaggedError<X>()("X", { ... }) {}`; `return yield* new X(...)`; `Effect.try({ try, catch })`, `Effect.tryPromise` | `extendsNativeError`, `tryCatchInEffectGen` | `packages/contract/src/trailers.ts`, `scripts/land/land.ts` |
| `Effect.catch` with an `if` on `_tag` | `Effect.catchTag("X", f)`, `Effect.catchTag(["X", "Y"], f)`, `Effect.catchTags({ X: f, Y: g })`; `Effect.mapError`, `Effect.tapError`, `Effect.orElseSucceed`, `Effect.ignore` | `catchIfTagToCatchTag` and other `catch*` style diagnostics (advisory) | `scripts/land/land.ts` (`catchTags`), `node_modules/effect/ai-docs/src/01_effect/04_errors/` |
| `Promise`, `async`, `await`, `new Promise` | `Effect.gen`, `Effect.tryPromise`, `Effect.callback` | `newPromise`, `asyncFunction` (advisory) | `ai-docs/src/01_effect/01_basics/10_creating-effects.ts` |
| `Effect.runPromise` inside an effect | `yield*` it; a program entry, `NodeRuntime.runMain` | `runEffectInsideEffect` | `scripts/land/land.ts` |

## Services and layers

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A module-level singleton, a function that takes its dependencies as arguments | `class X extends Context.Service<X, {...}>()("cairn/...") { static readonly layer = Layer.effect(X, ...) }`; build with `X.of({...})` | | `packages/cli/src/presence.ts` (`Room`), `ai-docs/src/01_effect/03_services/` |
| `Effect.provide` scattered through a program | Compose with `Layer.provide`, `Layer.provideMerge`, `Layer.mergeAll`; provide once at the entry | `strictEffectProvide` (advisory), `multipleEffectProvide` | `packages/cli/src/serve.ts` |
| A long-running server started by hand | `Layer.launch`, `NodeHttpServer.layerConfig` | | `packages/cli/src/serve.ts` |

## Resources and scopes

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| Open and close by hand, `finally`, a forgotten `removeEventListener` | `Effect.acquireRelease(acquire, release)`, `Effect.addFinalizer`, `Effect.scoped`; `Stream.fromEventListener` removes its listener | | `apps/viewer/src/presence.ts`, `packages/cli/src/presence.ts` |
| A fiber started and never stopped | `Effect.forkScoped` ties it to the scope | | `packages/cli/src/presence.ts` |

## Concurrency

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| Independent effects run one after another | `Effect.forEach(xs, f, { concurrency: n \| "unbounded" })`, `Effect.all(..., { concurrency })`; `{ discard: true }` when the results are unused | `missingConcurrencyOption` (advisory) | `scripts/land/land.ts` |
| A `let` shared between fibers | `Ref.make`, `Ref.update`, `Ref.updateAndGet`, `Ref.modify`; state others watch, `SubscriptionRef.make` and `SubscriptionRef.changes` | | `packages/cli/src/presence.ts` (`Ref.updateAndGet`) |
| A hand-rolled buffer or event bus | `Queue.bounded`, `Queue.unbounded`, `Queue.offer`, `Queue.take`; fan-out, `PubSub` | | `ai-docs/src/01_effect/07_pubsub/` |
| Waiting on another fiber's result | `Deferred.make`, `Deferred.succeed`, `Deferred.await`; `Fiber.join`, `Fiber.interrupt` | | `Deferred`, `Fiber` rows |

## Stream

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| Event listeners, callbacks, sockets or polling that push values | `Stream.fromEventListener`, `Stream.callback`, `Stream.fromQueue`, `Stream.fromPubSub`, `Stream.fromEffectSchedule`; transform with `Stream.map`, `Stream.filterMap`, `Stream.mapEffect`, `Stream.merge`, `Stream.debounce`, `Stream.throttle`; run with `Stream.runForEach`, `Stream.runCollect`, `Stream.runDrain` | | `apps/viewer/src/presence.ts`, `ai-docs/src/03_stream/` |

## Time, schedules and config

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `Date.now()`, `new Date()` | `Clock.currentTimeMillis`, `DateTime.now`, `DateTime.formatIso`; a schema field, `Schema.DateTimeUtcFromString` | `globalDate`, `globalDateInEffect` | `packages/contract/src/events.ts`, `ai-docs/src/07_datetime/` |
| A number of milliseconds | `Duration.seconds(30)`, `Duration.millis`, `Duration.minutes` | | `scripts/agent-sources/refresh-pattern-sources.ts` |
| `setTimeout`, `setInterval`, a retry loop | `Effect.sleep`, `Effect.timeout`, `Effect.repeat({ schedule, until })`, `Effect.retry` with `Schedule.spaced`, `Schedule.exponential`, `Schedule.recurs`, `Schedule.during`, `Schedule.jittered` | `globalTimers`, `globalTimersInEffect` | `scripts/land/land.ts` (`Schedule.during`), `ai-docs/src/06_schedule/` |
| `process.env.X` | `Config.String("X")`, `Config.Port`, `Config.Int`, `Config.Boolean`, `Config.Redacted`, `Config.withDefault`, `Config.option`, `Config.schema` | `processEnv`, `processEnvInEffect` | `packages/cli/src/serve.ts` |

## Logging and output

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `console.log` for diagnostics | `Effect.log`, `Effect.logInfo`, `Effect.logDebug`, `Effect.logWarning`, `Effect.annotateLogs`; a logfmt logger on stderr, `Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])` | `globalConsole`, `globalConsoleInEffect` | `scripts/agent-sources/index-xstate-docs.ts`, `ai-docs/src/08_observability/` |
| Printing a program's result | `Console.log` | | `scripts/land/land.ts` |

## Platform

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| `node:fs`, `node:path`, `fileURLToPath` | `FileSystem.FileSystem` (`readFileString`, `writeFileString`, `readDirectory`, `exists`), `Path.Path` (`join`, `resolve`, `fromFileUrl`), provided by `NodeServices.layer` | `nodeBuiltinImport` (advisory) | `scripts/agent-sources/index-xstate-docs.ts` |
| `child_process` | `ChildProcess.make(cmd, args, { cwd })` from `effect/process` through `ChildProcessSpawner` | | `scripts/land/land.ts`, `ai-docs/src/60_child-process/` |
| `fetch` | `HttpClient.HttpClient`, `HttpClient.filterStatusOk`, `FetchHttpClient.layer` from `effect/http` | `globalFetch`, `globalFetchInEffect` | `scripts/agent-sources/refresh-pattern-sources.ts`, `ai-docs/src/50_http-client/` |
| `process.argv`, top-level `await`, `process.exit` | `Command.make` with `Flag` and `Argument` from `effect/cli`, `Command.run`, `NodeRuntime.runMain` | | `scripts/agent-sources/index-xstate-docs.ts` |

Each unstable module you import must be listed in `allowedUnstableApis` in that project's `tsconfig.json`.

## Effect UI viewer

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| Model fields typed by hand | A Schema-defined `Model`; Messages as fact-named schemas (`ReceivedPresence`, not `SetPresence`) | | `apps/viewer/src/model.ts` |
| Side effects in `update` | Return a Command (`Command.make(name, { args }, body)` from `@effect/ui`): an Effect that yields a Message | | `apps/viewer/EFFECT-UI.md`, `.agent_sources/effect-ui/index.md` |
| `addEventListener` or a socket in a view | A subscription: `Subscription.make(name, deps, build)` with its stream from `Stream.fromEventListener` and `Effect.acquireRelease` | | `apps/viewer/src/presence.ts` |
| A view that takes the data before `h`, or writes a return type | `fooView(h, data)` returns the builder with no return type, so `memoView` and `h.lazy` can call `fn(h, ...args)` | | `apps/viewer/src/view/linkNoticeView.ts` |
| An empty array as a child, or a conditional child written as `[]` | A hole: `false`, `null` or `undefined`; `Array.match` with `onEmpty: () => null`; `Option.getOrUndefined` for an optional child | | `apps/viewer/EFFECT-UI.md` "Keys, empty children and lists" |
| Child arrays built with spreads | `Array.map` into `.children(...)` (an array is flattened), `Array.flatten` for a list of lists, `Array.getSomes` for optional children | `core/no-array-spread` | `apps/viewer/src/view/searchView.ts` |
| A conditional attribute written with a spread or a ternary builder | `.attr(name, undefined)` leaves the attribute off; an attribute bundle is a function from the builder to the builder | | `apps/viewer/EFFECT-UI.md` "A view function" |
| A colour, a size or a timing written in a view | The names of `spec.viewer.design-system`: a class, or `.attr("style", styleText({ ... }))` from `effect-ui/attributes.ts` | | `apps/viewer/src/effect-ui/attributes.ts` |
| Reading a DOM event in a handler | The payload (`({ value }) => Message...`, `({ key }) => ...`); return `undefined` to ignore the event; a gesture that needs more is a mount on the element | | `apps/viewer/EFFECT-UI.md` "Event data" |
| A view test that calls `update` or inspects internals | `HtmlScene` from `@effect/ui/html/testing`: click what a person clicks, assert on what the view shows; `Story` for the Messages and Commands an update produces | | `apps/viewer/test/` |

## XState machines

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A lifecycle tracked with flags | A machine built with `setupEffect` from `@xstate/effect`, context and events from the contract schemas | | `packages/core/src/task-machine.ts`, `.agent_sources/xstate-effect/index.md` |
| An Effect written inline in the machine config | Declare it in `setupEffect`'s implementations and refer to it by name | `xstate-effect/no-inline-effect` | `packages/core/node_modules/@xstate/effect/README.md` |
| Context updated with object spreads | `Struct.evolve`, `Array.filter`, `Array.map` in `assign` | | `packages/core/src/room-machine.ts` |

## Tests

| Smell | Effect API | Check | Read |
| --- | --- | --- | --- |
| A handful of example inputs | `it.prop(name, [Schema, ...], ([a]) => ...)` from `@effect/vitest`, generated from the contract schemas; `it.effect.prop` for an effectful property | | `apps/viewer/test/trace.test.ts`, `apps/viewer/test/demo.test.ts` |
| `Effect.runPromise` in a test | `it.effect(name, () => Effect.gen(...))`; shared services, `layer(X.layer)("name", (it) => ...)` | `floatingEffectInVitest` | `packages/core/test/task-machine.test.ts`, `ai-docs/src/09_testing/` |
| Real sleeps or timeouts in a test | `TestClock.adjust(Duration.seconds(n))`, `TestClock.setTime` from `effect/testing/TestClock`; `it.effect` provides the test clock, `it.live` the real one | | `node_modules/effect/dist/testing/TestClock.d.ts` |
| A loop of `expect` calls | One `expect(Array.map(cases, f)).toEqual(...)`, `Array.forEach`, or `it.prop` | `core/no-native-loop` | `packages/core/test/task-machine.test.ts` |
| A machine tested by poking its state | Send events, assert on the status it reports, include the events it must ignore | | `packages/core/test/task-machine.test.ts` |

Break the behaviour and watch each new test fail before you commit.

## Escape hatches

Use one only when the Effect form is worse, and say why on the same line.

- A loop that must stop early, poll or walk by index: `// loop: <reason>` on the line above it.
- An `@effect/tsgo` diagnostic at a real boundary: `// @effect-diagnostics-next-line <rule>:off -- <reason>`. A whole file only when it is not Effect code, as `scripts/guard/policy.ts` is.
- Never weaken a rule in `oxlint.config.ts`, `tsconfig.base.json` or `lint/` to land a change; ask the owner.
