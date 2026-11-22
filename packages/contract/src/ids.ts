import { Schema } from "effect";

const SEGMENTS = String.raw`(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$`;

export const SECTION_ID = new RegExp(String.raw`^(?:prd|spec)${SEGMENTS}`, "u");

export const SectionId = Schema.String.check(Schema.isPattern(SECTION_ID)).pipe(
  Schema.brand("SectionId"),
);
export type SectionId = typeof SectionId.Type;

export const SectionPrefix = Schema.Literals(["prd", "spec"]);
export type SectionPrefix = typeof SectionPrefix.Type;

export const PrdSectionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(String.raw`^prd${SEGMENTS}`, "u"))),
  Schema.brand("PrdSectionId"),
);
export type PrdSectionId = typeof PrdSectionId.Type;

export const SpecSectionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(String.raw`^spec${SEGMENTS}`, "u"))),
  Schema.brand("SpecSectionId"),
);
export type SpecSectionId = typeof SpecSectionId.Type;

/** A task id such as `t1`: no whitespace, so it survives a commit trailer. */
export const TaskId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)).pipe(
  Schema.brand("TaskId"),
);
export type TaskId = typeof TaskId.Type;
