import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ACP_AGENT_CHOICES,
  buildDashboardUrl,
  buildRuntimeCoreBuildArgs,
  buildRuntimeCoreOverlayBuildArgs,
  classifyTelegramBotProbeResult,
  collectInitPromptState,
  CODEX_AUTH_SOURCE_CHOICES,
  COPILOT_AUTH_SOURCE_CHOICES,
  buildComposeBuildArgs,
  buildComposeUpArgs,
  buildCopilotCredentialTargets,
  describeCommandFromArgv,
  ensureGitExcludeEntries,
  GEMINI_AUTH_SOURCE_CHOICES,
  hasIgnoreEntry,
  inferImplicitAllowedAgents,
  looksLikeTelegramBotToken,
  normalizePluginConfig,
  promptChoice,
  resolveRuntimeCommandEnv,
  resolveGitInfoExcludePath,
  selectLatestPendingDeviceRequest,
  selectLatestPendingPairingRequest,
  shouldRetryComposeUpFailure,
  shouldAutoHealGatewayPortConflict
} from "../cli/src/cli.mjs";
import { resolveInitProviderAvailability } from "../cli/src/commands/init.mjs";
import { probeTelegramBotToken } from "../cli/src/commands/up.mjs";
import { buildInstanceMetadata, deriveComposeProjectName } from "../cli/src/instance-registry.mjs";
import { PRODUCT_VERSION } from "../cli/src/product-metadata.mjs";
import { resolveAgentPaths } from "../cli/src/state-layout.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const cliPath = path.resolve("cli/bin/openclaw-repo-agent.mjs");
const modelDiscoveryEnv = {
  OPENCLAW_MODEL_DISCOVERY_CODEX_BINARY: path.resolve("test/fixtures/model-discovery/codex-binary.txt"),
  OPENCLAW_MODEL_DISCOVERY_GEMINI_MODELS_JS: path.resolve("test/fixtures/model-discovery/gemini-models.fixture.js")
};

function createStateHomeEnv(tempRoot) {
  return {
    OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
    OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts")
  };
}

async function writeMachineLocalSecrets(repoPath, stateHomeEnv, contents) {
  const instance = buildInstanceMetadata(repoPath);
  const paths = resolveAgentPaths(repoPath, instance.instanceId, stateHomeEnv);
  await fs.mkdir(path.dirname(paths.secretsEnvFile), { recursive: true });
  await fs.writeFile(paths.secretsEnvFile, contents);
  return paths;
}

function createPromptTestContext(tempRoot = repoRoot) {
  return {
    repoRoot: tempRoot,
    detection: {
      projectName: "demo-workspace",
      toolingProfiles: [],
      stack: {
        languages: [],
        tools: []
      }
    }
  };
}

function createPromptTestPlugin() {
  return {
    projectName: "demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: []
    },
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    agent: {
      id: "workspace",
      name: "Demo Workspace"
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "all",
      threadBindings: {
        spawnAcpSessions: false
      },
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
  assert.match(stdout, /instances list/);
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

  assert.equal(stdout.trim(), PRODUCT_VERSION);
});

test("ACP init choices include the supported built-in agents", () => {
  assert.deepEqual(
    ACP_AGENT_CHOICES.map((choice) => choice.value),
    ["codex", "gemini", "copilot"]
  );
});

test("Codex auth-source choices only expose subscription login", () => {
  assert.deepEqual(
    CODEX_AUTH_SOURCE_CHOICES,
    [{ value: "auth-folder", label: "Use OpenAI subscription login" }]
  );
});

test("Gemini auth-source choices only expose subscription login", () => {
  assert.deepEqual(
    GEMINI_AUTH_SOURCE_CHOICES,
    [
      { value: "auth-folder", label: "Use Gemini subscription login" }
    ]
  );
});

test("Copilot auth-source choices only expose subscription login", () => {
  assert.deepEqual(
    COPILOT_AUTH_SOURCE_CHOICES,
    [
      { value: "auth-folder", label: "Use GitHub Copilot subscription login" }
    ]
  );
});

test("buildCopilotCredentialTargets includes both bare and LegacyGeneric credential manager targets", () => {
  const targets = buildCopilotCredentialTargets({
    logged_in_users: [
      {
        host: "https://github.com",
        login: "andrii-teterka13"
      }
    ]
  });

  assert.ok(targets.includes("copilot-cli/https://github.com:andrii-teterka13"));
  assert.ok(targets.includes("LegacyGeneric:target=copilot-cli/https://github.com:andrii-teterka13"));
  assert.ok(targets.includes("copilot-cli/github.com:andrii-teterka13"));
  assert.ok(targets.includes("LegacyGeneric:target=copilot-cli/github.com:andrii-teterka13"));
});

test("resolveRuntimeCommandEnv prefers explicit Copilot env tokens over host lookup", async () => {
  let resolverCalls = 0;
  const result = await resolveRuntimeCommandEnv(
    { COPILOT_GITHUB_TOKEN: "ghu_explicit_token_1234567890" },
    {},
    {
      baseEnv: {},
      async resolveCopilotToken() {
        resolverCalls += 1;
        return "ghu_host_token_should_not_be_used_1234567890";
      }
    }
  );

  assert.equal(resolverCalls, 0);
  assert.deepEqual(result, {
    COPILOT_GITHUB_TOKEN: "ghu_explicit_token_1234567890"
  });
});

test("resolveRuntimeCommandEnv bridges a host Copilot login into docker compose env", async () => {
  const result = await resolveRuntimeCommandEnv(
    {},
    { copilot: "C:/Users/demo/.copilot" },
    {
      baseEnv: {},
      async resolveCopilotToken(localEnv, detectedAuthPaths) {
        assert.deepEqual(localEnv, {});
        assert.deepEqual(detectedAuthPaths, { copilot: "C:/Users/demo/.copilot" });
        return "ghu_host_token_1234567890";
      }
    }
  );

  assert.deepEqual(result, {
    COPILOT_GITHUB_TOKEN: "ghu_host_token_1234567890"
  });
});

test("inferImplicitAllowedAgents expands implicit provider list from detected auth folders", () => {
  const allowedAgents = inferImplicitAllowedAgents(
    "codex",
    {},
    {
      gemini: "C:/Users/demo/.gemini",
      copilot: "C:/Users/demo/.copilot"
    },
    "codex"
  );

  assert.deepEqual(allowedAgents, ["codex", "gemini", "copilot"]);
});

test("resolveInitProviderAvailability summarizes loaded and unavailable providers", () => {
  const availability = resolveInitProviderAvailability("codex", ["codex", "gemini", "copilot"], {
    codex: "C:/Users/demo/.codex",
    copilot: "C:/Users/demo/.copilot"
  });

  assert.deepEqual(availability.loadedProviders.map((entry) => entry.agentId), ["codex", "copilot"]);
  assert.deepEqual(availability.unavailableProviders.map((entry) => entry.agentId), ["gemini"]);
  assert.equal(availability.selectedProviderLoaded, true);
  assert.deepEqual(availability.summaryItems, [
    "Loaded: Codex, Copilot",
    "Unavailable: Gemini"
  ]);
});

test("buildComposeBuildArgs builds the local tooling layer only", () => {
  assert.deepEqual(buildComposeBuildArgs(), ["build", "openclaw-gateway"]);
});

test("buildRuntimeCoreBuildArgs builds the shared runtime-core image locally with fresh upstream layers", () => {
  assert.deepEqual(
    buildRuntimeCoreBuildArgs("ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest"),
    [
      "build",
      "--pull",
      "--file",
      "runtime/Dockerfile.core",
      "--tag",
      "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      "."
    ]
  );
});

test("buildRuntimeCoreOverlayBuildArgs layers local runtime files onto the selected runtime-core image", () => {
  assert.deepEqual(
    buildRuntimeCoreOverlayBuildArgs(
      "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      "openclaw-repo-agent-runtime-core-fallback:v1-test"
    ),
    [
      "build",
      "--file",
      "runtime/Dockerfile.core.overlay",
      "--tag",
      "openclaw-repo-agent-runtime-core-fallback:v1-test",
      "--build-arg",
      "OPENCLAW_RUNTIME_CORE_BASE_IMAGE=ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      "."
    ]
  );
});

test("buildComposeUpArgs avoids forced recreation by default", () => {
  assert.deepEqual(buildComposeUpArgs(), ["up", "-d", "--wait", "--wait-timeout", "300"]);
  assert.deepEqual(
    buildComposeUpArgs({ forceRecreate: true }),
    ["up", "-d", "--wait", "--wait-timeout", "300", "--force-recreate"]
  );
});

test("shouldRetryComposeUpFailure recognizes transient compose startup races", () => {
  assert.equal(
    shouldRetryComposeUpFailure({ stderr: "Network openclaw-demo_default Creating\nContainer demo-openclaw-gateway-1 Recreate" }),
    true
  );
  assert.equal(
    shouldRetryComposeUpFailure({ stdout: "timed out waiting for the condition" }),
    true
  );
  assert.equal(
    shouldRetryComposeUpFailure({ stderr: "Auth bootstrap failed for: codex, gemini, copilot." }),
    false
  );
});

test("buildDashboardUrl includes the gateway token when present", () => {
  assert.equal(
    buildDashboardUrl("28553", "mmxca0bj72gl86nti4627medqs1tkr"),
    "http://127.0.0.1:28553/#token=mmxca0bj72gl86nti4627medqs1tkr"
  );
  assert.equal(buildDashboardUrl("28553"), "http://127.0.0.1:28553/");
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

test("probeTelegramBotToken uses node:https without throwing a reference error", async (t) => {
  const calls = [];
  t.mock.method(https, "get", (url, options, callback) => {
    calls.push({ url, options });
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", JSON.stringify({ ok: true, result: { username: "demo_bot" } }));
      response.emit("end");
    });
    return request;
  });

  assert.deepEqual(
    await probeTelegramBotToken("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"),
    {
      statusCode: 200,
      payload: { ok: true, result: { username: "demo_bot" } },
      ok: true,
      definitiveFailure: false,
      detail: ""
    }
  );
  assert.deepEqual(calls, [{
    url: "https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi/getMe",
    options: { timeout: 5000 }
  }]);
});

test("describeCommandFromArgv keeps the command label while skipping global option values", () => {
  assert.equal(describeCommandFromArgv(["--repo-root", "C:\\demo", "config", "validate", "--product-root=."]), "config validate");
  assert.equal(describeCommandFromArgv(["up", "--json"]), "up");
  assert.equal(describeCommandFromArgv(["--version"]), "");
});

test("promptChoice delegates to the custom selector", async () => {
  const calls = [];
  const prompter = {
    async select(message, choices, fallbackValue) {
      calls.push({ message, choices, fallbackValue });
      return fallbackValue;
    }
  };
  const first = await promptChoice(prompter, "ACP default agent", ACP_AGENT_CHOICES, "codex");
  const second = await promptChoice(prompter, "codex auth source", CODEX_AUTH_SOURCE_CHOICES, "auth-folder");

  assert.equal(first, "codex");
  assert.equal(second, "auth-folder");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].message, "ACP default agent");
  assert.equal(calls[1].message, "codex auth source");
});

test("collectInitPromptState asks Telegram after ACP selection for Codex", async () => {
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
    { codex: "C:/Users/demo/.codex" }
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:codex",
    "password:Telegram bot token"
  ]);
});

test("collectInitPromptState asks Telegram after ACP selection for Gemini", async () => {
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

  const plugin = createPromptTestPlugin();
  plugin.acp.defaultAgent = "gemini";
  plugin.acp.allowedAgents = ["gemini"];
  plugin.security.authBootstrapMode = "gemini";

  await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    plugin,
    {},
    {},
    { gemini: "C:/Users/demo/.gemini" }
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:gemini",
    "password:Telegram bot token"
  ]);
});

test("collectInitPromptState asks Telegram after ACP selection for Copilot", async () => {
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

  const plugin = createPromptTestPlugin();
  plugin.acp.defaultAgent = "copilot";
  plugin.acp.allowedAgents = ["copilot"];
  plugin.security.authBootstrapMode = "copilot";

  await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    plugin,
    {},
    {},
    { copilot: "C:/Users/demo/.copilot" }
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:copilot",
    "password:Telegram bot token"
  ]);
});

test("collectInitPromptState preserves detected auth folders and selected auth sources", async () => {
  const prompter = {
    async select(_message, _choices, fallbackValue) {
      return fallbackValue;
    },
    async input() {
      return "";
    },
    async password() {
      return "123:telegram-token";
    }
  };

  const result = await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    createPromptTestPlugin(),
    {},
    {},
    { codex: "C:/Users/demo/.codex", gemini: "C:/Users/demo/.gemini", copilot: "C:/Users/demo/.copilot" }
  );

  assert.equal(result.localEnv.OPENCLAW_CODEX_AUTH_SOURCE, "auth-folder");
  assert.equal(result.localEnv.OPENCLAW_GEMINI_AUTH_SOURCE, "auth-folder");
  assert.equal(result.localEnv.OPENCLAW_COPILOT_AUTH_SOURCE, "auth-folder");
});

test("collectInitPromptState asks Telegram after ACP selection for non-codex agents", async () => {
  const calls = [];
  const prompter = {
    async select(message, _choices, fallbackValue) {
      calls.push(`select:${message}:${fallbackValue}`);
      return "gemini";
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
  plugin.acp.defaultAgent = "gemini";
  plugin.acp.allowedAgents = ["gemini"];
  plugin.security.authBootstrapMode = "gemini";

  await collectInitPromptState(
    prompter,
    createPromptTestContext(),
    plugin,
    {},
    {},
    { gemini: "C:/Users/demo/.gemini" }
  );

  assert.deepEqual(calls, [
    "select:ACP default agent:gemini",
    "password:Telegram bot token"
  ]);
});

test("collectInitPromptState fails when no provider auth is detected", async () => {
  await assert.rejects(
    collectInitPromptState(
      {
        async select() {
          return "codex";
        },
        async input() {
          return "";
        },
        async password() {
          return "123:telegram-token";
        }
      },
      createPromptTestContext(),
      createPromptTestPlugin(),
      {},
      {},
      {}
    ),
    /No provider subscription login was detected/i
  );
});

test("shouldAutoHealGatewayPortConflict heals stale legacy and managed registry reservations only", () => {
  assert.equal(
    shouldAutoHealGatewayPortConflict(
      { OPENCLAW_GATEWAY_PORT: "18789", OPENCLAW_PORT_MANAGED: "false" },
      {
        duplicateAssignment: { instanceId: "stale-repo" },
        registryOnlyConflict: true
      }
    ),
    true
  );

  assert.equal(
    shouldAutoHealGatewayPortConflict(
      { OPENCLAW_GATEWAY_PORT: "24567", OPENCLAW_PORT_MANAGED: "true" },
      {
        duplicateAssignment: { instanceId: "stale-repo" },
        registryOnlyConflict: true
      }
    ),
    true
  );

  assert.equal(
    shouldAutoHealGatewayPortConflict(
      { OPENCLAW_GATEWAY_PORT: "24567", OPENCLAW_PORT_MANAGED: "false" },
      {
        duplicateAssignment: { instanceId: "stale-repo" },
        registryOnlyConflict: true
      }
    ),
    false
  );

  assert.equal(
    shouldAutoHealGatewayPortConflict(
      { OPENCLAW_GATEWAY_PORT: "18789", OPENCLAW_PORT_MANAGED: "false" },
      {
        duplicateAssignment: { instanceId: "live-repo" },
        registryOnlyConflict: false
      }
    ),
    false
  );
});

test("normalizePluginConfig defaults projectName from the repo root and keeps derived tooling profiles and stack", () => {
  const plugin = normalizePluginConfig({}, "C:/repo", {
    projectName: "detected-repo",
    toolingProfiles: ["node22"],
    stack: {
      languages: ["typescript"],
      tools: ["pnpm"]
    }
  });

  assert.equal(plugin.projectName, "repo");
  assert.match(plugin.agent.name, /^repo-[a-f0-9]{8}$/);
  assert.deepEqual(plugin.toolingProfiles, ["node22"]);
  assert.deepEqual(plugin.stack, {
    languages: ["typescript"],
    tools: ["pnpm"]
  });
});

test("inline option syntax works for config validation", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root=./test/fixtures/custom",
    "--product-root=.",
    "--json=true"
  ], {
    cwd: repoRoot
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.productVersion, PRODUCT_VERSION);
});

test("config validation auto-detects additional allowed agents from detected provider auth", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-auto-agents-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  const copilotHome = path.join(tempRoot, ".copilot");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    ...createPromptTestPlugin(),
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"]
    }
  }, null, 2));
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({ logged_in_users: [] }));

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root",
    repoPath,
    "--product-root",
    ".",
    "--json"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      CODEX_HOME: path.join(tempRoot, ".codex-missing"),
      GEMINI_CLI_HOME: path.join(tempRoot, ".gemini-missing"),
      COPILOT_HOME: copilotHome
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.manifest.acp.allowedAgents, ["codex", "copilot"]);
});

test("config validation does not materialize repo-local command event logs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-no-events-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify(createPromptTestPlugin(), null, 2));

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root",
    repoPath,
    "--product-root=.",
    "--json"
  ], {
    cwd: repoRoot
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  const runtimeEntries = await fs.readdir(path.join(openclawPath, "runtime")).catch(() => []);
  assert.deepEqual(runtimeEntries, []);
});

test("config validation rejects deprecated Telegram keys", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-deprecated-telegram-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    ...createPromptTestPlugin(),
    telegram: {
      ...createPromptTestPlugin().telegram,
      proxy: "http://127.0.0.1:8080"
    }
  }, null, 2));

  await assert.rejects(
    execFileAsync(process.execPath, [
      cliPath,
      "config",
      "validate",
      "--repo-root",
      repoPath,
      "--product-root=."
    ], {
      cwd: repoRoot
    }),
    (error) => {
      assert.match(error.stderr, /Deprecated telegram keys in config\.json: telegram\.proxy/i);
      return true;
    }
  );
});

test("config validation rejects unsupported ACP agents from plugin config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-config-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
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

test("config validation rejects unsupported ACP agents from config overrides", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-env-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    ...createPromptTestPlugin(),
    acp: { defaultAgent: "opencode", allowedAgents: ["opencode"] }
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

test("config validation rejects unsupported ACP agents from CLI flags", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bad-acp-flag-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify(createPromptTestPlugin(), null, 2));

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

test("removed migration commands are rejected", async () => {
  for (const argv of [
    [cliPath, "migrate-state"],
    [cliPath, "cleanup-state"],
    [cliPath, "config", "migrate"]
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, argv, { cwd: repoRoot }),
      (error) => {
        assert.match(error.stderr, /Unknown command:/i);
        return true;
      }
    );
  }
});

test("removed hidden pair flags are rejected", async () => {
  for (const argv of [
    [cliPath, "pair", "--allow-user", "123"],
    [cliPath, "pair", "--group-allow-user", "456"],
    [cliPath, "pair", "--switch-dm-policy", "approved"],
    [cliPath, "pair", "--switch-group-policy", "approved"],
    [cliPath, "pair", "--telegram-proxy", "http://127.0.0.1:8080"]
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, argv, { cwd: repoRoot }),
      (error) => {
        assert.match(error.stderr, /Unknown option:/i);
        return true;
      }
    );
  }
});

test("removed API-key flags are rejected", async () => {
  for (const argv of [
    [cliPath, "up", "--openai-api-key", "sk-test"],
    [cliPath, "up", "--gemini-api-key", "gem-test"],
    [cliPath, "up", "--github-token", "ghp-test"]
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, argv, { cwd: repoRoot }),
      (error) => {
        assert.match(error.stderr, /Unknown option:/i);
        return true;
      }
    );
  }
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

test("example consumer repo does not commit generated runtime files beyond the transient event log", async () => {
  const runtimeDir = path.join(repoRoot, "test", "fixtures", "custom", ".openclaw", "runtime");
  const entries = (await fs.readdir(runtimeDir).catch(() => []))
    .filter((entry) => entry !== "events.jsonl");
  assert.deepEqual(entries, []);
});

test("ensureGitExcludeEntries writes .openclaw to .git/info/exclude without editing .gitignore", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-exclude-"));
  const repoPath = path.join(tempRoot, "repo");
  const gitInfoPath = path.join(repoPath, ".git", "info");
  await fs.mkdir(gitInfoPath, { recursive: true });
  await fs.writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n");

  const changed = await ensureGitExcludeEntries(repoPath);

  assert.equal(changed, true);
  assert.equal(await resolveGitInfoExcludePath(repoPath), path.join(repoPath, ".git", "info", "exclude"));
  assert.match(await fs.readFile(path.join(repoPath, ".git", "info", "exclude"), "utf8"), /^\.openclaw\/$/m);
  assert.equal(await fs.readFile(path.join(repoPath, ".gitignore"), "utf8"), "node_modules/\n");
});

test("ensureGitExcludeEntries resolves git worktree gitdir files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-worktree-"));
  const repoPath = path.join(tempRoot, "repo");
  const gitDir = path.join(tempRoot, "actual-git-dir");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(path.join(gitDir, "info"), { recursive: true });
  await fs.writeFile(path.join(repoPath, ".git"), "gitdir: ../actual-git-dir\n");

  const changed = await ensureGitExcludeEntries(repoPath);

  assert.equal(changed, true);
  assert.equal(await resolveGitInfoExcludePath(repoPath), path.join(gitDir, "info", "exclude"));
  assert.match(await fs.readFile(path.join(gitDir, "info", "exclude"), "utf8"), /^\.openclaw\/$/m);
});

test("hasIgnoreEntry only matches effective top-level .openclaw ignore rules", () => {
  assert.equal(hasIgnoreEntry(".openclaw/\n", ".openclaw/"), true);
  assert.equal(hasIgnoreEntry("/.openclaw\n", ".openclaw/"), true);
  assert.equal(hasIgnoreEntry("# .openclaw/\n.openclaw/*.json\n", ".openclaw/"), false);
});

test("instances list reads the machine-local registry", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-instances-"));
  const registryDir = path.join(tempRoot, "openclaw-repo-agent");
  await fs.mkdir(registryDir, { recursive: true });
  await fs.writeFile(path.join(registryDir, "instances.json"), JSON.stringify({
    version: 2,
    instances: {
      "repo-one-deadbeef": {
        instanceId: "repo-one-deadbeef",
        repoRoot: "C:/repo-one",
        repoSlug: "repo-one",
        composeProjectName: "openclaw-repo-one-deadbeef",
        gatewayPort: "20001",
        portManaged: true,
        telegramTokenHash: "",
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

test("paths --json only returns canonical paths", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-paths-"));
  const repoPath = path.join(tempRoot, "repo");
  const stateHomeEnv = createStateHomeEnv(tempRoot);
  await fs.mkdir(path.join(repoPath, ".openclaw"), { recursive: true });

  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "paths",
    "--repo-root",
    repoPath,
    "--product-root=.",
    "--json=true"
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...stateHomeEnv
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.repoRoot, repoPath);
  assert.equal(payload.legacy, undefined);
  assert.equal(payload.eventLogFile, path.join(repoPath, ".openclaw", "runtime", "events.jsonl"));
  assert.ok(payload.secretsEnvFile);
  assert.ok(payload.runtimeEnvFile);
  assert.ok(payload.playwrightDir);
});

test("config validation preserves explicit external auth mode for codex workspaces", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-test-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  const codexHome = path.join(tempRoot, "codex-home");

  await fs.mkdir(openclawPath, { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    projectName: "legacy-codex",
    deploymentProfile: "docker-local",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: []
    },
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
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
      replyToMode: "all",
      threadBindings: {
        spawnAcpSessions: false
      }
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
      ...modelDiscoveryEnv,
      CODEX_HOME: codexHome
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin.agent.defaultModel, "");
  assert.equal(payload.plugin.security.authBootstrapMode, "external");
  assert.equal(payload.manifest.agent.defaultModel, "openai-codex/gpt-5.4");
  assert.equal(payload.manifest.security.authBootstrapMode, "external");
});

test("config validation defaults Gemini subscription workspaces to the latest Gemini model", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-gemini-subscription-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");
  const geminiHome = path.join(tempRoot, ".gemini");

  await fs.mkdir(openclawPath, { recursive: true });
  await fs.mkdir(geminiHome, { recursive: true });
  await fs.writeFile(path.join(geminiHome, "oauth_creds.json"), JSON.stringify({ tokens: {} }));
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    projectName: "gemini-api",
    deploymentProfile: "docker-local",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: []
    },
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    agent: {
      id: "workspace",
      name: "Gemini Workspace",
      maxConcurrent: 4,
      skipBootstrap: true,
      defaultModel: ""
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "all",
      threadBindings: {
        spawnAcpSessions: false
      }
    },
    acp: {
      defaultAgent: "gemini",
      allowedAgents: ["gemini"],
      preferredMode: "oneshot"
    },
    security: {
      authBootstrapMode: "gemini"
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
      ...modelDiscoveryEnv,
      GEMINI_CLI_HOME: geminiHome
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin.agent.defaultModel, "");
  assert.equal(payload.manifest.agent.defaultModel, "google-gemini-cli/gemini-3.1-pro-preview");
  assert.equal(payload.manifest.security.authBootstrapMode, "gemini");
});

test("config validation heals stale built-in Codex defaults after switching the workspace to Gemini", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-gemini-stale-default-"));
  const repoPath = path.join(tempRoot, "repo");
  const openclawPath = path.join(repoPath, ".openclaw");

  await fs.mkdir(openclawPath, { recursive: true });
  await fs.writeFile(path.join(openclawPath, "config.json"), JSON.stringify({
    projectName: "gemini-stale-default",
    deploymentProfile: "docker-local",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: []
    },
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    agent: {
      id: "workspace",
      name: "Gemini Workspace",
      maxConcurrent: 4,
      skipBootstrap: true,
      defaultModel: "openai-codex/gpt-5.4"
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "all",
      threadBindings: {
        spawnAcpSessions: false
      }
    },
    acp: {
      defaultAgent: "gemini",
      allowedAgents: ["gemini"],
      preferredMode: "oneshot"
    },
    security: {
      authBootstrapMode: "gemini"
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
      ...modelDiscoveryEnv
    }
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.plugin.agent.defaultModel, "");
  assert.equal(payload.manifest.agent.defaultModel, "google-gemini-cli/gemini-3.1-pro-preview");
});
