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
    instructionFiles: ["AGENTS.md"],
    knowledgeFiles: [".openclaw/knowledge.md"],
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

test("normalizeProjectManifest folds bootstrap files and ACP agents into stable defaults", () => {
  const manifest = createManifest({
    instructionFiles: ["README.md"],
    knowledgeFiles: [".openclaw/knowledge.md", "docs/project-knowledge.md"]
  });

  assert.deepEqual(manifest.acp.allowedAgents, ["codex"]);
  assert.deepEqual(manifest.instructionFiles, [
    "README.md",
    ".openclaw/knowledge.md",
    "docs/project-knowledge.md"
  ]);
});

test("buildOpenClawConfig prefers OPENCLAW_TELEGRAM_STREAM_MODE over the legacy runtime variable", () => {
  const manifest = createManifest();
  const { config } = buildOpenClawConfig(manifest, {
    OPENCLAW_TELEGRAM_STREAM_MODE: "off",
    OPENCLAW_TELEGRAM_STREAMING: "block"
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
