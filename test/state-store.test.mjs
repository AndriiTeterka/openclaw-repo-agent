import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPathsPayload, readInstanceState, writePathsManifest } from "../cli/src/state-store.mjs";
import { resolveAgentPaths } from "../cli/src/state-layout.mjs";

function createContext(tempRoot, env = {}) {
  const repoRoot = path.join(tempRoot, "repo");
  const instanceId = "demo-1234";
  return {
    repoRoot,
    productRoot: tempRoot,
    repoSlug: "repo",
    instanceId,
    composeProjectName: "openclaw-demo-1234",
    instanceRegistryFile: path.join(tempRoot, "instances.json"),
    paths: resolveAgentPaths(repoRoot, instanceId, env),
    detection: {
      projectName: "repo",
      toolingProfiles: [],
      stack: {
        languages: [],
        tools: []
      }
    }
  };
}

test("readInstanceState returns the simplified default state shape", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-store-"));
  const context = createContext(tempRoot, {
    OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
    OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts")
  });
  const state = await readInstanceState(context);

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.instanceId, context.instanceId);
  assert.equal(state.repoRoot, context.repoRoot);
  assert.equal(state.composeProjectName, context.composeProjectName);
  assert.deepEqual(state.runtimeCore, {
    image: "",
    digest: "",
    source: "unresolved"
  });
  assert.equal(state.toolingFingerprint, "");
  assert.equal(state.lastMaterializedAt, "");
  assert.equal("migration" in state, false);
});

test("buildPathsPayload only includes canonical paths", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-paths-"));
  const env = {
    OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
    OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts"),
    CODEX_HOME: path.join(tempRoot, "codex-home"),
    GEMINI_CLI_HOME: path.join(tempRoot, "gemini-home"),
    COPILOT_HOME: path.join(tempRoot, "copilot-home")
  };
  const context = createContext(tempRoot, env);
  const payload = await buildPathsPayload(context);

  assert.equal(payload.repoRoot, context.repoRoot);
  assert.equal(payload.stateRoot, context.paths.stateRoot);
  assert.equal(payload.mountRoot, context.paths.mountRoot);
  assert.equal(payload.secretsEnvFile, context.paths.secretsEnvFile);
  assert.equal(payload.runtimeEnvFile, context.paths.runtimeEnvFile);
  assert.equal(payload.eventLogFile, context.paths.eventLogFile);
  assert.equal(payload.playwrightDir, context.paths.playwrightDir);
  assert.deepEqual(payload.providerHomes, context.paths.providerHomes);
  assert.equal("legacy" in payload, false);
  assert.equal("migrationBackupRoot" in payload, false);
  assert.equal("authMirrorsDir" in payload, false);
});

test("writePathsManifest persists only the canonical payload", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-manifest-"));
  const env = {
    OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
    OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts"),
    CODEX_HOME: path.join(tempRoot, "codex-home"),
    GEMINI_CLI_HOME: path.join(tempRoot, "gemini-home"),
    COPILOT_HOME: path.join(tempRoot, "copilot-home")
  };
  const context = createContext(tempRoot, env);
  const payload = await writePathsManifest(context);
  const persisted = JSON.parse(await fs.readFile(context.paths.pathsManifestFile, "utf8"));

  assert.deepEqual(persisted, payload);
  assert.deepEqual(persisted.providerHomes, context.paths.providerHomes);
  assert.equal("legacy" in persisted, false);
  assert.equal("authMirrorsDir" in persisted, false);
});
