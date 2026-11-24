import { text } from "node:stream/consumers";

import { BYPASS_REASON, skipsHook } from "./policy.ts";

const commandOf = (input: string): string => {
  try {
    const payload: unknown = JSON.parse(input);
    if (typeof payload === "object" && payload !== null) {
      const toolInput: unknown = Reflect.get(payload, "tool_input");
      if (typeof toolInput === "object" && toolInput !== null) {
        const command: unknown = Reflect.get(toolInput, "command");
        return typeof command === "string" ? command : "";
      }
    }
    return "";
  } catch {
    return "";
  }
};

if (skipsHook(commandOf(await text(process.stdin)))) {
  process.stderr.write(`${BYPASS_REASON}\n`);
  process.exitCode = 2;
}
