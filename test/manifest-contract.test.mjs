import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildManifestFromEnv, buildOpenClawConfig, normalizeProjectManifest, validateProjectManifest } from "../runtime/manifest-contract.mjs";

const discoveryEnv = {
  OPENCLAW_MODEL_DISCOVERY_CODEX_BINARY: path.resolve("test/fixtures/model-discovery/codex-binary.txt"),
  OPENCLAW_MODEL_DISCOVERY_GEMINI_MODELS_JS: path.resolve("test/fixtures/model-discovery/gemini-models.fixture.js")
};

function createManifest(overrides = {}) {
  return normalizeProjectManifest({
    projectName: "demo-workspace",
    repoPath: "/workspace/demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: [],
    },
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    agent: {
      id: "workspace",
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: [],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "external",
    },
    ...overrides,
  });
}

test("normalizeProjectManifest folds ACP agents into stable defaults", () => {
  const manifest = createManifest();

  assert.deepEqual(manifest.acp.allowedAgents, ["codex"]);
  assert.match(manifest.agent.name, /^demo-workspace-[a-f0-9]{8}$/);
  assert.equal(manifest.agent.verboseDefault, "on");
  assert.equal(manifest.agent.thinkingDefault, "adaptive");
  assert.equal(manifest.agent.typingMode, "message");
  assert.equal(manifest.queue.mode, "steer");
  assert.equal(manifest.telegram.replyToMode, "all");
  assert.equal(manifest.telegram.threadBindings.spawnAcpSessions, false);
});

test("normalizeProjectManifest keeps only the new tooling contract", () => {
  const manifest = createManifest({
    toolingProfiles: ["node22", "java21"],
    stack: {
      languages: ["typescript", "java", "typescript"],
      tools: ["pnpm", "maven", "pnpm"],
    },
  });

  assert.deepEqual(manifest.toolingProfiles, ["java21", "node22"]);
  assert.deepEqual(manifest.stack.languages, ["java", "typescript"]);
  assert.deepEqual(manifest.stack.tools, ["maven", "pnpm"]);
});

test("buildOpenClawConfig uses OPENCLAW_TELEGRAM_STREAM_MODE env override", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest, {
    OPENCLAW_TELEGRAM_STREAM_MODE: "off",
  });

  assert.equal(config.channels.telegram.streamMode, "off");
});

test("buildOpenClawConfig auto-discovers the Codex default model at runtime", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      preferredMode: "oneshot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  assert.equal(config.agents.defaults.model.primary, "openai-codex/gpt-5.4");
  assert.ok(Object.keys(config.agents.defaults.models).includes("openai-codex/gpt-5.2-codex"));
});

test("buildOpenClawConfig preserves the codex provider model format", () => {
  const manifest = createManifest({
    agent: {
      id: "workspace",
      defaultModel: "openai-codex/gpt-5.4",
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      preferredMode: "oneshot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  assert.equal(config.agents.defaults.model.primary, "openai-codex/gpt-5.4");
  assert.equal(Object.keys(config.agents.defaults.models)[0], "openai-codex/gpt-5.4");
  assert.equal(Object.keys(config.agents.defaults.models).at(-1), "openai-codex/gpt-5.1-codex-mini");
});

test("buildOpenClawConfig auto-discovers the Gemini CLI default model at runtime", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "gemini",
      allowedAgents: ["gemini"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "gemini",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  assert.equal(config.agents.defaults.model.primary, "google-gemini-cli/gemini-3.1-pro-preview");
  assert.ok(Object.keys(config.agents.defaults.models).includes("google-gemini-cli/gemini-3-flash-preview"));
});

test("buildOpenClawConfig preserves an explicit Gemini CLI default alongside the discovered CLI catalog", () => {
  const manifest = createManifest({
    agent: {
      id: "workspace",
      defaultModel: "google-gemini-cli/gemini-3.1-pro-preview",
    },
    acp: {
      defaultAgent: "gemini",
      allowedAgents: ["gemini"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "gemini",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  assert.equal(config.agents.defaults.model.primary, "google-gemini-cli/gemini-3.1-pro-preview");
  assert.equal(Object.keys(config.agents.defaults.models)[0], "google-gemini-cli/gemini-3.1-pro-preview");
  assert.ok(Object.keys(config.agents.defaults.models).includes("google-gemini-cli/gemini-2.5-flash"));
  assert.ok(Object.keys(config.agents.defaults.models).includes("google-gemini-cli/gemini-3.1-pro-preview"));
});

test("buildOpenClawConfig replaces a stale Copilot default with a live-supported model", () => {
  const manifest = createManifest({
    agent: {
      id: "workspace",
      defaultModel: "github-copilot/gpt-5.4",
    },
    acp: {
      defaultAgent: "copilot",
      allowedAgents: ["copilot"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "copilot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, {
    ...discoveryEnv,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["claude-sonnet-4.6"]),
  });

  assert.equal(config.agents.defaults.model.primary, "github-copilot/claude-sonnet-4.6");
  assert.deepEqual(Object.keys(config.agents.defaults.models), ["github-copilot/claude-sonnet-4.6"]);
});

test("buildOpenClawConfig normalizes dated live Copilot snapshots to stable aliases", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "copilot",
      allowedAgents: ["copilot"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "copilot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, {
    ...discoveryEnv,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-4o-mini-2024-07-18"]),
  });

  assert.equal(config.agents.defaults.model.primary, "github-copilot/gpt-4o-mini");
  assert.deepEqual(Object.keys(config.agents.defaults.models), ["github-copilot/gpt-4o-mini"]);
});

test("buildOpenClawConfig does not pin a stale Copilot startup default before live discovery succeeds", () => {
  const manifest = createManifest({
    agent: {
      id: "workspace",
      defaultModel: "github-copilot/gpt-5.4",
    },
    acp: {
      defaultAgent: "copilot",
      allowedAgents: ["copilot"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "copilot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, {
    ...discoveryEnv,
    HOME: path.join(process.cwd(), "test", "fixtures", "missing-copilot-home"),
    USERPROFILE: path.join(process.cwd(), "test", "fixtures", "missing-copilot-home"),
    COPILOT_HOME: path.join(process.cwd(), "test", "fixtures", "missing-copilot-home", ".copilot"),
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });

  assert.equal(config.agents.defaults.model, undefined);
  assert.equal(config.agents.defaults.models, undefined);
});

test("buildOpenClawConfig carries tooling profiles and stack into the workspace plugin config", () => {
  const manifest = createManifest({
    toolingProfiles: ["node22"],
    stack: {
      languages: ["typescript"],
      tools: ["pnpm"],
    },
  });
  const { config } = buildOpenClawConfig(manifest);

  assert.deepEqual(config.plugins.entries["workspace-openclaw"].config.toolingProfiles, ["node22"]);
  assert.deepEqual(config.plugins.entries["workspace-openclaw"].config.stack, {
    languages: ["typescript"],
    tools: ["pnpm"],
  });
});

test("buildOpenClawConfig carries ACPX command overrides from the environment", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest, {
    OPENCLAW_ACPX_COMMAND: "/usr/local/bin/acpx",
    OPENCLAW_ACPX_EXPECTED_VERSION: "0.3.1",
  });

  assert.equal(config.plugins.entries.acpx.config.command, "/usr/local/bin/acpx");
  assert.equal(config.plugins.entries.acpx.config.expectedVersion, "0.3.1");
});

test("buildManifestFromEnv round-trips tooling profiles and stack", () => {
  const manifest = buildManifestFromEnv({
    OPENCLAW_PROJECT_NAME: "workspace",
    OPENCLAW_REPO_ROOT: "/workspace",
    OPENCLAW_RUNTIME_PROFILE: "stable-chat",
    OPENCLAW_QUEUE_PROFILE: "stable-chat",
    OPENCLAW_DEPLOYMENT_PROFILE: "docker-local",
    OPENCLAW_TOOLING_PROFILES: JSON.stringify(["node22"]),
    OPENCLAW_STACK: JSON.stringify({
      languages: ["typescript"],
      tools: ["pnpm"],
    }),
    OPENCLAW_AGENT_ID: "workspace",
    OPENCLAW_ACP_DEFAULT_AGENT: "codex",
    OPENCLAW_ACP_ALLOWED_AGENTS: JSON.stringify(["codex"]),
  });

  assert.deepEqual(manifest.toolingProfiles, ["node22"]);
  assert.deepEqual(manifest.stack, {
    languages: ["typescript"],
    tools: ["pnpm"],
  });
});

test("buildManifestFromEnv defaults project and agent names from the repo root", () => {
  const manifest = buildManifestFromEnv({
    OPENCLAW_REPO_ROOT: "/workspace",
    OPENCLAW_REPO_ROOT_HOST: "C:/Users/demo/custom-repo",
  });

  assert.equal(manifest.projectName, "custom-repo");
  assert.match(manifest.agent.name, /^custom-repo-[a-f0-9]{8}$/);
});

test("validateProjectManifest rejects unsupported ACP agents", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "opencode",
      allowedAgents: ["opencode"],
      preferredMode: "oneshot",
    },
  });

  const errors = validateProjectManifest(manifest);
  assert.match(errors.join("; "), /acp\.defaultAgent must be one of codex, gemini, copilot/);
  assert.match(errors.join("; "), /acp\.allowedAgents must contain only supported agents: codex, gemini, copilot/);
});

test("validateProjectManifest accepts gemini auth bootstrap mode", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "gemini",
      allowedAgents: ["gemini"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "gemini",
    },
  });

  const errors = validateProjectManifest(manifest);
  assert.equal(errors.length, 0);
});

test("validateProjectManifest accepts copilot auth bootstrap mode", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "copilot",
      allowedAgents: ["copilot"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "copilot",
    },
  });

  const errors = validateProjectManifest(manifest);
  assert.equal(errors.length, 0);
});

test("buildOpenClawConfig no longer injects workspace skill directories", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest);

  assert.equal(config.skills, undefined);
});

test("buildOpenClawConfig includes all allowed-provider catalogs when multiple agents are allowed", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex", "gemini"],
      preferredMode: "oneshot",
    },
    security: {
      authBootstrapMode: "codex",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  const modelKeys = Object.keys(config.agents.defaults.models);
  assert.ok(modelKeys.some((key) => key.startsWith("openai-codex/")), "should include codex models");
  assert.ok(modelKeys.some((key) => key.startsWith("google-gemini-cli/")), "should include gemini models for session overrides");
  assert.equal(config.agents.defaults.model.primary, "openai-codex/gpt-5.4");
});

test("buildOpenClawConfig uses single-provider catalog when only one agent allowed", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      preferredMode: "oneshot",
    },
  });
  const { config } = buildOpenClawConfig(manifest, discoveryEnv);

  const modelKeys = Object.keys(config.agents.defaults.models);
  assert.ok(modelKeys.every((key) => key.startsWith("openai-codex/")), "should only include codex models");
});
