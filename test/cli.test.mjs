import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { deriveComposeProjectName, selectLatestPendingPairingRequest } from "../cli/src/cli.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const cliPath = path.resolve("cli/bin/openclaw-repo-agent.mjs");

test("global help prints usage", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Commands:/);
  assert.match(stdout, /mcp setup/);
  assert.equal(stderr, "");
});

test("subcommand help prints usage instead of failing", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--help"], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage:/);
});

test("version flag prints product version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    cwd: repoRoot
  });

  assert.equal(stdout.trim(), "0.1.5");
});

test("inline option syntax works for config validation", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root=./examples/custom",
    "--product-root=.",
    "--json=true"
  ], {
    cwd: repoRoot
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.productVersion, "0.1.5");
});

test("deriveComposeProjectName uses the repo directory slug", () => {
  assert.equal(deriveComposeProjectName("C:\\Users\\ateterka\\appium-test-project"), "appium-test-project");
  assert.equal(deriveComposeProjectName("C:\\Users\\ateterka\\Repo With Spaces"), "repo-with-spaces");
});

test("selectLatestPendingPairingRequest chooses the newest request from common payload shapes", () => {
  const request = selectLatestPendingPairingRequest({
    requests: [
      { code: "OLDER123", requested: "2026-03-12T14:47:37.222Z" },
      { code: "NEWEST99", requestedAt: "2026-03-12T15:47:37.222Z" }
    ]
  });

  assert.equal(request?.code, "NEWEST99");
});

test("config validation upgrades legacy codex repos to codex defaults", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-test-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  const codexHome = path.join(tempRoot, "codex-home");

  await fs.mkdir(openclawPath, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
  await fs.writeFile(path.join(openclawPath, "plugin.json"), JSON.stringify({
    version: 1,
    profile: "custom",
    projectName: "legacy-codex",
    deploymentProfile: "docker-local",
    toolingProfile: "none",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    instructionFiles: [".openclaw/instructions.md"],
    knowledgeFiles: [".openclaw/knowledge.md"],
    verificationCommands: [],
    agent: {
      id: "workspace",
      name: "Legacy Codex Workspace",
      maxConcurrent: 4,
      skipBootstrap: true,
      defaultModel: ""
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "first"
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      preferredMode: "oneshot"
    },
    security: {
      authBootstrapMode: "external"
    }
  }, null, 2));

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root",
    repoPath,
    "--product-root=.",
    "--json=true"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin.agent.defaultModel, "openai-codex/gpt-5.4");
  assert.equal(payload.plugin.security.authBootstrapMode, "external");
  assert.equal(payload.manifest.agent.defaultModel, "openai-codex/gpt-5.4");
  assert.equal(payload.manifest.security.authBootstrapMode, "codex");
});
