#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const realCli = "/usr/local/bin/playwright-cli-real";
const defaultConfig = "/app/.playwright/cli.config.json";
const workspaceConfig = path.resolve(process.cwd(), ".openclaw", "playwright", "cli.config.json");
const workspaceArtifactsDir = path.resolve(process.cwd(), ".openclaw", "playwright", "artifacts");
const workspaceSkillDir = path.resolve(process.cwd(), ".claude", "skills", "playwright-cli");
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
  return command === "open" || command === "install" ? command : "";
}

function artifactCommand(argv) {
  const command = firstCommand(argv);
  return command === "pdf" || command === "screenshot" || command === "snapshot" || command === "state-save"
    ? command
    : "";
}

function defaultSkillSourceDir() {
  const realCliEntry = fs.realpathSync(realCli);
  return path.resolve(path.dirname(realCliEntry), "node_modules", "playwright", "lib", "skill");
}

async function ensureWorkspaceConfig(configPath = workspaceConfig) {
  if (fs.existsSync(configPath)) return false;
  if (!fs.existsSync(defaultConfig)) return false;
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.copyFile(defaultConfig, configPath);
  return true;
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

async function installWorkspace(argv) {
  const configPath = explicitConfigPath(argv) || workspaceConfig;
  const createdConfig = await ensureWorkspaceConfig(configPath);
  console.log(`✅ Workspace initialized at \`${process.cwd()}\`.`);

  if (argv.includes("--skills")) {
    const skillSourceDir = defaultSkillSourceDir();
    if (!fs.existsSync(skillSourceDir)) {
      console.error(`❌ Skills source directory not found: ${skillSourceDir}`);
      process.exit(1);
    }
    await fs.promises.mkdir(path.dirname(workspaceSkillDir), { recursive: true });
    await fs.promises.cp(skillSourceDir, workspaceSkillDir, { recursive: true });
    console.log(`✅ Skills installed to \`${path.relative(process.cwd(), workspaceSkillDir)}\`.`);
  }

  if (createdConfig) {
    console.log(`✅ Created default config for chromium at ${path.relative(process.cwd(), configPath)}.`);
  }
}

async function main() {
  const command = configuredCommand(args);
  const artifactArgs = withArtifactPaths(args);

  if (!isHelpRequest(args) && command === "install") {
    await installWorkspace(args);
    return;
  }

  if (!isHelpRequest(args) && command === "open") {
    await ensureWorkspaceConfig();
  }

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
