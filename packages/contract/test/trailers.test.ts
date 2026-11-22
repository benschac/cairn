import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import {
  PrdSectionId,
  SectionId,
  SessionId,
  SpecSectionId,
  Trailers,
  formatTrailers,
  parseTrailers,
} from "../src/index.ts";

const failure = (message: string) => {
  const result = parseTrailers(message);
  return Result.isFailure(result) ? result.failure.reason : "parsed";
};

it.prop("formatting trailers then parsing them round-trips", [Trailers], ([trailers]) => {
  const message = `Add a thing\n\nBody text.\n\n${formatTrailers(trailers)}\n`;
  expect(parseTrailers(message)).toEqual(Result.succeed(trailers));
});

it.prop("a second Cairn-Task is refused", [Trailers], ([trailers]) => {
  expect(failure(`${formatTrailers(trailers)}\nCairn-Task: t99`)).toBe("duplicate-task");
});

it.prop("a second Cairn-Session is refused", [Trailers], ([trailers]) => {
  expect(failure(`${formatTrailers(trailers)}\nCairn-Session: s_abcdef`)).toBe("duplicate-session");
});

it.prop("a message missing the task, session or sections is refused", [Trailers], ([t]) => {
  const lines = formatTrailers(t).split("\n");
  expect(failure(lines.filter((l) => !l.startsWith("Cairn-Task")).join("\n"))).toBe("missing-task");
  expect(failure(lines.filter((l) => !l.startsWith("Cairn-Session")).join("\n"))).toBe(
    "missing-session",
  );
  expect(failure(lines.filter((l) => !l.startsWith("Cairn-Section")).join("\n"))).toBe(
    "missing-section",
  );
});

it.prop("a session id that does not match is refused", [Schema.String], ([bad]) => {
  if (!(!/^s_[a-z0-9]{6,}$/u.test(bad) && !bad.includes("\n") && bad.trim() === bad)) return;
  expect(failure(`Cairn-Task: t1\nCairn-Section: spec.a\nCairn-Session: ${bad}`)).not.toBe(
    "parsed",
  );
  expect(Schema.is(SessionId)(bad)).toBe(false);
});

it("a session id is s_ then six or more lowercase letters or digits", () => {
  expect(Schema.is(SessionId)("s_abcdef")).toBe(true);
  expect(Schema.is(SessionId)("s_abcde")).toBe(false);
  expect(Schema.is(SessionId)("s_ABCDEF")).toBe(false);
});

it("a message with no trailers is refused", () => {
  expect(failure("Just a subject")).toBe("missing-task");
});

it("a section that is not a spec section is refused in the trailers", () => {
  expect(failure("Cairn-Task: t1\nCairn-Section: prd.viewer\nCairn-Session: s_abcdef")).toBe(
    "invalid",
  );
});

it.prop("PrdSectionId accepts prd.* and refuses spec.*", [SpecSectionId], ([spec]) => {
  const prd = `prd.${spec.slice("spec.".length)}`;
  expect(Schema.is(PrdSectionId)(prd)).toBe(true);
  expect(Schema.is(SpecSectionId)(prd)).toBe(false);
  expect(Schema.is(SpecSectionId)(spec)).toBe(true);
  expect(Schema.is(PrdSectionId)(spec)).toBe(false);
  expect(Schema.is(SectionId)(prd)).toBe(true);
  expect(Schema.is(SectionId)(spec)).toBe(true);
});

it.prop("generated session ids are valid", [SessionId], ([id]) => {
  expect(Schema.is(SessionId)(id)).toBe(true);
});
