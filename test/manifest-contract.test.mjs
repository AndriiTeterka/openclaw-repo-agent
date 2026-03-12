import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenClawConfig, normalizeProjectManifest } from "../runtime/manifest-contract.mjs";

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
      defaultAgent: "assistant",
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

  assert.deepEqual(manifest.acp.allowedAgents, ["assistant"]);
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
