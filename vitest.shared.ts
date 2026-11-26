// Test options every package's vitest config shares. Plain options, so this file needs no vitest of its own:
// each package's `defineConfig` checks them.

export const sharedTest = {
  // Test files in one worker share their imports. A viewer scene parses the demo PRD and spec (half a
  // megabyte of markdown) and decodes the demo trace; with a fresh module graph per file every file paid
  // for that again, and for loading Effect and Foldkit. Sharing them cut the CPU of the viewer's suite
  // by 30% and of core's and cli's by a third. Module-level state in src is caches keyed by their input,
  // so a file cannot see another's results, only reuse its work.
  isolate: false,
  // Without isolation a stubbed global or env would leak into the next file, so each test's stubs are
  // undone after it.
  unstubEnvs: true,
  unstubGlobals: true,
};
