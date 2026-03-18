import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { probeAuth } from "../runtime/bootstrap-auth.mjs";

test("probeAuth reports a missing Codex CLI separately from stale auth", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-test-"));
  const manifestPath = path.join(tempRoot, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    version: 1,
    projectName: "auth-test",
    repoPath: "/workspace/auth-test",
    deploymentProfile: "docker-local",
    toolingProfile: "none",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    verificationCommands: [],
    agent: {
      id: "workspace"
    },
    acp: {
      defaultAgent: "codex"
    },
    security: {
      authBootstrapMode: "codex"
    }
  }, null, 2));

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_PROJECT_MANIFEST: process.env.OPENCLAW_PROJECT_MANIFEST,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    OPENCLAW_CODEX_CLI_BIN: process.env.OPENCLAW_CODEX_CLI_BIN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_PROJECT_MANIFEST = manifestPath;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "codex";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = path.join(tempRoot, "missing-codex");
    process.env.OPENCLAW_CODEX_CLI_BIN = "";
    process.env.OPENAI_API_KEY = "sk-test";

    const result = await probeAuth({ probeOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "Codex CLI is not installed in the runtime image.");
    assert.match(result.recovery, /@openai\/codex/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
