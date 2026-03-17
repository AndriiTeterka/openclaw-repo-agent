import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildLocalRuntimeEnvOverrides,
  isManagedLocalRuntimeImage,
  isManagedRemoteRuntimeImage,
  shouldAutoUseLocalBuild
} from "../cli/src/runtime-image.mjs";
import { deriveLocalRuntimeImage } from "../cli/src/instance-registry.mjs";

test("shouldAutoUseLocalBuild falls back for denied access to the default image", () => {
  assert.equal(shouldAutoUseLocalBuild({
    useLocalBuild: false,
    stackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.4.0-polyglot",
    defaultStackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.4.0-polyglot",
    errorOutput: "error from registry: denied"
  }), true);
});

test("shouldAutoUseLocalBuild does not override a custom image reference", () => {
  assert.equal(shouldAutoUseLocalBuild({
    useLocalBuild: false,
    stackImage: "ghcr.io/private/custom-runtime:1.2.3",
    defaultStackImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.4.0-polyglot",
    errorOutput: "error from registry: denied"
  }), false);
});

test("buildLocalRuntimeEnvOverrides enables local build and rewrites the default stack image", () => {
  const localRuntimeImage = deriveLocalRuntimeImage("appium-test-project-deadbeef");
  const nextEnv = buildLocalRuntimeEnvOverrides({
    OPENCLAW_STACK_IMAGE: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.4.0-polyglot"
  }, "ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.4.0-polyglot", localRuntimeImage, "appium-test-project-deadbeef");

  assert.equal(nextEnv.OPENCLAW_USE_LOCAL_BUILD, "true");
  assert.equal(nextEnv.OPENCLAW_STACK_IMAGE, localRuntimeImage);
});

test("managed runtime image helpers recognize repo-managed tags", () => {
  assert.equal(isManagedRemoteRuntimeImage("ghcr.io/andriiteterka/openclaw-repo-agent-runtime:0.2.0-polyglot"), true);
  assert.equal(isManagedRemoteRuntimeImage("ghcr.io/private/custom-runtime:1.2.3"), false);
  assert.equal(isManagedLocalRuntimeImage("openclaw-repo-agent-runtime:0.2.0-fs-focus-automation-efda0b9d", "fs-focus-automation-efda0b9d"), true);
  assert.equal(isManagedLocalRuntimeImage("openclaw-repo-agent-runtime:custom", "fs-focus-automation-efda0b9d"), false);
});

test("runtime Dockerfile installs the Codex CLI", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile"), "utf8");

  assert.match(dockerfile, /npm install --global @openai\/codex/);
});

test("runtime Dockerfile preinstalls Playwright CLI, Chromium, and browser dependencies", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile"), "utf8");

  assert.match(dockerfile, /ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(dockerfile, /npm install --global @openai\/codex @playwright\/cli/);
  assert.match(dockerfile, /@playwright\/cli\/node_modules\/\.bin\/playwright"\ install --with-deps chromium/);
  assert.match(dockerfile, /mkdir -p \/home\/node\/\.openclaw \/ms-playwright/);
  assert.match(dockerfile, /COPY runtime\/playwright-cli\.config\.json \/app\/\.playwright\/cli\.config\.json/);
  assert.match(dockerfile, /COPY runtime\/playwright-cli-wrapper\.mjs \/usr\/local\/bin\/playwright-cli/);
  assert.match(dockerfile, /COPY runtime\/playwright-shim\.sh \/usr\/local\/bin\/playwright/);
});

test("runtime Dockerfile copies manifest-contract runtime dependencies", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY runtime\/shared\.mjs \/opt\/openclaw\/shared\.mjs/);
  assert.match(dockerfile, /COPY runtime\/supported-acp-agents\.mjs \/opt\/openclaw\/supported-acp-agents\.mjs/);
  assert.match(dockerfile, /COPY runtime\/manifest-contract\.mjs \/opt\/openclaw\/manifest-contract\.mjs/);
});

test("runtime entrypoint removes stale npx playwright caches", async () => {
  const entrypoint = await fs.readFile(path.resolve("runtime/entrypoint.sh"), "utf8");

  assert.match(entrypoint, /cleanup_stale_playwright_installs/);
  assert.match(entrypoint, /\.npm\/_npx/);
  assert.match(entrypoint, /\.cache\/ms-playwright/);
});

test("runtime playwright shim routes bare playwright invocations to playwright-cli", async () => {
  const shim = await fs.readFile(path.resolve("runtime/playwright-shim.sh"), "utf8");
  const wrapper = await fs.readFile(path.resolve("runtime/playwright-cli-wrapper.mjs"), "utf8");

  assert.match(shim, /exec \/usr\/local\/bin\/playwright-cli "\$@"/);
  assert.match(wrapper, /firstCommand\(argv\) !== "open"/);
  assert.match(wrapper, /"--config", defaultConfig/);
});
