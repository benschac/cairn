// Test options every package's vitest config shares. Plain options, so this file needs no vitest of its own:
// each package's `defineConfig` checks them.

export const sharedTest = {
  // A test gets 15 s. Over 36 CI runs after the speed fixes the slowest test took 8.0 s (a viewer markdown test
  // that renders the whole demo spec and PRD); the slowest in cli took 5.7 s, in core 5.5 s and in contract
  // 5.1 s. Vitest's default of 5 s timed out in 30 of the 75 runs before them. 15 s sits about twice above the
  // slowest test, so a slow runner passes and a test that hangs or doubles in cost still fails. A test that needs
  // more says so itself, as the git and presence properties do.
  testTimeout: 15_000,
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
