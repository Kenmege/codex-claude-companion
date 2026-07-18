#!/usr/bin/env node

import process from "node:process";

import { readBridgeBrokerSpec, runBridgeBroker } from "./lib/bridge-broker.mjs";

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--spec") {
  process.stderr.write("Usage: bridge-broker --spec <private-absolute-path>\n");
  process.exitCode = 2;
} else {
  try {
    await runBridgeBroker(readBridgeBrokerSpec(argv[1]));
  } catch (error) {
    process.stderr.write(`bridge broker stopped: ${String(error?.message ?? error).slice(0, 1_000)}\n`);
    process.exitCode = 1;
  }
}
