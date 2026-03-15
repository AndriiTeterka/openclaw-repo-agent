import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ACP_AGENT_CHOICES,
  CODEX_AUTH_SOURCE_CHOICES,
  defaultCodexAuthSource,
  deriveComposeProjectName,
  hasGitignoreEntry,
  promptChoice,
  selectLatestPendingPairingRequest
} from "../cli/src/cli.mjs";

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
  assert.match(stdout, /mcp use/);
  assert.match(stdout, /instances list/);
  assert.equal(stderr, "");
});

test("subcommand help prints usage instead of failing", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--help"], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage:/);
});

test("interactive init prompt strings no longer include repo settings or Telegram policy prompts", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.doesNotMatch(source, /Detected repo settings:/);
  assert.doesNotMatch(source, /Override detected repo settings now \[no\]:/);
  assert.doesNotMatch(source, /Telegram DM policy \[/);
  assert.doesNotMatch(source, /Telegram group policy \[/);
});

test("update keeps printing the OpenClaw overview after doctor runs", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /await handleDoctor\(context, \{ \.\.\.options, verify: false \}\);[\s\S]*await printOpenClawOverview\(context\);/);
});

test("major command handlers print overview tables", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /printOverviewTable\("Init Summary"/);
  assert.match(source, /printOverviewTable\("Up Summary"/);
  assert.match(source, /printOverviewTable\("Pair Summary"/);
  assert.match(source, /printOverviewTable\("Status Summary"/);
  assert.match(source, /printOverviewTable\("Doctor Summary"/);
  assert.match(source, /printOverviewTable\("Update Summary"/);
});

test("version flag prints product version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    cwd: repoRoot
  });

  assert.equal(stdout.trim(), "0.3.1");
});

test("ACP init choices include the supported built-in agents", () => {
  assert.deepEqual(
    ACP_AGENT_CHOICES.map((choice) => choice.value),
    ["codex", "claude", "gemini", "opencode", "pi"]
  );
});

test("Codex auth-source choices remain folder-first with API key fallback", () => {
  assert.deepEqual(
    CODEX_AUTH_SOURCE_CHOICES.map((choice) => choice.value),
    ["auth-folder", "api-key"]
  );
});

test("defaultCodexAuthSource prefers detected auth folders over API keys", () => {
  assert.equal(defaultCodexAuthSource({ OPENAI_API_KEY: "sk-test" }, {}, "C:/Users/demo/.codex"), "auth-folder");
  assert.equal(defaultCodexAuthSource({ OPENAI_API_KEY: "sk-test" }, {}, ""), "api-key");
  assert.equal(defaultCodexAuthSource({}, {}, ""), "auth-folder");
});

test("promptChoice accepts default and numeric input", async () => {
  const answers = ["", "2"];
  const prompts = [];
  const rl = {
    async question(prompt) {
      prompts.push(prompt);
      return answers.shift() ?? "";
    }
  };
  const writes = [];
  const originalLog = console.log;
  console.log = (...values) => writes.push(values.join(" "));
  try {
    const first = await promptChoice(rl, "ACP default agent", ACP_AGENT_CHOICES, "codex");
    const second = await promptChoice(rl, "Codex auth source", CODEX_AUTH_SOURCE_CHOICES, "auth-folder");

    assert.equal(first, "codex");
    assert.equal(second, "api-key");
    assert.ok(prompts.length >= 2);
    assert.ok(writes.some((line) => line.includes("ACP default agent:")));
  } finally {
    console.log = originalLog;
  }
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
  assert.equal(payload.productVersion, "0.3.1");
});

test("deriveComposeProjectName uses the repo identity and prefix", () => {
  assert.match(deriveComposeProjectName("C:\\Users\\ateterka\\appium-test-project"), /^openclaw-appium-test-project-[a-f0-9]{8}$/);
  assert.match(deriveComposeProjectName("C:\\Users\\ateterka\\Repo With Spaces"), /^openclaw-repo-with-spaces-[a-f0-9]{8}$/);
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

test("example consumer repo ignores the full .openclaw directory", async () => {
  const gitignore = await fs.readFile(path.join(repoRoot, "examples", "custom", ".gitignore"), "utf8");

  assert.match(gitignore, /^\.openclaw\/$/m);
});

test("hasGitignoreEntry only matches effective top-level .openclaw ignore rules", () => {
  assert.equal(hasGitignoreEntry(".openclaw/\n", ".openclaw/"), true);
  assert.equal(hasGitignoreEntry("/.openclaw\n", ".openclaw/"), true);
  assert.equal(hasGitignoreEntry("# .openclaw/\n.openclaw/*.json\n", ".openclaw/"), false);
});

test("instances list reads the machine-local registry", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-instances-"));
  const registryDir = path.join(tempRoot, "openclaw-repo-agent");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(registryDir, "instances.json"), JSON.stringify({
    version: 1,
    instances: {
      "repo-one-deadbeef": {
        instanceId: "repo-one-deadbeef",
        repoRoot: "C:/repo-one",
        repoSlug: "repo-one",
        composeProjectName: "openclaw-repo-one-deadbeef",
        gatewayPort: "20001",
        portManaged: true,
        telegramTokenHash: "",
        localRuntimeImage: "openclaw-repo-agent-runtime:0.3.1-repo-one-deadbeef",
        dockerMcpProfile: "openclaw-repo-one-deadbeef",
        lastSeenAt: "2026-03-12T00:00:00.000Z"
      }
    }
  }, null, 2));

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "instances",
    "list",
    "--json=true"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENCLAW_REPO_AGENT_STATE_HOME: tempRoot
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.instances.length, 1);
  assert.equal(payload.instances[0].instanceId, "repo-one-deadbeef");
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

