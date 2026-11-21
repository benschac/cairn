import { it } from "@effect/vitest";
import { click, expect, given, role, scene, text } from "foldkit/scene";

import { init, update, view } from "../src/main.ts";

const waiting = role("button", { name: "Waiting for approval" });

it("the waiting filter leaves only the tasks that need a human", () => {
  scene(
    { update, view },
    given(init().model),
    expect(text(/Parse PRD sections/u)).toExist(),
    expect(waiting).toHaveAttr("aria-pressed", "false"),
    click(waiting),
    expect(waiting).toHaveAttr("aria-pressed", "true"),
    expect(text(/Add the sessions table/u)).toExist(),
    expect(text(/Parse PRD sections/u)).toBeAbsent(),
    expect(text(/Write the stack/u)).toBeAbsent(),
    click(waiting),
    expect(text(/Write the stack/u)).toExist(),
  );
});
