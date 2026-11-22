// Effect core module rules: native patterns that @effect/tsgo does not report.
// Each message names the core module API to use. .agent_sources/effect/native-to-effect.md
// lists the replacements and .agent_sources/effect/checklist.md the review around them.
// Every rule applies only to a file that imports from effect or an @effect package; plain Node
// scripts such as scripts/guard are left alone.

const LOOP_MARKER = /\/\/\s*loop:\s*\S/;
const LOOPS = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

// Type-only and grouping wrappers do not change what is spread: `new Set(x) as Set<number>`, `(new Set(x))`.
const TRANSPARENT = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
  "ChainExpression",
]);
const unwrap = (node) => (node && TRANSPARENT.has(node.type) ? unwrap(node.expression) : node);

const isNewSet = (node) => {
  const set = unwrap(node);
  return (
    set?.type === "NewExpression" && set.callee.type === "Identifier" && set.callee.name === "Set"
  );
};

// `new Set([...a, ...b])`: two or more spreads and nothing else, the concatenate-and-dedupe idiom.
const isConcatenation = (node) => {
  const set = unwrap(node);
  if (!isNewSet(set)) return false;
  const list = unwrap(set.arguments[0]);
  return (
    list?.type === "ArrayExpression" &&
    list.elements.length >= 2 &&
    list.elements.every((element) => element?.type === "SpreadElement")
  );
};

// A capitalized receiver is a module namespace (Array.sort, Chunk.sort), not an array value.
const isModule = (node) => node.type === "Identifier" && /^[A-Z]/.test(node.name);

const importsEffect = (context) =>
  context.sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" && /^(effect|@effect\/)/.test(statement.source.value),
  );

// A loop may stay a loop when the line above it says why: "// loop: <reason>".
const isMarked = (lines, node) => LOOP_MARKER.test(lines[node.loc.start.line - 2] ?? "");

const isLength = (node) => {
  const member = unwrap(node);
  return (
    member?.type === "MemberExpression" &&
    !member.computed &&
    member.property.type === "Identifier" &&
    member.property.name === "length"
  );
};

const isNumber = (node, value) => {
  const literal = unwrap(node);
  return literal?.type === "Literal" && literal.value === value;
};

// .length compared with 0 (=== 0, !== 0, > 0, <= 0, ...) or 1 (< 1, >= 1), or negated (!xs.length).
const EMPTY_TESTS = {
  0: new Set(["===", "!==", "==", "!=", ">", "<=", "<", ">="]),
  1: new Set(["<", ">="]),
};
const FLIPPED = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
const isEmptinessTest = (node) => {
  if (node.type === "UnaryExpression") return node.operator === "!" && isLength(node.argument);
  if (node.type !== "BinaryExpression") return false;
  const [length, bound, operator] = isLength(node.left)
    ? [node.left, node.right, node.operator]
    : [node.right, node.left, FLIPPED[node.operator] ?? node.operator];
  if (!isLength(length)) return false;
  return (
    (isNumber(bound, 0) && EMPTY_TESTS[0].has(operator)) ||
    (isNumber(bound, 1) && EMPTY_TESTS[1].has(operator))
  );
};

const TYPEOF_GUARDS = {
  bigint: "Predicate.isBigInt",
  boolean: "Predicate.isBoolean",
  function: "Predicate.isFunction",
  number: "Predicate.isNumber",
  object: "Predicate.isObject (or Predicate.isReadonlyObject)",
  string: "Predicate.isString",
  symbol: "Predicate.isSymbol",
  undefined: "Predicate.isUndefined",
};

const noNativeCollection = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    return {
      NewExpression(node) {
        const callee = node.callee;
        if (callee.type !== "Identifier" || (callee.name !== "Map" && callee.name !== "Set"))
          return;
        context.report({
          node,
          message:
            "new " +
            callee.name +
            " builds a mutable native collection. Fix, from 'effect': string keys, Record.fromIterableWith or Record.fromEntries, read with Record.get; grouping, Array.groupBy; unique values, Array.dedupe; membership or keys of any type, HashSet.fromIterable or HashMap.fromIterable (immutable, compared with Equal); local mutable state, MutableHashMap or MutableHashSet.",
        });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          (callee.object.name !== "Map" && callee.object.name !== "Object") ||
          callee.property.name !== "groupBy"
        )
          return;
        context.report({
          node,
          message:
            callee.object.name +
            ".groupBy groups into a native collection. Fix: Array.groupBy(xs, (x) => key) from 'effect', which returns a Record of non-empty arrays.",
        });
      },
    };
  },
};

const noArraySpread = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    return {
      ArrayExpression(node) {
        if (!node.elements.some((element) => element?.type === "SpreadElement")) return;
        context.report({
          node,
          message:
            "An array literal with a spread copies or concatenates by hand. Fix, from 'effect': Array.appendAll(a, b), Array.append(xs, x), Array.prepend(xs, x), Array.flatten([a, b, c]), Array.fromIterable(iterable), Array.copy(xs); an optional element, Option.toArray(o).",
        });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "Array" ||
          (callee.property.name !== "from" && callee.property.name !== "of")
        )
          return;
        context.report({
          node,
          message:
            "Native Array." +
            callee.property.name +
            ". Fix, from 'effect': Array.fromIterable(iterable), Array.map(Array.fromIterable(iterable), f), Array.makeBy(n, f), Array.range(start, end), Array.make(a, b).",
        });
      },
    };
  },
};

const noNativeLoop = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    const lines = context.sourceCode.text.split("\n");
    const report = (node) => {
      if (isMarked(lines, node)) return;
      context.report({
        node,
        message:
          "A native loop. Fix, from 'effect': Array.map, Array.flatMap, Array.filter, Array.filterMap, Array.reduce, Array.mapAccum, Array.forEach, Array.findFirst, Array.some, Array.every; Array.cartesian for nested loops over pairs; Array.unfold or Array.makeBy to build a sequence; Effect.forEach for effects; Effect.repeat with a Schedule to poll. When the loop must stop early or walk a structure by index, put a \"// loop: <reason>\" comment on the line above it.",
      });
    };
    return Object.fromEntries(Array.from(LOOPS, (type) => [type, report]));
  },
};

const noSwitch = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    return {
      SwitchStatement(node) {
        context.report({
          node,
          message:
            "A switch statement. Fix, from 'effect': Match.value(x).pipe(Match.when(...), Match.tag(...), Match.exhaustive), Match.valueTags(x, { ... }) for a _tag union, Match.type<T>() for a reusable matcher, or the .match of a Schema.toTaggedUnion schema.",
        });
      },
    };
  },
};

const noLengthCheck = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    const report = (node) => {
      if (!isEmptinessTest(node)) return;
      context.report({
        node,
        message:
          "Testing emptiness through .length. Fix, from 'effect': Array.isReadonlyArrayNonEmpty(xs) (narrows to NonEmptyReadonlyArray, so Array.headNonEmpty needs no Option) or Array.isReadonlyArrayEmpty(xs); both branches, Array.match(xs, { onEmpty, onNonEmpty }); a string, String.isEmpty or String.isNonEmpty.",
      });
    };
    return { BinaryExpression: report, UnaryExpression: report };
  },
};

const noTypeofCheck = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        const [operand, tag] =
          node.left.type === "UnaryExpression" ? [node.left, node.right] : [node.right, node.left];
        if (operand.type !== "UnaryExpression" || operand.operator !== "typeof") return;
        if (tag.type !== "Literal" || typeof tag.value !== "string") return;
        const guard = TYPEOF_GUARDS[tag.value];
        if (!guard) return;
        context.report({
          node,
          message:
            'A typeof x === "' +
            tag.value +
            '" test. Fix: ' +
            guard +
            "(x) from 'effect'; compose guards with Predicate.and, Predicate.or and Predicate.not; for a value with a schema, Schema.is(schema).",
        });
      },
    };
  },
};

const noNativeSort = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || isModule(callee.object))
          return;
        const name = callee.property.name;
        if (name !== "sort" && name !== "toSorted") return;
        context.report({
          node,
          message: `Native \`.${name}\` sorts with a hand-written comparator (or by string when it has none). Fix: Array.sort(xs, Order.Number), Array.sortWith(xs, key, order), or Array.sortBy(...orders) from 'effect'.`,
        });
      },
    };
  },
};

const noSetDedupe = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    const report = (node, what = "Spreading a Set to remove duplicates") =>
      context.report({
        node,
        message: `${what}. Fix: Array.dedupe(xs), or Array.dedupeWith for a custom equivalence, from 'effect'. To combine two collections, Array.dedupe(Array.appendAll(a, b)) or Array.union; to test membership, HashSet.fromIterable.`,
      });
    return {
      ArrayExpression(node) {
        if (
          node.elements.some(
            (element) => element?.type === "SpreadElement" && isNewSet(element.argument),
          )
        )
          report(node);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (
          callee.object.type === "Identifier" &&
          callee.object.name === "Array" &&
          callee.property.name === "from" &&
          isNewSet(node.arguments[0])
        )
          report(node, "Array.from over a Set to remove duplicates");
      },
      ForOfStatement(node) {
        if (isNewSet(node.right)) report(node.right, "Iterating a new Set to remove duplicates");
      },
      NewExpression(node) {
        if (isConcatenation(node))
          report(node, "Concatenating arrays into a Set to remove duplicates");
      },
    };
  },
};

const noYieldInLoop = {
  meta: { type: "suggestion", schema: [] },
  create(context) {
    if (!importsEffect(context)) return {};
    const lines = context.sourceCode.text.split("\n");
    return {
      YieldExpression(node) {
        if (!node.delegate) return;
        // Walk up to the enclosing function. A loop counts only when the yield* is in its body,
        // not in its head: `for (const x of yield* xs)` runs the effect once.
        let child = node;
        for (
          let parent = node.parent;
          parent && !FUNCTIONS.has(parent.type);
          child = parent, parent = parent.parent
        ) {
          if (!LOOPS.has(parent.type) || child !== parent.body) continue;
          if (isMarked(lines, parent)) return;
          context.report({
            node,
            message:
              'yield* inside a loop body runs one effect per element by hand. Fix: Effect.forEach(xs, f) (add { concurrency } when calls are independent) or Effect.reduce for running state. When the loop must break early or poll, put a "// loop: <reason>" comment on the line above it.',
          });
          return;
        }
      },
    };
  },
};

export default {
  meta: { name: "core" },
  rules: {
    "no-array-spread": noArraySpread,
    "no-length-check": noLengthCheck,
    "no-native-collection": noNativeCollection,
    "no-native-loop": noNativeLoop,
    "no-native-sort": noNativeSort,
    "no-set-dedupe": noSetDedupe,
    "no-switch": noSwitch,
    "no-typeof-check": noTypeofCheck,
    "no-yield-in-loop": noYieldInLoop,
  },
};
