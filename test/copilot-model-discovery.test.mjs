import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const discoveryScript = path.join(repoRoot, "runtime", "copilot-model-discovery.mjs");
const commandRuntimeModuleUrl = pathToFileURL(path.join(repoRoot, "cli", "src", "command-runtime.mjs")).href;
const builtinProfilesModuleUrl = pathToFileURL(path.join(repoRoot, "cli", "src", "builtin-profiles.mjs")).href;

function runNode(command, args, env) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env,
      windowsHide: true,
    }, (error, stdout = "", stderr = "") => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

test("copilot model discovery uses the live SDK model list without active probes", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-discovery-"));
  const helperLogPath = path.join(tempRoot, "copilot-helper.log");
  const helperScriptPath = path.join(tempRoot, "fake-copilot-cli.mjs");
  const sdkPath = path.join(tempRoot, "sdk-index.mjs");

  await fs.writeFile(helperScriptPath, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.OPENCLAW_TEST_HELPER_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
    'process.exit(process.argv.includes("--help") ? 0 : 99);',
  ].join("\n"));
  await fs.writeFile(sdkPath, [
    "export function clearCachedModels() {}",
    "export async function retrieveAvailableModels(authInfo, copilotUrl) {",
    '  if (authInfo?.type !== "copilot-api-token") throw new Error("unexpected auth type");',
    '  if (process.env.GITHUB_COPILOT_API_TOKEN !== "copilot_session_token_value") throw new Error("missing copilot api token");',
    '  if (process.env.COPILOT_API_URL !== "https://api.example.githubcopilot.com") throw new Error("missing copilot api url");',
    '  if (copilotUrl !== "https://api.example.githubcopilot.com") throw new Error("unexpected copilot url");',
    "  return {",
    "    copilotUrl,",
    "    models: [",
    '      { id: "claude-sonnet-4.6", policy: { state: "enabled" } },',
    '      { id: "gpt-5.4", policy: { state: "enabled" } },',
    '      { id: "grok-code-fast-1", policy: { state: "enabled" } },',
    "    ],",
    "  };",
    "}",
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript, sdkPath], {
    ...process.env,
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    COPILOT_HOME: path.join(tempRoot, ".missing-copilot-home"),
    GITHUB_COPILOT_API_TOKEN: "copilot_session_token_value",
    COPILOT_API_URL: "https://api.example.githubcopilot.com",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: process.execPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI_ARGS: JSON.stringify([helperScriptPath]),
    OPENCLAW_TEST_HELPER_LOG: helperLogPath,
  });
  const models = JSON.parse(result.stdout);
  const helperLog = await fs.readFile(helperLogPath, "utf8").catch(() => "");

  assert.equal(result.stderr, "");
  assert.deepEqual(models, ["claude-sonnet-4.6", "gpt-5.4"]);
  assert.equal(helperLog, "");
});

test("copilot model discovery prefers the live Copilot CLI model list when the host client SDK is available", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-client-sdk-"));
  const cliPath = path.join(tempRoot, process.platform === "win32" ? "copilot.exe" : "copilot");
  const copilotHome = path.join(tempRoot, ".copilot");
  const clientSdkDir = path.join(copilotHome, "pkg", "universal", "1.0.18", "copilot-sdk");
  const clientSdkPath = path.join(clientSdkDir, "index.js");

  await fs.mkdir(clientSdkDir, { recursive: true });
  await fs.writeFile(cliPath, "", "utf8");
  await fs.writeFile(clientSdkPath, [
    "export class CopilotClient {",
    "  constructor(options = {}) {",
    "    this.options = options;",
    "  }",
    "  async start() {}",
    "  async listModels() {",
    "    if (!this.options.cliPath) throw new Error('missing cliPath');",
    "    if (!this.options.env?.COPILOT_HOME?.endsWith('.copilot')) throw new Error('missing copilot home');",
    "    return [",
    "      { id: 'claude-sonnet-4.6', policy: { state: 'enabled' } },",
    "      { id: 'gpt-5.4', policy: { state: 'enabled' } },",
    "      { id: 'gpt-4o-mini-2024-07-18', policy: { state: 'enabled' } },",
    "    ];",
    "  }",
    "  async stop() {}",
    "}",
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript], {
    ...process.env,
    USERPROFILE: tempRoot,
    COPILOT_HOME: "",
    HOME: "",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: cliPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });
  const models = JSON.parse(result.stdout);

  assert.equal(result.stderr, "");
  assert.deepEqual(models, ["claude-sonnet-4.6", "gpt-5.4", "gpt-4o-mini"]);
});

test("copilot model discovery default-only mode avoids configured fallbacks when no live model is known", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-default-only-"));
  const helperLogPath = path.join(tempRoot, "copilot-helper.log");
  const helperScriptPath = path.join(tempRoot, "fake-copilot-cli.mjs");
  const copilotHome = path.join(tempRoot, ".copilot");

  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    default_model: "gpt-5.4",
    logged_in_users: [{ login: "demo-user" }],
  }, null, 2));
  await fs.writeFile(helperScriptPath, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.OPENCLAW_TEST_HELPER_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
    'process.exit(process.argv.includes("--help") ? 0 : 99);',
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript], {
    ...process.env,
    HOME: tempRoot,
    COPILOT_HOME: copilotHome,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DEFAULT_ONLY: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_MAX_RESULTS: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: process.execPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI_ARGS: JSON.stringify([helperScriptPath]),
    OPENCLAW_TEST_HELPER_LOG: helperLogPath,
  });
  const models = JSON.parse(result.stdout);
  const helperLog = await fs.readFile(helperLogPath, "utf8").catch(() => "");

  assert.equal(result.stderr, "");
  assert.deepEqual(models, []);
  assert.equal(helperLog, "");
});

test("copilot model discovery with probes disabled avoids configured fallbacks when no live model is known", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-no-probes-"));
  const helperLogPath = path.join(tempRoot, "copilot-helper.log");
  const helperScriptPath = path.join(tempRoot, "fake-copilot-cli.mjs");
  const copilotHome = path.join(tempRoot, ".copilot");

  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    default_model: "gpt-5.4",
    logged_in_users: [{ login: "demo-user" }],
  }, null, 2));
  await fs.writeFile(helperScriptPath, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.OPENCLAW_TEST_HELPER_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
    'process.exit(process.argv.includes("--help") ? 0 : 99);',
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript], {
    ...process.env,
    HOME: tempRoot,
    COPILOT_HOME: copilotHome,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: process.execPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI_ARGS: JSON.stringify([helperScriptPath]),
    OPENCLAW_TEST_HELPER_LOG: helperLogPath,
  });
  const models = JSON.parse(result.stdout);
  const helperLog = await fs.readFile(helperLogPath, "utf8").catch(() => "");

  assert.equal(result.stderr, "");
  assert.deepEqual(models, []);
  assert.equal(helperLog, "");
});

test("copilot model discovery falls back to the live API after exchanging runtime auth", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-live-api-"));
  const fetchPatchPath = path.join(tempRoot, "fetch-models.mjs");

  await fs.writeFile(fetchPatchPath, [
    'globalThis.fetch = async (url) => {',
    '  const normalizedUrl = String(url);',
    '  if (normalizedUrl === "https://api.githubcopilot.com/models") {',
    '    return { ok: false, status: 401, async json() { return { data: [] }; } };',
    '  }',
    '  if (normalizedUrl === "https://api.github.com/copilot_internal/v2/token") {',
    '    return {',
    '      ok: true,',
    '      status: 200,',
    '      async json() {',
    '        return {',
    '          token: "copilot_session_token_value;proxy-ep=proxy.enterprise.githubcopilot.com",',
    '          expires_at: 1900000000,',
    '        };',
    '      },',
    '    };',
    '  }',
    '  if (normalizedUrl === "https://api.enterprise.githubcopilot.com/models") {',
    '    return {',
    '      ok: true,',
    '      status: 200,',
    '      async json() {',
    '        return {',
    '          data: [',
    '            { id: "claude-sonnet-4.6", policy: { state: "enabled" } },',
    '            { id: "gpt-4o-mini-2024-07-18", policy: { state: "enabled" } },',
    '            { id: "gpt-5.4", policy: { state: "disabled" } },',
    '          ],',
    '        };',
    '      },',
    '    };',
    '  }',
    '  throw new Error(`Unexpected URL: ${normalizedUrl}`);',
    '};',
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript], {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(fetchPatchPath).href}`,
    COPILOT_GITHUB_TOKEN: "github_pat_demo12345678901234567890",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });
  const models = JSON.parse(result.stdout);

  assert.doesNotMatch(result.stderr, /Unexpected URL|AssertionError|TypeError/);
  assert.deepEqual(models, ["claude-sonnet-4.6", "gpt-4o-mini"]);
});

test("copilot model discovery preserves live SDK ordering while normalizing snapshots", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-live-order-"));
  const sdkPath = path.join(tempRoot, "sdk-index.mjs");

  await fs.writeFile(sdkPath, [
    "export async function retrieveAvailableModels() {",
    "  return {",
    '    copilotUrl: "https://api.example.githubcopilot.com",',
    "    models: [",
    '      { id: "claude-sonnet-4.6", policy: { state: "enabled" } },',
    '      { id: "gpt-4o-mini-2024-07-18", policy: { state: "enabled" } },',
    '      { id: "gpt-5.4", policy: { state: "enabled" } },',
    "    ],",
    "  };",
    "}",
  ].join("\n"));

  const result = await runNode(process.execPath, [discoveryScript, sdkPath], {
    ...process.env,
    GITHUB_COPILOT_API_TOKEN: "copilot_session_token_value",
    COPILOT_API_URL: "https://api.example.githubcopilot.com",
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
  });
  const models = JSON.parse(result.stdout);

  assert.equal(result.stderr, "");
  assert.deepEqual(models, ["claude-sonnet-4.6", "gpt-4o-mini", "gpt-5.4"]);
});

test("buildEffectiveManifest disables active Copilot probes while normalizing the default model", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-manifest-"));
  const fetchLogPath = path.join(tempRoot, "fetch-log.jsonl");
  const helperLogPath = path.join(tempRoot, "copilot-helper.log");
  const helperScriptPath = path.join(tempRoot, "fake-copilot-cli.mjs");
  const fetchPatchPath = path.join(tempRoot, "fetch-delay.mjs");
  const copilotHome = path.join(tempRoot, ".copilot");

  await fs.mkdir(copilotHome, { recursive: true });
  await fs.writeFile(helperScriptPath, [
    'import fs from "node:fs";',
    'fs.appendFileSync(process.env.OPENCLAW_TEST_HELPER_LOG, `${process.argv.slice(2).join(" ")}\\n`);',
    'process.exit(process.argv.includes("--help") ? 0 : 99);',
  ].join("\n"));
  await fs.writeFile(fetchPatchPath, [
    'import fs from "node:fs";',
    'const delayMs = Number.parseInt(process.env.OPENCLAW_TEST_FETCH_DELAY_MS ?? "0", 10);',
    'const fetchLogPath = process.env.OPENCLAW_TEST_FETCH_LOG;',
    'globalThis.fetch = async (_url, options = {}) => {',
    '  if (fetchLogPath) fs.appendFileSync(fetchLogPath, JSON.stringify({ event: "start", at: Date.now() }) + "\\n");',
    '  await new Promise((resolve, reject) => {',
    '    const timer = setTimeout(resolve, delayMs);',
    '    options.signal?.addEventListener("abort", () => {',
    '      clearTimeout(timer);',
    '      if (fetchLogPath) fs.appendFileSync(fetchLogPath, JSON.stringify({ event: "abort", at: Date.now() }) + "\\n");',
    '      const error = new Error("The operation was aborted.");',
    '      error.name = "AbortError";',
    '      reject(error);',
    '    }, { once: true });',
    '  });',
    '  return {',
    '    ok: false,',
    '    status: 504,',
    '    async json() { return { data: [] }; },',
    '  };',
    '};',
  ].join("\n"));
  await fs.writeFile(path.join(copilotHome, "config.json"), JSON.stringify({
    default_model: "claude-sonnet-4.5",
    logged_in_users: [{ login: "demo-user" }],
  }, null, 2));

  const startedAt = Date.now();
  const { stdout } = await runNode(process.execPath, [
    "--input-type=module",
    "-e",
    [
      `import { buildEffectiveManifest } from ${JSON.stringify(commandRuntimeModuleUrl)};`,
      `import { DEFAULT_PLUGIN_CONFIG } from ${JSON.stringify(builtinProfilesModuleUrl)};`,
      "const plugin = {",
      "  ...DEFAULT_PLUGIN_CONFIG,",
      '  projectName: "demo-workspace",',
      '  deploymentProfile: "docker-local",',
      '  runtimeProfile: "stable-chat",',
      '  queueProfile: "stable-chat",',
      "  toolingProfiles: [],",
      "  stack: { languages: [], tools: [] },",
      "  agent: {",
      "    ...DEFAULT_PLUGIN_CONFIG.agent,",
      '    defaultModel: "",',
      "  },",
      "  acp: {",
      "    ...DEFAULT_PLUGIN_CONFIG.acp,",
      '    defaultAgent: "copilot",',
      '    allowedAgents: ["copilot"],',
      "  },",
      "  security: {",
      "    ...DEFAULT_PLUGIN_CONFIG.security,",
      '    authBootstrapMode: "copilot",',
      "  },",
      "};",
      "const manifest = buildEffectiveManifest(plugin, process.cwd(), {}, {});",
      'console.log(JSON.stringify({ defaultModel: manifest.agent.defaultModel }));',
    ].join("\n"),
  ], {
    ...process.env,
    HOME: tempRoot,
    COPILOT_HOME: copilotHome,
    NODE_OPTIONS: `--import=${pathToFileURL(fetchPatchPath).href}`,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI: process.execPath,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI_ARGS: JSON.stringify([helperScriptPath]),
    OPENCLAW_MODEL_DISCOVERY_COPILOT_DIRECT_TIMEOUT_MS: "100",
    OPENCLAW_TEST_FETCH_DELAY_MS: "2000",
    OPENCLAW_TEST_FETCH_LOG: fetchLogPath,
    OPENCLAW_TEST_HELPER_LOG: helperLogPath,
  });
  const durationMs = Date.now() - startedAt;
  const fetchLog = await fs.readFile(fetchLogPath, "utf8").catch(() => "");
  const helperLog = await fs.readFile(helperLogPath, "utf8").catch(() => "");
  const payload = JSON.parse(stdout);
  const fetchEvents = fetchLog
    .split(/\r?\n/g)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const fetchStartedAt = fetchEvents.find((entry) => entry.event === "start")?.at ?? 0;
  const fetchAbortedAt = fetchEvents.find((entry) => entry.event === "abort")?.at ?? 0;

  assert.equal(payload.defaultModel, "");
  assert.equal(helperLog, "");
  if (fetchStartedAt && fetchAbortedAt) {
    assert.ok(
      fetchAbortedAt - fetchStartedAt < 1000,
      `expected direct discovery timeout to abort quickly, but fetch took ${fetchAbortedAt - fetchStartedAt}ms`,
    );
  }
  assert.ok(durationMs < 5000, `expected manifest normalization to avoid a long stall, but took ${durationMs}ms`);
});
