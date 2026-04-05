#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const realCli = "/usr/local/bin/playwright-cli-real";
const workspaceConfig = process.env.OPENCLAW_PLAYWRIGHT_CONFIG_PATH?.trim()
  || path.resolve(process.cwd(), ".openclaw", "playwright", "cli.config.json");
const workspaceArtifactsDir = process.env.OPENCLAW_PLAYWRIGHT_ARTIFACTS_DIR?.trim()
  || path.resolve(process.cwd(), ".openclaw", "playwright", "artifacts");
const args = process.argv.slice(2);

function hasExplicitConfig(argv) {
  return argv.some((arg) => arg === "--config" || arg.startsWith("--config="));
}

function explicitConfigPath(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config" && argv[index + 1]) {
      return path.resolve(argv[index + 1]);
    }
    if (arg.startsWith("--config=")) {
      return path.resolve(arg.slice("--config=".length));
    }
  }
  return "";
}

function isHelpRequest(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

function firstCommand(argv) {
  for (const arg of argv) {
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

function configuredCommand(argv) {
  const command = firstCommand(argv);
  return command === "open" ? command : "";
}

function artifactCommand(argv) {
  const command = firstCommand(argv);
  return command === "pdf" || command === "screenshot" || command === "snapshot" || command === "state-save"
    ? command
    : "";
}

function withDefaultConfig(argv, configPath = workspaceConfig) {
  if (hasExplicitConfig(argv)) return argv;
  if (!fs.existsSync(configPath)) return argv;
  if (configuredCommand(argv) !== "open") return argv;

  const nextArgs = [];
  let inserted = false;
  for (const arg of argv) {
    nextArgs.push(arg);
    if (!inserted && arg === "open") {
      nextArgs.push("--config", configPath);
      inserted = true;
    }
  }
  return nextArgs;
}

function normalizedArtifactPath(fileName) {
  const resolved = path.resolve(process.cwd(), fileName);
  if (resolved === workspaceArtifactsDir || resolved.startsWith(`${workspaceArtifactsDir}${path.sep}`)) {
    return fileName;
  }

  return path.relative(process.cwd(), path.join(workspaceArtifactsDir, path.basename(fileName)));
}

function withArtifactPaths(argv) {
  const command = artifactCommand(argv);
  if (!command) return argv;

  const nextArgs = [...argv];

  for (let index = 0; index < nextArgs.length; index += 1) {
    const arg = nextArgs[index];
    if (arg === "--filename" && nextArgs[index + 1]) {
      nextArgs[index + 1] = normalizedArtifactPath(nextArgs[index + 1]);
      return nextArgs;
    }
    if (arg.startsWith("--filename=")) {
      nextArgs[index] = `--filename=${normalizedArtifactPath(arg.slice("--filename=".length))}`;
      return nextArgs;
    }
  }

  if (command === "state-save") {
    const commandIndex = nextArgs.findIndex((arg) => arg === "state-save");
    const filenameIndex = commandIndex + 1;
    if (filenameIndex < nextArgs.length && !nextArgs[filenameIndex].startsWith("-")) {
      nextArgs[filenameIndex] = normalizedArtifactPath(nextArgs[filenameIndex]);
    }
  }

  return nextArgs;
}

async function ensureArtifactDir() {
  await fs.promises.mkdir(workspaceArtifactsDir, { recursive: true });
}

async function main() {
  const artifactArgs = withArtifactPaths(args);

  if (!isHelpRequest(args) && artifactCommand(artifactArgs)) {
    await ensureArtifactDir();
  }

  const child = spawn(realCli, withDefaultConfig(artifactArgs), {
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
