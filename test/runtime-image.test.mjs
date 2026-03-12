import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildLocalRuntimeEnvOverrides, shouldAutoUseLocalBuild } from "../cli/src/runtime-image.mjs";

test("shouldAutoUseLocalBuild falls back for denied access to the default image", () => {
  assert.equal(shouldAutoUseLocalBuild({
    useLocalBuild: false,
    stackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.1.5-polyglot",
    defaultStackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.1.5-polyglot",
    errorOutput: "error from registry: denied"
  }), true);
});

test("shouldAutoUseLocalBuild does not override a custom image reference", () => {
  assert.equal(shouldAutoUseLocalBuild({
    useLocalBuild: false,
    stackImage: "ghcr.io/private/custom-runtime:1.2.3",
    defaultStackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.1.5-polyglot",
    errorOutput: "error from registry: denied"
  }), false);
});

test("buildLocalRuntimeEnvOverrides enables local build and rewrites the default stack image", () => {
  const nextEnv = buildLocalRuntimeEnvOverrides({
    OPENCLAW_STACK_IMAGE: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.1.5-polyglot"
  }, "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.1.5-polyglot");

  assert.equal(nextEnv.OPENCLAW_USE_LOCAL_BUILD, "true");
  assert.equal(nextEnv.OPENCLAW_STACK_IMAGE, "openclaw-repo-agent-runtime:local");
});

test("runtime Dockerfile installs the Codex CLI", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile"), "utf8");

  assert.match(dockerfile, /npm install --global @openai\/codex/);
});
