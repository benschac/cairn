import { Trace } from "@cairn/contract";
import { Schema } from "effect";

import demoTraceJson from "./demo-trace.json" with { type: "json" };

export const demoTrace = Schema.decodeUnknownSync(Trace)(demoTraceJson);
