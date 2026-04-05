import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { DEFAULT_PLUGIN_CONFIG } from "../cli/src/builtin-profiles.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const cliPath = path.resolve("cli/bin/openclaw-repo-agent.mjs");

async function writeFakeDocker(binDir, logFile) {
  const script = path.join(binDir, "docker-fake.mjs");
  await fs.writeFile(script, `
import fs from "node:fs/promises";
const logFile = ${JSON.stringify(logFile.replace(/\\/g, "\\\\"))};
const args = process.argv.slice(2);
await fs.appendFile(logFile, \`\${args.join(" ")}\\n\`, "utf8");
if (args[0] === "pull") {
  process.stdout.write("pulled\\n");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect" && String(args[2] || "").includes("runtime-core")) {
  process.stdout.write(JSON.stringify([{ RepoDigests: ["ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core@sha256:5595088095c78a6ef0bfbb02f8fc72de980f4263be00a81ef94590834f0f484e"], Id: "sha256:5595088095c78a6ef0bfbb02f8fc72de980f4263be00a81ef94590834f0f484e" }]));
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect" && String(args[2] || "").includes("openclaw-repo-agent-tooling")) {
  process.stderr.write("missing");
  process.exit(1);
}
if (args[0] === "build") {
  process.stdout.write("built\\n");
  process.exit(0);
}
if (args[0] === "compose" && args.includes("ps")) {
  process.exit(0);
}
process.exit(0);
`, "utf8");
  if (process.platform === "win32") {
    const shim = path.join(binDir, "docker.cmd");
    await fs.writeFile(shim, `@echo off\r\nnode "%~dp0docker-fake.mjs" %*\r\n`);
  } else {
    const shim = path.join(binDir, "docker");
    await fs.writeFile(shim, `#!/usr/bin/env sh\nnode "$(dirname "$0")/docker-fake.mjs" "$@"\n`);
    await fs.chmod(shim, 0o755);
  }
}

test("status --refresh uses docker from PATH and materializes runtime through the fake docker shim", {
  skip: process.platform === "win32" ? "Windows resolves docker.exe ahead of a scripted shim; commandRunner seam covers this path in-process." : false
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fake-docker-"));
  const tempRepo = path.join(tempRoot, "repo");
  const binDir = path.join(tempRoot, "bin");
  const logFile = path.join(tempRoot, "docker.log");
  await fs.mkdir(path.join(tempRepo, ".openclaw"), { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await writeFakeDocker(binDir, logFile);

  await fs.writeFile(path.join(tempRepo, ".openclaw", "config.json"), `${JSON.stringify({
    ...DEFAULT_PLUGIN_CONFIG,
    projectName: "demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfiles: ["node22"],
    tooling: {
      installScripts: [],
      allowUnsafeCommands: false
    },
    agent: {
      ...DEFAULT_PLUGIN_CONFIG.agent,
      installScripts: []
    }
  }, null, 2)}\n`);

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "status",
    "--refresh",
    "--json",
    "--repo-root",
    tempRepo,
    "--product-root",
    repoRoot
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
      OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts"),
      OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD: "false",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || process.env.Path || ""}`,
      Path: `${binDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`
    }
  });

  const payload = JSON.parse(stdout);
  const log = await fs.readFile(logFile, "utf8");

  assert.equal(payload.runtime.runtimeCoreDigest, "sha256:5595088095c78a6ef0bfbb02f8fc72de980f4263be00a81ef94590834f0f484e");
  assert.match(payload.runtime.toolingImage, /^openclaw-repo-agent-tooling:v2-/);
  assert.match(log, /pull ghcr\.io\/andriiteterka\/openclaw-repo-agent-runtime-core:0\.4\.0/);
  assert.match(log, /image inspect ghcr\.io\/andriiteterka\/openclaw-repo-agent-runtime-core:0\.4\.0/);
  assert.match(log, /build --file Dockerfile\.tooling/);
});
