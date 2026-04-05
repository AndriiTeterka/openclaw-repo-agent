import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("runtime core Dockerfile installs the supported CLIs and browser runtime", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile.core"), "utf8");

  assert.match(dockerfile, /npm install --global @github\/copilot @openai\/codex @google\/gemini-cli @playwright\/cli acpx@0\.3\.1/);
  assert.doesNotMatch(dockerfile, /cli\.github\.com\/packages/);
  assert.doesNotMatch(dockerfile, /\bgh\b/);
  assert.match(dockerfile, /ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(dockerfile, /@playwright\/cli\/node_modules\/\.bin\/playwright"\ install --with-deps chromium/);
  assert.match(dockerfile, /mkdir -p \/app\/extensions\/acpx\/node_modules \/home\/node\/\.openclaw \/ms-playwright/);
  assert.match(dockerfile, /COPY runtime\/adapters \/opt\/openclaw\/adapters/);
  assert.match(dockerfile, /COPY runtime\/copilot-installation\.mjs \/opt\/openclaw\/copilot-installation\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-sdk-provider\.mjs \/opt\/openclaw\/copilot-sdk-provider\.mjs/);
  assert.match(dockerfile, /COPY runtime\/provider-registry\.mjs \/opt\/openclaw\/provider-registry\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-model-discovery\.mjs \/opt\/openclaw\/copilot-model-discovery\.mjs/);
  assert.match(dockerfile, /COPY runtime\/live-models-provider-data\.mjs \/opt\/openclaw\/live-models-provider-data\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-disable-plugin-auto-enable-patch\.mjs \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-copilot-sdk-provider-patch\.mjs \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-telegram-models-patch\.mjs \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs \/app\/dist/);
});

test("runtime core Dockerfile keeps only the owned runtime patch surface", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile.core"), "utf8");

  assert.match(dockerfile, /RUN mv \/usr\/local\/bin\/playwright-cli \/usr\/local\/bin\/playwright-cli-real/);
  assert.match(dockerfile, /COPY runtime\/playwright-cli-wrapper\.mjs \/usr\/local\/bin\/playwright-cli/);
  assert.doesNotMatch(dockerfile, /playwright-cli-daemon-patch/);
  assert.doesNotMatch(dockerfile, /openclaw-telegram-provider-switch-patch/);
  assert.doesNotMatch(dockerfile, /playwright-shim/);
  assert.doesNotMatch(dockerfile, /npx-wrapper/);
  assert.doesNotMatch(dockerfile, /playwright-cli\.config\.json/);
  assert.doesNotMatch(dockerfile, /npx-real/);
});

test("runtime core overlay Dockerfile layers local runtime files onto the published runtime core", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile.core.overlay"), "utf8");

  assert.match(dockerfile, /ARG OPENCLAW_RUNTIME_CORE_BASE_IMAGE=ghcr\.io\/andriiteterka\/openclaw-repo-agent-runtime-core:latest/);
  assert.match(dockerfile, /FROM \$\{OPENCLAW_RUNTIME_CORE_BASE_IMAGE\}/);
  assert.match(dockerfile, /command -v acpx/);
  assert.match(dockerfile, /command -v codex/);
  assert.match(dockerfile, /command -v copilot/);
  assert.match(dockerfile, /command -v gemini/);
  assert.match(dockerfile, /playwright-cli-real/);
  assert.match(dockerfile, /COPY runtime\/adapters \/opt\/openclaw\/adapters/);
  assert.match(dockerfile, /COPY runtime\/copilot-installation\.mjs \/opt\/openclaw\/copilot-installation\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-sdk-provider\.mjs \/opt\/openclaw\/copilot-sdk-provider\.mjs/);
  assert.match(dockerfile, /COPY runtime\/provider-registry\.mjs \/opt\/openclaw\/provider-registry\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-model-discovery\.mjs \/opt\/openclaw\/copilot-model-discovery\.mjs/);
  assert.match(dockerfile, /COPY runtime\/live-models-provider-data\.mjs \/opt\/openclaw\/live-models-provider-data\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-disable-plugin-auto-enable-patch\.mjs \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-copilot-sdk-provider-patch\.mjs \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-telegram-models-patch\.mjs \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/entrypoint\.mjs \/opt\/openclaw\/entrypoint\.mjs/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /npm install --global @github\/copilot @openai\/codex @google\/gemini-cli @playwright\/cli acpx@0\.3\.1/);
  assert.match(dockerfile, /mkdir -p \/app\/extensions\/acpx\/node_modules/);
});

test("tooling Dockerfile overlays local runtime files onto the selected runtime core image", async () => {
  const dockerfile = await fs.readFile(path.resolve("runtime/Dockerfile.tooling"), "utf8");

  assert.match(dockerfile, /ARG OPENCLAW_RUNTIME_CORE_IMAGE=ghcr\.io\/andriiteterka\/openclaw-repo-agent-runtime-core:latest/);
  assert.match(dockerfile, /FROM \$\{OPENCLAW_RUNTIME_CORE_IMAGE\}/);
  assert.match(dockerfile, /command -v acpx/);
  assert.match(dockerfile, /command -v codex/);
  assert.match(dockerfile, /command -v copilot/);
  assert.match(dockerfile, /command -v gemini/);
  assert.match(dockerfile, /npm install --global @github\/copilot @openai\/codex @google\/gemini-cli @playwright\/cli acpx@0\.3\.1/);
  assert.match(dockerfile, /mkdir -p \/app\/extensions\/acpx\/node_modules/);
  assert.match(dockerfile, /COPY runtime\/adapters \/opt\/openclaw\/adapters/);
  assert.match(dockerfile, /COPY runtime\/copilot-installation\.mjs \/opt\/openclaw\/copilot-installation\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-sdk-provider\.mjs \/opt\/openclaw\/copilot-sdk-provider\.mjs/);
  assert.match(dockerfile, /COPY runtime\/provider-registry\.mjs \/opt\/openclaw\/provider-registry\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-model-discovery\.mjs \/opt\/openclaw\/copilot-model-discovery\.mjs/);
  assert.match(dockerfile, /COPY runtime\/live-models-provider-data\.mjs \/opt\/openclaw\/live-models-provider-data\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-disable-plugin-auto-enable-patch\.mjs \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-copilot-sdk-provider-patch\.mjs \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-telegram-models-patch\.mjs \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs/);
  assert.match(dockerfile, /COPY runtime\/entrypoint\.mjs \/opt\/openclaw\/entrypoint\.mjs/);
  assert.match(dockerfile, /COPY runtime\/playwright-cli-wrapper\.mjs \/usr\/local\/bin\/playwright-cli/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-disable-plugin-auto-enable-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-telegram-models-patch\.mjs \/app\/dist/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/opt\/openclaw\/entrypoint\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /COPY apply-tooling-manifest\.mjs \/tmp\/openclaw\/apply-tooling-manifest\.mjs/);
});

test("runtime entrypoint no longer cleans stale playwright cache state", async () => {
  const entrypoint = await fs.readFile(path.resolve("runtime/entrypoint.mjs"), "utf8");

  assert.doesNotMatch(entrypoint, /cleanupStalePlaywrightInstalls/);
  assert.doesNotMatch(entrypoint, /const NPX_ROOT =/);
  assert.doesNotMatch(entrypoint, /const PLAYWRIGHT_CACHE_DIR =/);
});

test("playwright wrapper keeps workspace config injection and artifact redirection", async () => {
  const wrapper = await fs.readFile(path.resolve("runtime/playwright-cli-wrapper.mjs"), "utf8");

  assert.match(wrapper, /const realCli = "\/usr\/local\/bin\/playwright-cli-real"/);
  assert.match(wrapper, /OPENCLAW_PLAYWRIGHT_CONFIG_PATH/);
  assert.match(wrapper, /OPENCLAW_PLAYWRIGHT_ARTIFACTS_DIR/);
  assert.match(wrapper, /path\.resolve\(process\.cwd\(\), "\.openclaw", "playwright", "cli\.config\.json"\)/);
  assert.match(wrapper, /path\.resolve\(process\.cwd\(\), "\.openclaw", "playwright", "artifacts"\)/);
  assert.match(wrapper, /if \(!fs\.existsSync\(configPath\)\) return argv;/);
  assert.match(wrapper, /return path\.relative\(process\.cwd\(\), path\.join\(workspaceArtifactsDir, path\.basename\(fileName\)\)\);/);
  assert.match(wrapper, /await fs\.promises\.mkdir\(workspaceArtifactsDir, \{ recursive: true \}\)/);
  assert.match(wrapper, /spawn\(realCli, withDefaultConfig\(artifactArgs\)/);
});

test("playwright wrapper no longer seeds a bundled default config or alternate entrypoints", async () => {
  const wrapper = await fs.readFile(path.resolve("runtime/playwright-cli-wrapper.mjs"), "utf8");

  assert.doesNotMatch(wrapper, /copyFile/);
  assert.doesNotMatch(wrapper, /defaultConfig/);
  assert.doesNotMatch(wrapper, /npx-real/);
  assert.doesNotMatch(wrapper, /playwright-shim/);
  assert.doesNotMatch(wrapper, /@playwright\/cli\/playwright-cli\.js/);
});
