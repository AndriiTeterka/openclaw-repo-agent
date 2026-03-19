import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { probeAuth } from "../runtime/bootstrap-auth.mjs";

test("probeAuth reports a missing Codex CLI separately from stale auth", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-test-"));
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    OPENCLAW_CODEX_CLI_BIN: process.env.OPENCLAW_CODEX_CLI_BIN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  try {
    process.env.HOME = tempRoot;
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

test("probeAuth syncs API-key auth profiles without throwing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-api-key-"));
  const fakeCodex = path.join(tempRoot, "fake-codex.cmd");
  await fs.writeFile(fakeCodex, [
    "@echo off",
    "if \"%1\"==\"login\" (",
    "  if \"%2\"==\"status\" exit /b 1",
    "  if \"%2\"==\"--with-api-key\" exit /b 0",
    ")",
    "exit /b 0"
  ].join("\r\n"));

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    OPENCLAW_CODEX_CLI_BIN: process.env.OPENCLAW_CODEX_CLI_BIN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "codex";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = fakeCodex;
    process.env.OPENCLAW_CODEX_CLI_BIN = "";
    process.env.OPENAI_API_KEY = "sk-test";

    const result = await probeAuth();
    const profileStore = JSON.parse(await fs.readFile(
      path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      "utf8"
    ));

    assert.equal(result.mode, "codex");
    assert.equal(profileStore.profiles["openai:default"]?.provider, "openai");
    assert.equal(profileStore.profiles["openai:default"]?.key, "sk-test");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
