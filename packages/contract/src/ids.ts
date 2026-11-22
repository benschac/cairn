import { Schema } from "effect";

/** An id under `prefix`: one or more `.`-separated lowercase kebab-case segments. */
const sectionPattern = (prefix: string) =>
  new RegExp(String.raw`^${prefix}(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`, "u");

export const SECTION_ID = sectionPattern("(?:prd|spec)");

export const SectionId = Schema.String.check(Schema.isPattern(SECTION_ID)).pipe(
  Schema.brand("SectionId"),
);
export type SectionId = typeof SectionId.Type;

export const SectionPrefix = Schema.Literals(["prd", "spec"]);
export type SectionPrefix = typeof SectionPrefix.Type;

export const PrdSectionId = Schema.String.check(Schema.isPattern(sectionPattern("prd"))).pipe(
  Schema.brand("PrdSectionId"),
);
export type PrdSectionId = typeof PrdSectionId.Type;

export const SpecSectionId = Schema.String.check(Schema.isPattern(sectionPattern("spec"))).pipe(
  Schema.brand("SpecSectionId"),
);
export type SpecSectionId = typeof SpecSectionId.Type;

/** A task id such as `t1`: no whitespace, so it survives a commit trailer. */
export const TaskId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)).pipe(
  Schema.brand("TaskId"),
);
export type TaskId = typeof TaskId.Type;
