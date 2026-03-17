#!/usr/bin/env node

import { spawn } from "node:child_process";

const realNpx = "/usr/local/bin/npx-real";
const playwrightCli = "/usr/local/bin/playwright-cli";
const args = process.argv.slice(2);

function playwrightCommandIndex(argv) {
  const optionsWithValue = new Set([
    "--package",
    "-p",
    "--cache",
    "-c",
    "--call",
    "--shell",
    "--node-options",
    "--userconfig"
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (optionsWithValue.has(arg)) {
      i += 1;
      continue;
    }
    if (/^(--package|-p|--cache|-c|--call|--shell|--node-options|--userconfig)=/.test(arg)) continue;
    if (arg === "--") return argv[i + 1] === "playwright" ? i + 1 : -1;
    if (arg.startsWith("-")) continue;
    return arg === "playwright" ? i : -1;
  }

  return -1;
}

function spawnAndExit(command, commandArgs) {
  const child = spawn(command, commandArgs, {
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
}

const commandIndex = playwrightCommandIndex(args);
if (commandIndex >= 0) {
  spawnAndExit(playwrightCli, args.slice(commandIndex + 1));
} else {
  spawnAndExit(realNpx, args);
}
