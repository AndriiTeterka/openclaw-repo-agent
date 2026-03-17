import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ACP_AGENT_CHOICES,
  classifyTelegramBotProbeResult,
  collectInitPromptState,
  CODEX_AUTH_SOURCE_CHOICES,
  defaultCodexAuthSource,
  describeCommandFromArgv,
  deriveComposeProjectName,
  hasGitignoreEntry,
  looksLikeTelegramBotToken,
  promptChoice,
  selectLatestPendingDeviceRequest,
  selectLatestPendingPairingRequest
} from "../cli/src/cli.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const cliPath = path.resolve("cli/bin/openclaw-repo-agent.mjs");

function createPromptTestContext(tempRoot = repoRoot) {
  return {
    repoRoot: tempRoot,
    detection: {
      projectName: "demo-workspace",
      toolingProfile: "none",
      instructionCandidates: [],
      knowledgeCandidates: [],
      verificationCommands: []
    }
  };
}

function createPromptTestPlugin() {
  return {
    version: 1,
    profile: "custom",
    projectName: "demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfile: "none",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    instructionFiles: [".openclaw/instructions.md"],
    knowledgeFiles: [".openclaw/knowledge.md"],
    verificationCommands: [],
    agent: {
      id: "workspace",
      name: "Demo Workspace"
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "first",
      network: {
        autoSelectFamily: true
      }
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"]
    },
    security: {
      authBootstrapMode: "codex"
    }
  };
}

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

test("update no longer prints raw OpenClaw overview after doctor runs", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /await handleDoctor\(context, \{ \.\.\.options, verify: false \}\);/);
  assert.doesNotMatch(source, /printOpenClawOverview/);
});

test("major command handlers use the shared report renderer", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /printCommandReport\("success", "Init complete"/);
  assert.match(source, /printCommandReport\("success", "Up complete"/);
  assert.match(source, /printCommandReport\(pairResult\.approved \? "success" : "info", "Pairing complete"/);
  assert.match(source, /printCommandReport\("success", "Status"/);
  assert.match(source, /printCommandReport\(ok \? "success" : "warning", "Doctor"/);
  assert.match(source, /printCommandReport\("success", "Update complete"/);
});

test("up resolves and prints the authenticated dashboard URL", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /openclawGatewayCommand\(context, \["dashboard", "--no-open"\], \{ capture: true \}\)/);
  assert.match(source, /const dashboardUrl = await runWithSpinner\("Resolving dashboard URL", \(\) => resolveDashboardUrl\(context\), options\);/);
  assert.match(source, /printCommandReport\("success", "Up complete", \[\s*{ label: "Repo", value: context\.repoRoot },\s*{ label: "Dashboard", value: dashboardUrl }/s);
});

test("up no longer launches a background watcher for dashboard device requests", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.doesNotMatch(source, /spawnDashboardPairWatcher\(/);
  assert.doesNotMatch(source, /watchDashboardPairing\(/);
  assert.doesNotMatch(source, /INTERNAL_DASHBOARD_PAIR_WATCH_COMMAND/);
});

test("pair combines local gateway-device and Telegram pairing approvals", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /pairResult = summarizePairTargets\("local", \[\s*await autoApproveLocalDevicePair\(context\),\s*await autoApproveLocalTelegramPair\(context\)\s*\]\);/s);
  assert.match(source, /const devicePairResult = await approveLocalDevicePair\(context, options\.approve, \{ allowMissing: true \}\);/);
  assert.match(source, /devicePairResult \|\| await approveLocalTelegramPair\(context, options\.approve\)/);
});

test("up validates the Telegram bot token before starting the stack", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");

  assert.match(source, /runWithSpinner\("Validating Telegram bot token", \(\) => ensureTelegramBotTokenReady\(context, state\), options\)/);
  assert.match(source, /runWithSpinner\("Starting OpenClaw stack", \(\) => dockerCompose\(context, buildComposeUpArgs\(state\.useLocalBuild\)\), options\)/);
});

test("down no longer prints repo and project summary lines", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");
  const handleDownBlock = source.match(/async function handleDown\(context\) \{[\s\S]*?\n\}/);

  assert.ok(handleDownBlock, "expected to find handleDown in cli source");
  assert.match(handleDownBlock[0], /printCommandReport\("success", "Down complete", \[\s*{ label: "Instance", value: context\.instanceId },\s*{ label: "Compose", value: context\.composeProjectName },\s*{ label: "Result", value: "OpenClaw gateway stopped" }\s*\]\);/s);
  assert.doesNotMatch(handleDownBlock[0], /{ label: "Repo", value: context\.repoRoot }/);
  assert.doesNotMatch(handleDownBlock[0], /{ label: "Project", value: state\.manifest\.projectName }/);
});

test("pair completion report no longer prints repo, mode, or gateway summary lines", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");
  const handlePairBlock = source.match(/async function handlePair\(context, options\) \{[\s\S]*?\n\}/);

  assert.ok(handlePairBlock, "expected to find handlePair in cli source");
  assert.match(handlePairBlock[0], /printCommandReport\(pairResult\.approved \? "success" : "info", "Pairing complete", \[\s*{ label: "Action", value: pairResult\.action },\s*{ label: "Request", value: pairResult\.requestCode \|\| "\(latest or none\)" },\s*{ label: "Result", value: pairResult\.detail }\s*\], \[\s*buildPairDetailsSection\(pairResult\.targets\)\s*\]\.filter\(Boolean\)\);/s);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \? "success" : "info", "Pairing complete", \[[\s\S]*{ label: "Repo", value: context\.repoRoot }/);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \? "success" : "info", "Pairing complete", \[[\s\S]*{ label: "Mode", value: pairResult\.mode }/);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \? "success" : "info", "Pairing complete", \[[\s\S]*{ label: "Gateway"/);
});

test("pair settings update report drops repo, mode, and gateway summary lines", async () => {
  const source = await fs.readFile(path.join(repoRoot, "cli", "src", "cli.mjs"), "utf8");
  const handlePairBlock = source.match(/async function handlePair\(context, options\) \{[\s\S]*?\n\}/);

  assert.ok(handlePairBlock, "expected to find handlePair in cli source");
  assert.match(handlePairBlock[0], /printCommandReport\(pairResult\.approved \|\| settingsChanged \? "success" : "info", "Pairing settings updated", \[\s*{ label: "Action", value: pairResult\.action },\s*{ label: "Request", value: pairResult\.requestCode \|\| "\(latest or none\)" },\s*{ label: "Allowlists", value: "updated" },\s*{ label: "DM policy", value: localEnv\.OPENCLAW_TELEGRAM_DM_POLICY },\s*{ label: "Group policy", value: localEnv\.OPENCLAW_TELEGRAM_GROUP_POLICY }\s*\], \[\s*buildPairDetailsSection\(pairResult\.targets\)\s*\]\.filter\(Boolean\)\);/s);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \|\| settingsChanged \? "success" : "info", "Pairing settings updated", \[[\s\S]*{ label: "Repo", value: context\.repoRoot }/);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \|\| settingsChanged \? "success" : "info", "Pairing settings updated", \[[\s\S]*{ label: "Mode", value: pairResult\.mode }/);
  assert.doesNotMatch(handlePairBlock[0], /printCommandReport\(pairResult\.approved \|\| settingsChanged \? "success" : "info", "Pairing settings updated", \[[\s\S]*{ label: "Gateway"/);
});

test("version flag prints product version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    cwd: repoRoot
  });

  assert.equal(stdout.trim(), "0.4.0");
});

test("ACP init choices include the supported built-in agents", () => {
  assert.deepEqual(
    ACP_AGENT_CHOICES.map((choice) => choice.value),
    ["codex", "claude", "gemini"]
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

test("looksLikeTelegramBotToken accepts Telegram-style bot tokens", () => {
  assert.equal(looksLikeTelegramBotToken("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"), true);
  assert.equal(looksLikeTelegramBotToken("replace-with-your-botfather-token"), false);
  assert.equal(looksLikeTelegramBotToken("not-a-bot-token"), false);
});

test("classifyTelegramBotProbeResult treats Telegram 404s as definitive token failures", () => {
  assert.deepEqual(
    classifyTelegramBotProbeResult(404, { ok: false, description: "Not Found" }),
    { ok: false, definitiveFailure: true, detail: "Not Found" }
  );
  assert.deepEqual(
    classifyTelegramBotProbeResult(200, { ok: true, result: { username: "demo_bot" } }),
    { ok: true, definitiveFailure: false, detail: "" }
  );
});

test("describeCommandFromArgv keeps the command label while skipping global option values", () => {
  assert.equal(describeCommandFromArgv(["--repo-root", "C:\\demo", "config", "validate", "--product-root=."]), "config validate");
  assert.equal(describeCommandFromArgv(["up", "--json"]), "up");
  assert.equal(describeCommandFromArgv(["--version"]), "");
});

test("promptChoice accepts default and numeric input", async () => {
  const calls = [];
  const prompter = {
    async select(message, choices, fallbackValue) {
      calls.push({ message, choices, fallbackValue });
      return calls.length === 1 ? fallbackValue : "api-key";
    }
  };
  const first = await promptChoice(prompter, "ACP default agent", ACP_AGENT_CHOICES, "codex");
  const second = await promptChoice(prompter, "codex auth source", CODEX_AUTH_SOURCE_CHOICES, "auth-folder");

  assert.equal(first, "codex");
  assert.equal(second, "api-key");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].message, "ACP default agent");
  assert.equal(calls[1].message, "codex auth source");
});

test("collectInitPromptState asks Telegram after Codex auth prompts", async () => {
  const calls = [];
  const prompter = {
    async select(message, choices, fallbackValue) {
      calls.push(`select:${message}:${fallbackValue}`);
      return fallbackValue;
    },
    async input(message) {
      calls.push(`input:${message}`);
      return "";
    },
    async password(message) {
      calls.push(`password:${message}`);
      return "123:telegram-token";
    }
  };

  await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    createPromptTestPlugin(),
    {},
    {},
    "C:/Users/demo/.codex"
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:codex",
    "select:codex auth source:auth-folder",
    "password:Telegram bot token"
  ]);
});

test("collectInitPromptState asks Telegram after ACP selection for non-codex agents", async () => {
  const calls = [];
  const prompter = {
    async select(message, _choices, fallbackValue) {
      calls.push(`select:${message}:${fallbackValue}`);
      return "claude";
    },
    async input(message) {
      calls.push(`input:${message}`);
      return "";
    },
    async password(message) {
      calls.push(`password:${message}`);
      return "123:telegram-token";
    }
  };

  const plugin = createPromptTestPlugin();
  plugin.acp.defaultAgent = "claude";
  plugin.acp.allowedAgents = ["claude"];
  plugin.security.authBootstrapMode = "external";

  await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    plugin,
    {},
    {},
    ""
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:claude",
    "password:Telegram bot token"
  ]);
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
  assert.equal(payload.productVersion, "0.4.0");
});

test("config validation rejects unsupported ACP agents from plugin config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-config-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "plugin.json"), JSON.stringify({
    ...createPromptTestPlugin(),
    acp: {
      defaultAgent: "opencode",
      allowedAgents: ["opencode"]
    }
  }, null, 2));

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "config", "validate", "--repo-root", repoPath, "--product-root=."], {
      cwd: repoRoot
    }),
    (error) => {
      assert.match(error.stderr, /Unsupported acp\.defaultAgent: opencode/i);
      return true;
    }
  );
});

test("config validation rejects unsupported ACP agents from local env overrides", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-env-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "plugin.json"), JSON.stringify(createPromptTestPlugin(), null, 2));
  await fs.writeFile(path.join(openclawPath, "local.env"), "OPENCLAW_ACP_DEFAULT_AGENT=opencode\n");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "config", "validate", "--repo-root", repoPath, "--product-root=."], {
      cwd: repoRoot
    }),
    (error) => {
      assert.match(error.stderr, /Unsupported OPENCLAW_ACP_DEFAULT_AGENT: opencode/i);
      return true;
    }
  );
});

test("config validation rejects unsupported ACP agents from CLI flags", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-flag-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "plugin.json"), JSON.stringify(createPromptTestPlugin(), null, 2));

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "config",
      "validate",
      "--repo-root",
      repoPath,
      "--product-root=.",
      "--acp-default-agent",
      "opencode"
    ], {
      cwd: repoRoot
    }),
    (error) => {
      assert.match(error.stderr, /Unsupported --acp-default-agent: opencode/i);
      return true;
    }
  );
});

test("fatal command failures reuse the success-style heading with the command name", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "up", "--definitely-bad-option"], {
      cwd: repoRoot
    }),
    (error) => {
      assert.match(error.stderr, /FAIL\s+'up' could not be completed/i);
      assert.match(error.stderr, /Unknown option: --definitely-bad-option/i);
      assert.doesNotMatch(error.stderr, /📄\s+DETAILS/);
      return true;
    }
  );
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

test("selectLatestPendingDeviceRequest returns the newest pending device request", () => {
  const selected = selectLatestPendingDeviceRequest({
    pending: [
      { requestId: "older", ts: 1000 },
      { requestId: "newest", ts: 4000 },
      { requestId: "middle", ts: 3000 }
    ]
  });

  assert.equal(selected?.requestId, "newest");
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
        localRuntimeImage: "openclaw-repo-agent-runtime:0.4.0-repo-one-deadbeef",
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

