import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenClawConfig, normalizeProjectManifest, validateProjectManifest } from "../runtime/manifest-contract.mjs";

function createManifest(overrides = {}) {
  return normalizeProjectManifest({
    version: 1,
    projectName: "demo-workspace",
    repoPath: "/workspace/demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfile: "none",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    verificationCommands: ["npm test"],
    agent: {
      id: "workspace"
    },
    telegram: {
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      replyToMode: "first"
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: [],
      preferredMode: "oneshot"
    },
    security: {
      authBootstrapMode: "external"
    },
    ...overrides
  });
}

test("normalizeProjectManifest folds ACP agents into stable defaults", () => {
  const manifest = createManifest();

  assert.deepEqual(manifest.acp.allowedAgents, ["codex"]);
});

test("buildOpenClawConfig uses OPENCLAW_TELEGRAM_STREAM_MODE env override", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest, {
    OPENCLAW_TELEGRAM_STREAM_MODE: "off"
  });

  assert.equal(config.channels.telegram.streamMode, "off");
});

test("buildOpenClawConfig preserves the codex provider model format", () => {
  const manifest = createManifest({
    agent: {
      id: "workspace",
      defaultModel: "openai-codex/gpt-5.4"
    },
    acp: {
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      preferredMode: "oneshot"
    }
  });
  const { config } = buildOpenClawConfig(manifest);

  assert.equal(config.agents.defaults.model.primary, "openai-codex/gpt-5.4");
});

test("validateProjectManifest rejects unsupported ACP agents", () => {
  const manifest = createManifest({
    acp: {
      defaultAgent: "opencode",
      allowedAgents: ["opencode"],
      preferredMode: "oneshot"
    }
  });

  const errors = validateProjectManifest(manifest);
  assert.match(errors.join("; "), /acp\.defaultAgent must be one of codex, claude, gemini/);
  assert.match(errors.join("; "), /acp\.allowedAgents must contain only supported agents: codex, claude, gemini/);
});

test("buildOpenClawConfig no longer injects workspace skill directories", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest);

  assert.equal(config.skills, undefined);
});
