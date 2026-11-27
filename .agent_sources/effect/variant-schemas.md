# Variant schemas

When one record shows up in several places, and each place sees a different part of it or encodes it
differently, declare its fields once and extract a schema for each place. Each field says which variants
have it, so the decision sits on the field instead of in a `pick`, an `omit` or a list of names kept in
step with the schema somewhere else. From Harry Solovay's talk
[Advanced Effect Design Patterns](https://youtu.be/_tSGby_q890) at Effect Miami 3, chapter "Variant
schemas".

> When one shape shows up in several places, declare its fields once and extract each variant.

Line numbers are for the installed `effect` (4.1.5, pinned in `pnpm-workspace.yaml`'s catalog). If one
has moved, find the export again with `rg -n '^export declare' node_modules/effect/dist/schema/VariantSchema.d.ts`.

## When to reach for it

- A record that crosses several boundaries, each with its own subset of the fields: what a model writes
  and what Cairn stores beside it; what a caller hands a store, the row it becomes and what a reader gets
  back; what a client may send, what the server keeps and what a public reader may see.
- One field encoded differently per boundary: JSON text in a SQLite column and an object in memory, a
  model's title reference and a stored task ID.
- The smells: `X.mapFields(Struct.pick([...]))` or `Struct.omit` defining a second schema, an
  `Omit<X, ...>` or `Pick<X, ...>` type beside a schema, an `as const` list of field names that must
  match a schema, two `Schema.Struct`s that share most of their fields.

## When not to

- A function that reads a few fields of a record narrows its input with `Pick` or `Struct.pick`: the
  stacks' `StackTask`, git's `Logged` and `Authored`. That is not a place the record goes.
- A shape that only adds fields to another is `Schema.fieldsAssign` or `mapFields(Struct.assign(...))`:
  `TraceTask`, `TraceJudgment`, `GitCommit`. A variant earns its place when some variant leaves a
  field out or encodes it differently.
- A projection in a test assertion.

## The API

`import { VariantSchema } from "effect/schema"`. `VariantSchema.make` fixes the variant names and the
default, and returns the toolkit for them.

| Need | Call | Declaration |
| --- | --- | --- |
| The toolkit for a set of variants | `VariantSchema.make({ variants: ["entry", "derived", "prose"], defaultVariant: "entry" })` | `node_modules/effect/dist/schema/VariantSchema.d.ts` 279-299 |
| The fields, declared once | `V.Struct({ ... })`: each value a schema (every variant), a variant field, or a nested `V.Struct` | 283 |
| A field only some variants have | `V.FieldOnly(["entry", "prose"])(schema)` | 285 |
| A field all but some variants have | `V.FieldExcept(["prose"])(schema)` | 286 |
| A different schema per variant | `V.Field({ draft: TitleRef, manifest: TaskId })`; a variant left out does not have the field | 284 |
| One variant as an ordinary `Schema.Struct` | `V.extract(fields, "prose")`, or data-last `V.extract("prose")` | 293-296 |
| A class whose static properties are the variants | `class X extends V.Class<X>("X")({ ... }) {}`, then `X.prose` | 291 |
| Change a field's schema in some variants | `V.fieldEvolve(field, { row: (s) => Schema.fromJsonString(s) })` | 287-290 |

`effect/schema/Model` is the same toolkit made for SQL tables, with the variants `select` (the
default), `insert`, `update`, `json`, `jsonCreate` and `jsonUpdate` (`Model.d.ts` 19), and fields
that state the usual rules:

| Field | Variants that have it | `Model.d.ts` |
| --- | --- | --- |
| `Model.GeneratedByDb(s)`: an id the database assigns | `select`, `json` | 242 |
| `Model.GeneratedByApp(s)`: a value the server computes | every variant but `jsonCreate` and `jsonUpdate` | 268 |
| `Model.Sensitive(s)`: never leaves the server | `select`, `insert`, `update` | 291 |
| `Model.JsonFromString(s)`: JSON text in a column, an object in JSON | all; the database variants decode the text | 625 |
| `Model.DateTimeInsert`: set once, when the row is inserted | `select`, `insert`, `json` | 454 |
| `Model.DateTimeUpdate`: set on every write | `select`, `insert`, `update`, `json` | 537 |
| `Model.FieldOption(s)`: null in a column, a missing key in JSON, an `Option` in memory | all | 344 |
| `Model.BooleanSqlite`: `0` or `1` in SQLite | all | 372 |

Use `Model` for a table in `cairn.db` or a hosted store, and `VariantSchema.make` with names of your own
where the places are not a database's.

## In this repository

- `packages/contract/src/spec-index.ts`: a `spec.json` entry. `derived` fields are what code reads from
  `spec.md` and `manifest.json` (`derivedOf` in `packages/core/src/spec-index.ts`), `prose` fields what
  the planner's `index` call asks the model for, and `entry` is the whole entry. `IndexedSection`,
  `DerivedSection` and `IndexProse` are extracted from one declaration, and `Struct.keys(IndexProse.fields)`
  replaces the list of prose field names `specIndexOf` kept.
- `packages/contract/src/manifest.ts`: a task. `draft` is what the planner's model proposes and `manifest`
  a task in `manifest.json`. The fields `stackOf` and the runs fill (`id`, `branch`, `parent`, `humanGate`,
  `status`, `commits`, ...) are `byCairn`, so a draft cannot carry them. `dependsOn` is titles in a draft
  and task IDs in the manifest, and the descriptions written for the model's prompt sit on the `draft`
  schema of `category`, `dependsOn` and `model` only. `TaskDraft`'s JSON Schema, which the model is given,
  is the one it was before.

## Traps

- Every export is `@stability unstable`. The catalog pins `effect`, so an upgrade is a deliberate change:
  run the tests of every module that declares variants after one. Importing through the `effect/schema`
  barrel is not reported by the unstable-API diagnostic, so nothing else will say it is unstable.
- Name what `FieldOnly` returns after who fills the field, `const prose = V.FieldOnly(["entry", "prose"])`,
  so each line of the declaration reads as a rule.
- A field no variant has is accepted and silently absent. `V.Struct` checks only that the variant names
  exist, so test which fields each variant has, as `packages/contract/test/spec-index.test.ts` does.
- `extract` keeps the declaration's field order, which is the order `Schema.encode` writes keys in. Keep
  the order the schema had (alphabetical in the contract), so a file Cairn writes, such as `spec.json`
  from `cairn plan`, comes out as before.
- An annotation on a field shared by several variants is on every variant, and so in each one's JSON
  Schema. A description written for a model's prompt belongs only on that variant: give the field a
  `V.Field` with an annotated schema for it and a plain one for the others.
- `extract` of the default variant from a `V.Struct` is a plain `Schema.Struct`; from a `V.Class` it is the
  class itself, so the default variant then decodes to instances.

## Tests

`packages/contract/test/spec-index.test.ts`:

- An example names the fields the planner fills, and checks that the derived fields and the prose share
  none and together are the entry. Moving a field to the other variant fails it.
- A property decodes each variant from an encoded entry and checks that the derived fields and the prose,
  assigned together, are the entry. A field left out of the `entry` variant fails it. Compare with the
  entry decoded from the same encoded value: a generated record's prototype differs from a decoded one's,
  which `toStrictEqual` reports.
