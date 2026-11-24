#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command } from "effect/cli";

import { idsCommand } from "./commands/ids.ts";
import { initCommand } from "./commands/init.ts";
import { lintCommand } from "./commands/lint.ts";
import { planCommand } from "./commands/plan.ts";
import { MainCheckout } from "./main-checkout.ts";

const cairn = Command.make("cairn").pipe(
  Command.withDescription("Turn a markdown PRD into a spec and a stack of branches"),
  Command.withSubcommands([initCommand, idsCommand, lintCommand, planCommand]),
);

// Logs go to stderr so stdout holds only what a command prints.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(cairn, { version: "0.0.0" }).pipe(
  Effect.provide(
    Layer.mergeAll(logger, MainCheckout.layer().pipe(Layer.provideMerge(NodeServices.layer))),
  ),
  NodeRuntime.runMain,
);
