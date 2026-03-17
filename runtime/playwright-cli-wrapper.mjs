#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";

const cliEntry = "/usr/local/lib/node_modules/@playwright/cli/playwright-cli.js";
const defaultConfig = "/app/.playwright/cli.config.json";
const args = process.argv.slice(2);

function hasExplicitConfig(argv) {
  return argv.some((arg) => arg === "--config" || arg.startsWith("--config="));
}

function firstCommand(argv) {
  for (const arg of argv) {
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

function withDefaultConfig(argv) {
  if (hasExplicitConfig(argv)) return argv;
  if (!fs.existsSync(defaultConfig)) return argv;
  if (firstCommand(argv) !== "open") return argv;

  const nextArgs = [];
  let inserted = false;
  for (const arg of argv) {
    nextArgs.push(arg);
    if (!inserted && arg === "open") {
      nextArgs.push("--config", defaultConfig);
      inserted = true;
    }
  }
  return nextArgs;
}

const child = spawn(process.execPath, [cliEntry, ...withDefaultConfig(args)], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
