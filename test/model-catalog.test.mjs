import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAllProvidersModelCatalog,
  buildCurrentProviderModelCatalog,
  buildLiveProviderSelectionData,
  describeUnavailableProvider,
  filterSupportedCodexModelIds,
  filterSupportedCopilotModelIds,
  getLatestCurrentProviderModel,
  shouldPreserveConfiguredModelRef
} from "../runtime/model-catalog.mjs";

const discoveryEnv = {
  OPENCLAW_MODEL_DISCOVERY_CODEX_BINARY: path.resolve("test/fixtures/model-discovery/codex-binary.txt"),
  OPENCLAW_MODEL_DISCOVERY_GEMINI_MODELS_JS: path.resolve("test/fixtures/model-discovery/gemini-models.fixture.js"),
  OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: path.resolve("test/fixtures/model-discovery/missing-copilot"),
  COPILOT_GITHUB_TOKEN: "",
};

const bundledGeminiDiscoveryEnv = {
  OPENCLAW_MODEL_DISCOVERY_NPM_ROOT: path.resolve("test/fixtures/model-discovery/npm-root")
};

test("buildCurrentProviderModelCatalog discovers Codex CLI models at runtime", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "codex",
    authMode: "codex",
    env: discoveryEnv
  });

  assert.equal(Object.keys(catalog)[0], "openai-codex/gpt-5.4");
  assert.ok(Object.keys(catalog).includes("openai-codex/gpt-5.4-mini"));
  assert.ok(Object.keys(catalog).includes("openai-codex/gpt-5.2-codex"));
  assert.ok(Object.keys(catalog).includes("openai-codex/gpt-5.1-codex-max"));
  assert.ok(Object.keys(catalog).includes("openai-codex/gpt-5.1-codex-mini"));
  assert.ok(!Object.keys(catalog).includes("openai-codex/gpt-5-codex"));
  assert.ok(!Object.keys(catalog).includes("openai-codex/gpt-5-codex-mini"));
});

test("filterSupportedCodexModelIds removes unsupported unversioned aliases", () => {
  const models = filterSupportedCodexModelIds([
    "gpt-5-codex-mini",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5-codex",
    "gpt-5.4"
  ]);

  assert.deepEqual(models, [
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4"
  ]);
});

test("buildCurrentProviderModelCatalog discovers Gemini CLI models at runtime", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "gemini",
    authMode: "gemini",
    env: discoveryEnv
  });

  assert.equal(Object.keys(catalog)[0], "google-gemini-cli/gemini-3.1-pro-preview");
  assert.ok(Object.keys(catalog).includes("google-gemini-cli/gemini-3-pro-preview"));
  assert.ok(Object.keys(catalog).includes("google-gemini-cli/gemini-3-flash-preview"));
  assert.ok(!Object.keys(catalog).includes("google-gemini-cli/gemini-3.1-pro-preview-customtools"));
});

test("buildCurrentProviderModelCatalog discovers Gemini CLI models from bundled package files", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "gemini",
    authMode: "gemini",
    env: bundledGeminiDiscoveryEnv
  });

  assert.equal(Object.keys(catalog)[0], "google-gemini-cli/gemini-3.1-pro-preview");
  assert.ok(Object.keys(catalog).includes("google-gemini-cli/gemini-3-flash-preview"));
  assert.ok(Object.keys(catalog).includes("google-gemini-cli/gemini-2.5-flash-lite"));
  assert.ok(!Object.keys(catalog).includes("google-gemini-cli/gemini-3.1-pro-preview-customtools"));
});

test("buildCurrentProviderModelCatalog preserves a non-discovered current model", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultModel: "openai-codex/gpt-5.3-codex-spark",
    authMode: "codex",
    defaultAgent: "codex",
    env: discoveryEnv
  });

  assert.equal(Object.keys(catalog)[0], "openai-codex/gpt-5.4");
  assert.equal(Object.keys(catalog).at(-1), "openai-codex/gpt-5.3-codex-spark");
});

test("shouldPreserveConfiguredModelRef keeps versioned Codex refs and rejects unversioned aliases", () => {
  assert.equal(shouldPreserveConfiguredModelRef("openai-codex/gpt-5.4-custom"), true);
  assert.equal(shouldPreserveConfiguredModelRef("openai-codex/gpt-5.1-codex-mini"), true);
  assert.equal(shouldPreserveConfiguredModelRef("openai-codex/gpt-5-codex"), false);
  assert.equal(shouldPreserveConfiguredModelRef("openai-codex/gpt-5-codex-mini"), false);
});

test("buildCurrentProviderModelCatalog resolves github-copilot provider for copilot agent", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "copilot",
    authMode: "copilot",
    env: discoveryEnv
  });

  assert.deepEqual(catalog, {});
});

test("filterSupportedCopilotModelIds removes unsupported Copilot families and xAI-backed models", () => {
  const models = filterSupportedCopilotModelIds([
    "claude-sonnet-4.6",
    "claude-haiku-4.5",
    "gpt-5.2",
    "gpt-4o-mini-2024-07-18",
    "o3-mini",
    "gemini-2.5-pro",
    "grok-code-fast-1",
    "text-embedding-3-large",
    "preview-customtools"
  ]);

  assert.deepEqual(models, [
    "claude-sonnet-4.6",
    "claude-haiku-4.5",
    "gpt-5.2",
    "gpt-4o-mini",
    "o3-mini",
    "gemini-2.5-pro",
  ]);
});

test("buildCurrentProviderModelCatalog discovers Copilot models from the live discovery override", () => {
  const models = ["claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2", "gpt-4.1", "o3-mini"];
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "copilot",
    authMode: "copilot",
    env: { ...discoveryEnv, OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(models) }
  });

  const keys = Object.keys(catalog);
  assert.ok(keys.includes("github-copilot/claude-sonnet-4.6"));
  assert.ok(keys.includes("github-copilot/claude-haiku-4.5"));
  assert.ok(keys.includes("github-copilot/gpt-5.2"));
  assert.ok(keys.includes("github-copilot/gpt-4.1"));
  assert.ok(keys.includes("github-copilot/o3-mini"));
  assert.equal(keys.length, 5);
});

test("buildCurrentProviderModelCatalog discovers live Copilot SDK models in provider order", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-discovery-"));
  const sdkPath = path.join(tempRoot, "sdk-index.mjs");

  await fs.writeFile(sdkPath, [
    "export async function retrieveAvailableModels() {",
    "  return {",
    '    copilotUrl: "https://api.example.githubcopilot.com",',
    "    models: [",
    '      { id: "claude-sonnet-4.6", policy: { state: "enabled" } },',
    '      { id: "gpt-5.4", policy: { state: "enabled" } },',
    '      { id: "gpt-4o", policy: { state: "disabled" } },',
    '      { id: "text-embedding-3-large", policy: { state: "enabled" } },',
    "    ],",
    "  };",
    "}",
  ].join("\n"));

  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "copilot",
    authMode: "copilot",
    env: {
      ...discoveryEnv,
      GITHUB_COPILOT_API_TOKEN: "copilot_session_token_value",
      COPILOT_API_URL: "https://api.example.githubcopilot.com",
      OPENCLAW_MODEL_DISCOVERY_COPILOT_SDK: sdkPath,
      OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_CACHE: "true",
      OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
    }
  });

  const keys = Object.keys(catalog);
  assert.ok(keys.includes("github-copilot/claude-sonnet-4.6"));
  assert.ok(keys.includes("github-copilot/gpt-5.4"));
  assert.ok(!keys.includes("github-copilot/gpt-4o"));
  assert.equal(keys[0], "github-copilot/claude-sonnet-4.6");
  assert.equal(keys.length, 2);
});

test("getLatestCurrentProviderModel keeps the first live Copilot SDK model", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-default-model-"));
  const sdkPath = path.join(tempRoot, "sdk-index.mjs");

  await fs.writeFile(sdkPath, [
    "export async function retrieveAvailableModels() {",
    "  return {",
    '    copilotUrl: "https://api.example.githubcopilot.com",',
    "    models: [",
    '      { id: "claude-sonnet-4.6", policy: { state: "enabled" } },',
    '      { id: "gpt-5.4", policy: { state: "enabled" } },',
    '      { id: "gpt-4o", policy: { state: "enabled" } },',
    "    ],",
    "  };",
    "}",
  ].join("\n"));

  const defaultModel = getLatestCurrentProviderModel("github-copilot", {
    ...discoveryEnv,
    HOME: path.join(tempRoot, "isolated-home"),
    COPILOT_HOME: path.join(tempRoot, "isolated-copilot"),
    GITHUB_COPILOT_API_TOKEN: "copilot_session_token_value",
    COPILOT_API_URL: "https://api.example.githubcopilot.com",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_SDK: sdkPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_CACHE: "true",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });

  assert.equal(defaultModel, "github-copilot/claude-sonnet-4.6");
});

test("getLatestCurrentProviderModel does not reuse a configured Copilot fallback during startup-safe discovery", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-startup-default-"));
  const copilotHome = path.join(tempRoot, ".copilot");
  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    default_model: "gpt-5.4",
    logged_in_users: [{ login: "demo-user" }],
  }, null, 2));

  const defaultModel = getLatestCurrentProviderModel("github-copilot", {
    ...discoveryEnv,
    HOME: tempRoot,
    COPILOT_HOME: copilotHome,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });

  assert.equal(defaultModel, "");
});

test("buildCurrentProviderModelCatalog handles invalid Copilot discovery overrides gracefully", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultAgent: "copilot",
    authMode: "copilot",
    env: { ...discoveryEnv, OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: "not-json" }
  });

  assert.deepEqual(catalog, {});
});

test("buildCurrentProviderModelCatalog does not preserve a non-discovered copilot model", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultModel: "github-copilot/gpt-4o",
    defaultAgent: "copilot",
    authMode: "copilot",
    env: discoveryEnv
  });

  assert.ok(!Object.keys(catalog).includes("github-copilot/gpt-4o"));
});

test("buildCurrentProviderModelCatalog drops unsupported configured Copilot models", () => {
  const catalog = buildCurrentProviderModelCatalog({
    defaultModel: "github-copilot/not-json",
    defaultAgent: "copilot",
    authMode: "copilot",
    env: discoveryEnv
  });

  assert.ok(!Object.keys(catalog).includes("github-copilot/not-json"));
});

test("shouldPreserveConfiguredModelRef does not keep stale Copilot overrides", () => {
  assert.equal(shouldPreserveConfiguredModelRef("github-copilot/gpt-4o"), false);
  assert.equal(shouldPreserveConfiguredModelRef("github-copilot/gpt-5.4"), false);
});

test("buildAllProvidersModelCatalog includes models from codex and gemini", () => {
  const catalog = buildAllProvidersModelCatalog({
    allowedAgents: ["codex", "gemini"],
    defaultAgent: "codex",
    authMode: "codex",
    env: discoveryEnv
  });

  const keys = Object.keys(catalog);
  assert.ok(keys.some((key) => key.startsWith("openai-codex/")));
  assert.ok(keys.some((key) => key.startsWith("google-gemini-cli/")));
});

test("buildAllProvidersModelCatalog preserves a configured default model", () => {
  const catalog = buildAllProvidersModelCatalog({
    allowedAgents: ["codex", "gemini"],
    defaultAgent: "codex",
    defaultModel: "openai-codex/gpt-5.4-custom",
    authMode: "codex",
    env: discoveryEnv
  });

  assert.ok(Object.keys(catalog).includes("openai-codex/gpt-5.4-custom"));
});

test("buildAllProvidersModelCatalog returns empty for unknown agents", () => {
  const catalog = buildAllProvidersModelCatalog({
    allowedAgents: ["unknown"],
    defaultAgent: "unknown",
    authMode: "external",
    env: discoveryEnv
  });

  assert.deepEqual(catalog, {});
});

test("buildAllProvidersModelCatalog deduplicates models", () => {
  const catalog = buildAllProvidersModelCatalog({
    allowedAgents: ["codex"],
    defaultAgent: "codex",
    defaultModel: "openai-codex/gpt-5.3-codex",
    authMode: "codex",
    env: discoveryEnv
  });

  const keys = Object.keys(catalog);
  const uniqueKeys = [...new Set(keys)];
  assert.equal(keys.length, uniqueKeys.length);
});

test("buildAllProvidersModelCatalog includes Copilot models from the live discovery override", () => {
  const copilotModels = ["claude-sonnet-4.6", "claude-haiku-4.5", "gpt-5.2", "o3-mini"];
  const catalog = buildAllProvidersModelCatalog({
    allowedAgents: ["codex", "copilot"],
    defaultAgent: "codex",
    authMode: "codex",
    env: { ...discoveryEnv, OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(copilotModels) }
  });

  const keys = Object.keys(catalog);
  assert.ok(keys.some((key) => key.startsWith("openai-codex/")));
  assert.ok(keys.includes("github-copilot/claude-sonnet-4.6"));
  assert.ok(keys.includes("github-copilot/claude-haiku-4.5"));
  assert.ok(keys.includes("github-copilot/gpt-5.2"));
  assert.ok(keys.includes("github-copilot/o3-mini"));
});

test("buildLiveProviderSelectionData classifies multiple available providers from live discovery", () => {
  const result = buildLiveProviderSelectionData({
    allowedAgents: ["codex", "copilot"],
    defaultAgent: "codex",
    authMode: "codex",
    env: {
      ...discoveryEnv,
      OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-5.2", "claude-sonnet-4.6"])
    }
  });

  assert.equal(result.availableProviders.length, 2);
  assert.equal(result.unavailableProviders.length, 0);
  assert.deepEqual(
    result.availableProviders.map((entry) => entry.providerId),
    ["openai-codex", "github-copilot"]
  );
  assert.equal(result.availableProviders[0].models[0], "gpt-5.4");
  assert.deepEqual(result.availableProviders[1].models, ["gpt-5.2", "claude-sonnet-4.6"]);
});

test("buildLiveProviderSelectionData skips the picker surface when only one provider has live models", () => {
  const result = buildLiveProviderSelectionData({
    allowedAgents: ["codex", "copilot"],
    defaultAgent: "codex",
    authMode: "codex",
    env: discoveryEnv
  });

  assert.deepEqual(
    result.availableProviders.map((entry) => entry.providerId),
    ["openai-codex"]
  );
  assert.deepEqual(
    result.unavailableProviders.map((entry) => entry.providerId),
    ["github-copilot"]
  );
});

test("buildLiveProviderSelectionData marks configured providers with zero live models as unavailable", () => {
  const result = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: discoveryEnv
  });

  assert.equal(result.availableProviders.length, 0);
  assert.equal(result.unavailableProviders.length, 1);
  assert.equal(result.unavailableProviders[0].providerId, "github-copilot");
  assert.match(result.unavailableProviders[0].reason, /Sign in on the host/);
  assert.match(result.unavailableProviders[0].reason, /\/acp doctor/);
});

test("buildLiveProviderSelectionData reflects live discovery changes between calls", () => {
  const first = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: { ...discoveryEnv, OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-4.1"]) }
  });
  const second = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: { ...discoveryEnv, OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-5.2", "claude-sonnet-4.6"]) }
  });

  assert.deepEqual(first.availableProviders[0].models, ["gpt-4.1"]);
  assert.deepEqual(second.availableProviders[0].models, ["gpt-5.2", "claude-sonnet-4.6"]);
});

test("buildLiveProviderSelectionData keeps Copilot available when live discovery succeeds despite a failed token exchange probe", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-auth-"));
  const copilotHome = path.join(tempRoot, ".copilot");
  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    logged_in_users: [{ host: "https://github.com", login: "demo" }]
  }));

  const result = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: {
      ...discoveryEnv,
      HOME: tempRoot,
      OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-5.2", "claude-sonnet-4.6"]),
      OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS: "http_404",
      OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS: "404",
    }
  });

  assert.deepEqual(
    result.availableProviders.map((entry) => entry.providerId),
    ["github-copilot"]
  );
  assert.equal(result.unavailableProviders.length, 0);
});

test("buildLiveProviderSelectionData does not treat mounted Copilot subscription auth alone as available", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-auth-"));
  const copilotHome = path.join(tempRoot, ".copilot");
  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    logged_in_users: [{ host: "https://github.com", login: "demo" }]
  }));

  const result = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: {
      ...discoveryEnv,
      HOME: tempRoot,
      OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS: "http_404",
      OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS: "404",
    }
  });

  assert.equal(result.availableProviders.length, 0);
  assert.equal(result.unavailableProviders.length, 1);
  assert.match(result.unavailableProviders[0].reason, /Copilot session token \(HTTP 404\)/);
});

test("buildLiveProviderSelectionData keeps Copilot available when runtime token exchange is valid", () => {
  const result = buildLiveProviderSelectionData({
    allowedAgents: ["copilot"],
    defaultAgent: "copilot",
    authMode: "copilot",
    env: {
      ...discoveryEnv,
      OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: JSON.stringify(["gpt-5.2", "claude-sonnet-4.6"]),
      OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS: "ok",
      OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS: "200",
    }
  });

  assert.deepEqual(
    result.availableProviders.map((entry) => entry.providerId),
    ["github-copilot"]
  );
  assert.equal(result.unavailableProviders.length, 0);
});

test("describeUnavailableProvider includes an auth and doctor hint", () => {
  assert.match(describeUnavailableProvider({ agentId: "codex" }), /Sign in on the host/);
  assert.match(describeUnavailableProvider({ agentId: "gemini" }), /Sign in on the host/);
  assert.match(describeUnavailableProvider({ agentId: "copilot" }), /Sign in on the host/);
  assert.match(describeUnavailableProvider({ agentId: "codex" }), /\/acp doctor/);
});

test("describeUnavailableProvider explains Copilot token exchange failures", () => {
  const message = describeUnavailableProvider({
    agentId: "copilot",
    env: {
      OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS: "http_404",
      OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS: "404",
    }
  });

  assert.match(message, /Copilot session token \(HTTP 404\)/);
  assert.match(message, /Sign in on the host again/);
});

test("describeUnavailableProvider still explains Copilot token exchange failures when mounted auth exists", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-auth-"));
  const copilotHome = path.join(tempRoot, ".copilot");
  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    logged_in_users: [{ host: "https://github.com", login: "demo" }]
  }));

  const message = describeUnavailableProvider({
    agentId: "copilot",
    env: {
      HOME: tempRoot,
      OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS: "http_404",
      OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS: "404",
    }
  });

  assert.match(message, /Copilot session token \(HTTP 404\)/);
  assert.match(message, /runtime token bridge refreshes/);
});
