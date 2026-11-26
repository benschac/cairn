import { Array, Schema } from "effect";

export const EndKind = Schema.Literals(["task", "spec", "prd", "item", "statement", "test"]);
export type EndKind = typeof EndKind.Type;

/** One end of a relation: the kind of thing and its ID. */
export const End = Schema.Struct({ id: Schema.NonEmptyString, kind: EndKind });
export type End = typeof End.Type;

export const RelationKind = Schema.Literals([
  "needs",
  "builtOn",
  "orderedAfter",
  "builds",
  "names",
  "implements",
  "dependsOn",
  "proves",
]);
export type RelationKind = typeof RelationKind.Type;

export interface RelationDeclaration {
  readonly label: string;
  readonly from: ReadonlyArray<EndKind>;
  readonly to: ReadonlyArray<EndKind>;
  /** Where the relation is written down. */
  readonly recordedIn: string;
}

/** The eight relation kinds of the PRD, declared once. */
export const relationKinds: { readonly [K in RelationKind]: RelationDeclaration } = {
  builds: {
    from: ["task"],
    label: "builds",
    recordedIn: "manifest.json specSections",
    to: ["spec"],
  },
  builtOn: {
    from: ["task"],
    label: "built on",
    recordedIn: "manifest.json parent",
    to: ["task"],
  },
  dependsOn: {
    from: ["spec"],
    label: "depends on",
    recordedIn: "spec.md Depends on",
    to: ["spec"],
  },
  implements: {
    from: ["spec"],
    label: "implements",
    recordedIn: "spec.md Implements",
    to: ["prd", "item"],
  },
  names: {
    from: ["task"],
    label: "names",
    recordedIn: "manifest.json prdSections",
    to: ["prd", "item"],
  },
  needs: {
    from: ["task"],
    label: "needs",
    recordedIn: "manifest.json dependsOn",
    to: ["task"],
  },
  orderedAfter: {
    from: ["task"],
    label: "ordered after",
    recordedIn: "manifest.json orderedAfter",
    to: ["task"],
  },
  proves: {
    from: ["test"],
    label: "proves",
    recordedIn: "spec.md tests",
    to: ["statement"],
  },
};

/** A relation of a kind between two ends; the ends must be kinds the declaration of that kind allows. */
export const Relation = Schema.Struct({
  from: End,
  kind: RelationKind,
  to: End,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      ({ from, kind, to }) => {
        const declared = relationKinds[kind];
        return Array.contains(declared.from, from.kind) && Array.contains(declared.to, to.kind);
      },
      { message: "a relation end is not a kind its relation kind allows" },
    ),
  ),
);
export type Relation = typeof Relation.Type;
