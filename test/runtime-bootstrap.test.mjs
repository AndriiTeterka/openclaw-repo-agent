import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readTextFile } from "../runtime/shared.mjs";

const repoRoot = path.resolve(".");

test("openclaw base image ships the bundled acpx plugin", async () => {
  const dockerfile = await readTextFile(path.join(repoRoot, "runtime", "Dockerfile.core"));

  assert.doesNotMatch(dockerfile, /openclaw plugins install @openclaw\/acpx/);
});

test("runtime entrypoint accepts either a local or bundled acpx plugin", async () => {
  const entrypoint = await readTextFile(path.join(repoRoot, "runtime", "entrypoint.mjs"));

  assert.doesNotMatch(entrypoint, /openclaw plugins install @openclaw\/acpx/);
  assert.match(entrypoint, /const BUNDLED_ACPX_DIR = "\/app\/extensions\/acpx"/);
  assert.match(entrypoint, /BUNDLED_ACPX_MANIFEST = "\/app\/extensions\/acpx\/openclaw\.plugin\.json"/);
  assert.match(entrypoint, /const GLOBAL_ACPX_COMMAND = "\/usr\/local\/bin\/acpx"/);
  assert.match(entrypoint, /process\.env\.OPENCLAW_ACPX_COMMAND = GLOBAL_ACPX_COMMAND/);
  assert.match(entrypoint, /process\.env\.OPENCLAW_ACPX_EXPECTED_VERSION = GLOBAL_ACPX_EXPECTED_VERSION/);
  assert.match(entrypoint, /await ensureDir\(BUNDLED_ACPX_NODE_MODULES_DIR\)/);
  assert.match(entrypoint, /await fs\.chmod\(RUNTIME_HOME, 0o700\)/);
  assert.match(entrypoint, /watchGatewayTelegram/);
  assert.match(entrypoint, /function isHealthCommand\(argv\)/);
  assert.match(entrypoint, /if \(!isHealthCommand\(argv\)\) \{\s*await runBootstrap\(eventLogger\);\s*\}/);
  assert.match(entrypoint, /COPILOT_TOKEN_EXCHANGE_URL(?: as SHARED_COPILOT_TOKEN_EXCHANGE_URL)?/);
  assert.match(entrypoint, /createProcessEventLogger/);
  assert.match(entrypoint, /withObservedStage/);
  assert.match(entrypoint, /from "\.\/observability\.mjs"/);
  assert.match(entrypoint, /async function validateCopilotRuntimeTokenExchange\(\)/);
  assert.match(entrypoint, /resolveCopilotRuntimeAuth/);
  assert.match(entrypoint, /OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS/);
  assert.match(entrypoint, /OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS/);
  assert.match(entrypoint, /OPENCLAW_COPILOT_RUNTIME_BASE_URL/);
  assert.match(entrypoint, /OPENCLAW_COPILOT_RUNTIME_TOKEN_SOURCE/);
  assert.match(entrypoint, /await validateCopilotRuntimeTokenExchange\(\)/);
  assert.doesNotMatch(entrypoint, /OPENCLAW_SUPPRESSED_COPILOT_GITHUB_TOKEN/);
  assert.doesNotMatch(entrypoint, /suppressCopilotEnvTokensForMirroredAuth/);
  assert.match(entrypoint, /const POST_START_CONFIG_RECONCILE_DELAY_MS = Number\.parseInt/);
  assert.match(entrypoint, /const POST_START_CONFIG_RECONCILE_INTERVAL_MS = Number\.parseInt/);
  assert.match(entrypoint, /const POST_START_CONFIG_RECONCILE_ATTEMPTS = Number\.parseInt/);
  assert.match(entrypoint, /const POST_START_CONFIG_RECONCILE_TIMEOUT_MS = Number\.parseInt/);
  assert.match(entrypoint, /OPENCLAW_POST_START_CONFIG_RECONCILE_TIMEOUT_MS \|\| "180000"/);
  assert.match(entrypoint, /async function renderOpenclawConfigStatus\(\{ envOverrides = null, timeoutMs = 120_000 \} = \{\}\)/);
  assert.match(entrypoint, /async function reconcileGatewayConfigAfterStart\(child\)/);
  assert.match(entrypoint, /emitObservedEvent/);
  assert.match(entrypoint, /await runBootstrap\(eventLogger\)/);
  assert.match(entrypoint, /await renderOpenclawConfigStatus\(\{\s*envOverrides: STARTUP_RENDER_ENV_OVERRIDES,\s*\}\)/);
  assert.match(entrypoint, /const reconcileTimeoutMs = Number\.isFinite\(POST_START_CONFIG_RECONCILE_TIMEOUT_MS\)/);
  assert.match(entrypoint, /const status = await renderOpenclawConfigStatus\(\{\s*timeoutMs: reconcileTimeoutMs,\s*\}\)/);
  assert.match(entrypoint, /for \(let attempt = 0; attempt < attempts; attempt \+= 1\)/);
  assert.match(entrypoint, /catch \(error\) \{\s*console\.error\(\s*`Post-start OpenClaw config reconcile failed on attempt \$\{attempt \+ 1\}\/\$\{attempts\}: \$\{error instanceof Error \? error\.message : String\(error\)\}`,\s*\);\s*\}/);
  assert.match(entrypoint, /const configReconcilePromise = reconcileGatewayConfigAfterStart\(child\)/);
  assert.match(entrypoint, /Post-start OpenClaw config reconcile detected startup drift on attempt/);
  assert.match(entrypoint, /"openclaw",\s*\["channels", "logs", "--channel", "telegram", "--json", "--lines", "40"\]/);
  assert.match(entrypoint, /"Polling stall detected"/);
  assert.match(entrypoint, /"polling runner stop timed out"/);
  assert.doesNotMatch(entrypoint, /sendMessage failed: Network request/);
  assert.doesNotMatch(entrypoint, /answerCallbackQuery failed: Network request/);
  assert.doesNotMatch(entrypoint, /callback handler failed: HttpError: Network request/);
  assert.match(entrypoint, /Telegram watchdog detected a stale polling stall/);
  assert.match(entrypoint, /process\.env\.JAVA_HOME = selected/);
  assert.match(entrypoint, /argCount: argv\.length/);
  assert.doesNotMatch(entrypoint, /defaults:\s*\{\s*argv\s*\}/);
});

test("runtime disables upstream provider auto-enable during startup", async () => {
  const patch = await readTextFile(path.join(repoRoot, "runtime", "openclaw-disable-plugin-auto-enable-patch.mjs"));

  assert.match(patch, /OPENCLAW_DISABLE_PLUGIN_AUTO_ENABLE_PATCH/);
  assert.match(patch, /applyPluginAutoEnable/);
  assert.match(patch, /changes:\s*\[\]/);
});

test("runtime ships a Copilot token patch for the bundled provider", async () => {
  const patch = await readTextFile(path.join(repoRoot, "runtime", "openclaw-copilot-token-patch.mjs"));
  const dockerfile = await readTextFile(path.join(repoRoot, "runtime", "Dockerfile.tooling"));

  assert.match(patch, /OPENCLAW_COPILOT_TOKEN_PATCH_V1/);
  assert.match(patch, /resolveCopilotRuntimeAuth/);
  assert.match(dockerfile, /COPY runtime\/observability\.mjs \/opt\/openclaw\/observability\.mjs/);
  assert.match(dockerfile, /COPY runtime\/copilot-runtime-auth\.mjs \/opt\/openclaw\/copilot-runtime-auth\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-copilot-token-patch\.mjs \/opt\/openclaw\/openclaw-copilot-token-patch\.mjs/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-copilot-token-patch\.mjs \/app\/dist/);
});

test("runtime ships a Copilot SDK stream patch for the bundled provider", async () => {
  const patch = await readTextFile(path.join(repoRoot, "runtime", "openclaw-copilot-sdk-provider-patch.mjs"));
  const dockerfile = await readTextFile(path.join(repoRoot, "runtime", "Dockerfile.tooling"));

  assert.match(patch, /OPENCLAW_COPILOT_SDK_PROVIDER_PATCH_V1/);
  assert.match(patch, /createCopilotSdkProviderStreamWrapper/);
  assert.match(dockerfile, /COPY runtime\/copilot-sdk-provider\.mjs \/opt\/openclaw\/copilot-sdk-provider\.mjs/);
  assert.match(dockerfile, /COPY runtime\/openclaw-copilot-sdk-provider-patch\.mjs \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs/);
  assert.match(dockerfile, /node \/opt\/openclaw\/openclaw-copilot-sdk-provider-patch\.mjs \/app\/dist/);
});

test("runtime config renderer preserves prior allowed-provider model catalog entries", async () => {
  const renderer = await readTextFile(path.join(repoRoot, "runtime", "render-openclaw-config.mjs"));

  assert.match(renderer, /createProcessEventLogger/);
  assert.match(renderer, /render\.config\.started/);
  assert.match(renderer, /render\.config\.finished/);
  assert.match(renderer, /function mergePreservedAllowedProviderModels/);
  assert.match(renderer, /shouldPreserveConfiguredModelRef/);
  assert.match(renderer, /resolveDefaultModelProvider/);
  assert.match(renderer, /modelProviderPrefix/);
  assert.match(renderer, /mergePreservedAllowedProviderModels\(\{/);
});
