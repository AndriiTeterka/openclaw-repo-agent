import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const PATCH_SCRIPT = path.resolve("runtime/openclaw-copilot-sdk-provider-patch.mjs");
const EXTENSION_PATCH_MARKER = "OPENCLAW_COPILOT_SDK_PROVIDER_PATCH_V1";
const AUTH_PROFILES_PATCH_MARKER = "OPENCLAW_COPILOT_SDK_PROVIDER_RUNTIME_PATCH_V1";

const DIST_FIXTURE = `import { n as ensureAuthProfileStore } from "../../store-BpAvd-ka.js";
import { i as coerceSecretRef } from "../../types.secrets-Rqz2qv-w.js";
import { t as definePluginEntry } from "../../plugin-entry-BFhzQSoP.js";
import { n as listProfilesForProvider } from "../../profiles-BPdDUT-J.js";
import "../../provider-auth-Bd38MUDZ.js";
import { r as resolveCopilotApiToken, t as DEFAULT_COPILOT_API_BASE_URL } from "../../github-copilot-token-Be9GQ0Nm.js";
import { t as githubCopilotLoginCommand } from "../../provider-auth-login-NswR3Iwy.js";
import { n as resolveCopilotForwardCompatModel, t as PROVIDER_ID } from "../../models-DShoaYMg.js";
import "../../token-C8H8fI9Q.js";
import { t as fetchCopilotUsage } from "../../usage-DLRV_xyV.js";
var github_copilot_default = definePluginEntry({id: "github-copilot",register(api) {api.registerProvider({id: PROVIDER_ID,prepareRuntimeAuth: async (ctx) => {return { apiKey: ctx.apiKey, baseUrl: DEFAULT_COPILOT_API_BASE_URL };},resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),fetchUsageSnapshot: async (ctx) => await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn)});}});
export { github_copilot_default as default };
`;

const AUTH_PROFILES_FIXTURE = `import "./defaults-Dpv7c6Om.js";
function resolveProviderRuntimePlugin(params) {return params?.plugin;}
function resolveProviderStreamFn(params) {return resolveProviderRuntimePlugin(params)?.createStreamFn?.(params.context) ?? void 0;}
function wrapProviderStreamFn(params) {return resolveProviderRuntimePlugin(params)?.wrapStreamFn?.(params.context) ?? void 0;}
export { resolveProviderStreamFn, wrapProviderStreamFn };
`;

test("copilot SDK provider patch injects the runtime stream wrapper and is idempotent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-sdk-provider-patch-"));
  const distDir = path.join(tempDir, "dist");
  const extensionDir = path.join(distDir, "extensions", "github-copilot");
  const targetFile = path.join(extensionDir, "index.js");
  const authProfilesFile = path.join(distDir, "auth-profiles-test.js");

  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(targetFile, DIST_FIXTURE);
  await fs.writeFile(authProfilesFile, AUTH_PROFILES_FIXTURE);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(targetFile, "utf8");
  const patchedAuthProfiles = await fs.readFile(authProfilesFile, "utf8");

  assert.match(patched, new RegExp(EXTENSION_PATCH_MARKER));
  assert.match(patched, /from "\/opt\/openclaw\/copilot-sdk-provider\.mjs"/);
  assert.match(patched, /wrapStreamFn: \(ctx\) => createCopilotSdkProviderStreamWrapper\(ctx\),resolveUsageAuth:/);
  assert.match(patchedAuthProfiles, new RegExp(AUTH_PROFILES_PATCH_MARKER));
  assert.match(patchedAuthProfiles, /from "\/opt\/openclaw\/copilot-sdk-provider\.mjs"/);
  assert.match(patchedAuthProfiles, /if \(params\?\.provider === "github-copilot"\) return createCopilotSdkProviderStreamWrapper\(\{/);
  assert.match(patchedAuthProfiles, /return resolveProviderRuntimePlugin\(params\)\?\.wrapStreamFn\?\.\(params\.context\) \?\? void 0;/);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patchedAgain = await fs.readFile(targetFile, "utf8");
  const patchedAuthProfilesAgain = await fs.readFile(authProfilesFile, "utf8");
  assert.equal(patchedAgain, patched);
  assert.equal(patchedAuthProfilesAgain, patchedAuthProfiles);
});
