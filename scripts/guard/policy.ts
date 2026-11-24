// @effect-diagnostics preferEffectArray:off preferEffectString:off -- the guard runs before every shell command as a plain Node script and does not load Effect.
export const BYPASS_REASON =
  "Blocked: this command skips or disables a git hook. Each commit runs the lint, format and type checks, and each push may only send commits that `pnpm check` passed on at the top of the stack. Drop the bypass (--no-verify, git commit -n, gt --no-verify or --verify=false, LEFTHOOK=0, core.hooksPath, lefthook uninstall, or a write under .git/hooks or to the cairn-checked record), run `pnpm check`, and fix what it reports. Ask the owner before changing lefthook.yml.";

const BREAKS = new Set([";", "&", "|", "(", ")", "`", "\n"]);
const SHELLS = new Set(["bash", "dash", "eval", "ksh", "sh", "zsh"]);
const WRAPPERS = new Set(["command", "env", "exec", "nohup", "sudo", "time"]);
const HOOK_READERS = new Set(["cat", "file", "grep", "head", "ls", "rg", "stat", "tail", "wc"]);
// The hook scripts, and the record of checked commits that scripts/gate/gate.ts keeps in git's common directory.
const PROTECTED_PATHS = [".git/hooks", "cairn-checked"];
const VERIFY_OFF = new Set(["0", "false", "no", "off"]);
const GIT_GLOBALS_WITH_VALUE = new Set([
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
  "-C",
]);
const COMMIT_SHORT_WITH_VALUE = new Set(["C", "F", "c", "m", "t"]);
const COMMIT_LONG_WITH_VALUE = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--fixup",
  "--message",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
  "--trailer",
]);
const CONFIG_READS = new Set(["--get", "--get-all", "--list", "-l", "get", "list"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const NO_VERIFY = "--no-verify";
const SHORTEST_NO_VERIFY = "--no-veri".length;

const segmentsOf = (command: string): string[][] => {
  const segments: string[][] = [[]];
  let word = "";
  let started = false;
  let quote = "";
  const endWord = () => {
    if (started) {
      segments.at(-1)?.push(word);
    }
    word = "";
    started = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index);
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      } else if (char === "\\" && quote === '"') {
        index += 1;
        word += command.charAt(index);
      } else {
        word += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      index += 1;
      word += command.charAt(index);
      started = true;
    } else if (BREAKS.has(char)) {
      endWord();
      segments.push([]);
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      word += char;
      started = true;
    }
  }
  endWord();
  return segments.filter((segment) => segment.length > 0);
};

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

const disablesLefthook = (word: string) => {
  const [name = "", value = ""] = word.split("=");
  return (
    (name === "LEFTHOOK" && ["0", "false"].includes(value.toLowerCase())) ||
    (name === "LEFTHOOK_EXCLUDE" && value !== "")
  );
};

const isNoVerify = (arg: string) => arg.length >= SHORTEST_NO_VERIFY && NO_VERIFY.startsWith(arg);

const commitSkipsHook = (args: string[]) => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      return false;
    }
    if (isNoVerify(arg)) {
      return true;
    }
    if (COMMIT_LONG_WITH_VALUE.has(arg)) {
      index += 1;
    } else if (/^-[^-]/u.test(arg)) {
      for (const flag of arg.slice(1)) {
        if (flag === "n") {
          return true;
        }
        if (COMMIT_SHORT_WITH_VALUE.has(flag)) {
          if (arg.endsWith(flag)) {
            index += 1;
          }
          break;
        }
      }
    }
  }
  return false;
};

// Graphite's create, modify and submit take --no-verify, --verify=false or --verify false to skip git hooks.
const gtSkipsHook = (args: string[]) =>
  args.some(
    (arg, index) =>
      isNoVerify(arg) ||
      (arg.startsWith("--verify=") &&
        VERIFY_OFF.has(arg.slice("--verify=".length).toLowerCase())) ||
      (arg === "--verify" && VERIFY_OFF.has((args[index + 1] ?? "").toLowerCase())),
  );

const gitSkipsHook = (args: string[]) => {
  let index = 0;
  while ((args[index] ?? "").startsWith("-")) {
    index += GIT_GLOBALS_WITH_VALUE.has(args[index] ?? "") ? 2 : 1;
  }
  const [subcommand = "", ...rest] = args.slice(index);
  return subcommand === "commit" ? commitSkipsHook(rest) : rest.some(isNoVerify);
};

const segmentSkipsHook = (segment: string[]): boolean => {
  const start = segment.findIndex(
    (word) => !ASSIGNMENT.test(word) && !WRAPPERS.has(basename(word)),
  );
  const prefix = start === -1 ? segment : segment.slice(0, start);
  const [program = "", ...args] = start === -1 ? [] : segment.slice(start);
  const name = basename(program);

  if (prefix.some(disablesLefthook)) {
    return true;
  }
  if (name === "export" && args.some(disablesLefthook)) {
    return true;
  }
  if (
    segment.some((word) => word.toLowerCase().includes("core.hookspath")) &&
    !(name === "git" && args.some((arg) => CONFIG_READS.has(arg)))
  ) {
    return true;
  }
  if (
    segment.some((word) => PROTECTED_PATHS.some((path) => word.includes(path))) &&
    !HOOK_READERS.has(name)
  ) {
    return true;
  }
  if ([name, ...args].includes("lefthook") && args.includes("uninstall")) {
    return true;
  }
  const words = [name, ...args];
  const gt = words.findIndex((word) => basename(word) === "gt");
  if (gt !== -1 && gtSkipsHook(words.slice(gt + 1))) {
    return true;
  }
  if (SHELLS.has(name)) {
    return args.some((arg) => !arg.startsWith("-") && skipsHook(arg));
  }
  return name === "git" && gitSkipsHook(args);
};

export const skipsHook = (command: string): boolean => segmentsOf(command).some(segmentSkipsHook);
