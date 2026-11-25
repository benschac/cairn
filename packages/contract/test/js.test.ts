import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { expect, it } from "@effect/vitest";
import { Array, Schema } from "effect";

import {
  Config,
  Event,
  EventJson,
  Manifest,
  Trailers,
  formatTrailers as coreFormat,
} from "../src/index.ts";
import {
  CairnContractError,
  cairnDir,
  formatTrailers,
  migrateManifest,
  parseConfig,
  parseEvent,
  parseManifest,
} from "../src/js.ts";

const isContractError = Schema.is(CairnContractError);
const thrown = (run: () => unknown): CairnContractError => {
  try {
    run();
  } catch (error) {
    if (isContractError(error)) return error;
  }
  throw new Error("expected a CairnContractError");
};

it.prop("parseManifest decodes what the manifest schema encodes", [Manifest], ([manifest]) => {
  expect(parseManifest(Schema.encodeSync(Manifest)(manifest))).toEqual(manifest);
});

it.prop("parseEvent decodes what the event schema encodes", [Event], ([event]) => {
  const line = Schema.encodeSync(EventJson)(event);
  expect(parseEvent(line)).toEqual(event);
});

it.prop("parseConfig decodes what the config schema encodes", [Config], ([config]) => {
  expect(parseConfig(Schema.encodeSync(Config)(config))).toEqual(config);
});

it.prop("parseManifest names the field it refused", [Manifest], ([manifest]) => {
  const input = { ...Schema.encodeSync(Manifest)(manifest), feature: "Not Kebab" };
  const error = thrown(() => parseManifest(input));
  expect(error.path).toBe("feature");
  expect(error.message.length).toBeGreaterThan(0);
});

it("parseEvent refuses a line that is not JSON, and a bad field with its path", () => {
  expect(thrown(() => parseEvent("{nope")).path).toBe("");
  const error = thrown(() =>
    parseEvent('{"status":"bogus","taskId":"t1","ts":"2026-01-01T00:00:00Z"}'),
  );
  expect(error.path).toBe("status");
});

it("parseConfig refuses a non-object", () => {
  expect(thrown(() => parseConfig(7)).path).toBe("");
});

it.prop("migrateManifest returns a version 1 input unchanged", [Manifest], ([manifest]) => {
  const input = Schema.encodeSync(Manifest)(manifest);
  expect(migrateManifest(input)).toBe(input);
});

it("migrateManifest refuses any other version", () => {
  expect(thrown(() => migrateManifest({ version: 2 })).path).toBe("version");
  expect(thrown(() => migrateManifest({})).path).toBe("version");
});

it.prop("formatTrailers is the contract's trailer block", [Trailers], ([trailers]) => {
  expect(formatTrailers(trailers)).toBe(coreFormat(trailers));
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", Array.fromIterable(args), { cwd, stdio: "ignore" });

it("cairnDir from a linked worktree finds the main checkout's .cairn", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cairn-dir-")));
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "a"), "a");
  git(main, "add", "a");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a");
  git(main, "worktree", "add", "-q", linked, "-b", "other");
  mkdirSync(join(linked, "sub"));
  expect(cairnDir(main)).toBe(join(main, ".cairn"));
  expect(cairnDir(linked)).toBe(join(main, ".cairn"));
  expect(cairnDir(join(linked, "sub"))).toBe(join(main, ".cairn"));
});

it("cairnDir outside a repository throws", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-nogit-")));
  expect(() => cairnDir(dir)).toThrow(/git|not a git/iu);
});
