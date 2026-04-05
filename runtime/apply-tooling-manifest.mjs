#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { safeRunCommand } from "./shared.mjs";

const manifestPath = process.argv[2] || "/tmp/openclaw/tooling.manifest.json";
const scriptsRoot = process.argv[3] || "/tmp/openclaw/scripts";

async function run(command, args, options = {}) {
  const result = await safeRunCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to run ${command} ${args.join(" ")}`);
  }
  return result;
}

async function loadManifest(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function commandExists(command) {
  const result = await safeRunCommand("sh", ["-lc", `command -v ${command}`]);
  return result.code === 0;
}

async function ensureAptUpdated() {
  await run("apt-get", ["update"]);
}

async function installNodeMajor(major) {
  const versionResult = await safeRunCommand("node", ["-p", "process.versions.node.split('.')[0]"]);
  if (versionResult.code === 0 && versionResult.stdout.trim() === String(major)) return;
  await run("npm", ["install", "--global", "n"]);
  await run("n", [String(major)]);
}

async function installDotnetMajor(major) {
  await run("sh", ["-lc", `curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && chmod +x /tmp/dotnet-install.sh && /tmp/dotnet-install.sh --channel "${major}.0" --install-dir /usr/share/dotnet && ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet && rm -f /tmp/dotnet-install.sh`]);
}

async function installProfiles(profiles = []) {
  if (!Array.isArray(profiles) || profiles.length === 0) return;
  await ensureAptUpdated();
  for (const profile of [...profiles].sort((left, right) => String(left).localeCompare(String(right)))) {
    if (/^java\d+$/i.test(profile)) {
      const major = String(profile).replace(/^java/i, "");
      const probe = await safeRunCommand("sh", ["-lc", `apt-cache show "openjdk-${major}-jdk-headless"`]);
      await run("apt-get", ["install", "--yes", "--no-install-recommends", probe.code === 0 ? `openjdk-${major}-jdk-headless` : "default-jdk-headless"]);
      continue;
    }
    if (/^node\d+$/i.test(profile)) {
      await installNodeMajor(String(profile).replace(/^node/i, ""));
      continue;
    }
    if (/^python/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "python3-pip", "python3-venv"]);
      continue;
    }
    if (/^go/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "golang-go"]);
      continue;
    }
    if (/^rust/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "cargo", "rustc"]);
      continue;
    }
    if (/^php/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "php-cli", "composer"]);
      continue;
    }
    if (/^ruby/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "ruby-full"]);
      continue;
    }
    if (/^dotnet\d+$/i.test(profile)) {
      await installDotnetMajor(String(profile).replace(/^dotnet/i, ""));
      continue;
    }
    if (/^(cpp|c)/i.test(profile)) {
      await run("apt-get", ["install", "--yes", "--no-install-recommends", "build-essential", "clang", "cmake", "make", "meson", "ninja-build"]);
      continue;
    }
  }

  if (await commandExists("gem")) {
    await safeRunCommand("gem", ["install", "--no-document", "bundler"]);
  }
}

function resolveScriptInvocation(scriptPath) {
  const extension = path.extname(scriptPath).toLowerCase();
  if (extension === ".sh") return { command: "sh", args: [scriptPath] };
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return { command: "node", args: [scriptPath] };
  return { command: "sh", args: [scriptPath] };
}

async function runScripts(entries = []) {
  for (const entry of entries) {
    const relativePath = String(entry?.repoRelativePath ?? "").trim();
    if (!relativePath) continue;
    const scriptPath = path.join(scriptsRoot, relativePath);
    const invocation = resolveScriptInvocation(scriptPath);
    await run(invocation.command, invocation.args);
  }
}

async function main() {
  const manifest = await loadManifest(manifestPath);
  await installProfiles(manifest.profiles);
  await runScripts(manifest.toolingScripts);
  await runScripts(manifest.agentScripts);
  if (manifest?.unsafe?.enabled && manifest.unsafe.toolingCommand) {
    await run("sh", ["-lc", manifest.unsafe.toolingCommand]);
  }
  if (manifest?.unsafe?.enabled && manifest.unsafe.agentCommand) {
    await run("sh", ["-lc", manifest.unsafe.agentCommand]);
  }
  await safeRunCommand("sh", ["-lc", "rm -rf /var/lib/apt/lists/*"]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
