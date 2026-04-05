import { pathToFileURL } from "node:url";

import { normalizeCopilotCliToken } from "./copilot-auth-token.mjs";
import { buildManifestFromEnv, normalizeAuthMode } from "./manifest-contract.mjs";
import {
  getProviderAdapter,
  resolveAuthCliBin as resolveProviderAuthCliBin,
  SUPPORTED_PROVIDER_AGENTS,
} from "./adapters/provider-factory.mjs";
import { resolveBootstrapAgentDirs } from "./adapters/bootstrap-shared.mjs";

export {
  discoverGeminiCliProjectId,
  ensureGeminiCliSettings,
  refreshGeminiCliOAuthData,
  resolveGeminiBootstrapProjectId,
  resolveGeminiProjectId,
  syncGeminiCliAuthProfiles,
} from "./adapters/gemini-bootstrap.mjs";
export { resolveBootstrapAgentDirs } from "./adapters/bootstrap-shared.mjs";

function parseArgs(argv) {
  return {
    probeOnly: argv.includes("--probe-only"),
    json: argv.includes("--json"),
  };
}

async function externalAdapter() {
  return {
    ok: true,
    mode: "external",
    detail: "External auth mode is active. The gateway will not manage CLI credentials.",
    recovery: "Ensure your external ACP/CLI runtime is installed and authenticated before starting or pairing the stack.",
  };
}

async function noneAdapter() {
  return {
    ok: true,
    mode: "none",
    detail: "Auth bootstrap is disabled.",
    recovery: "Provide auth out-of-band if your selected agent requires it.",
  };
}

async function runAgentBootstrap(agentId, baseContext, options = {}) {
  const normalizedAgent = String(agentId ?? "").trim().toLowerCase();
  const activeBootstrapMode = normalizeAuthMode(process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE ?? baseContext.manifest.security.authBootstrapMode);
  const explicitAuthCliBin = normalizedAgent === activeBootstrapMode ? process.env.OPENCLAW_AGENT_AUTH_CLI_BIN : "";
  const context = {
    ...baseContext,
    authCliBin: resolveProviderAuthCliBin(normalizedAgent, explicitAuthCliBin),
  };

  const adapter = getProviderAdapter(normalizedAgent);
  if (adapter?.bootstrap) {
    return await adapter.bootstrap(context, options);
  }
  return await externalAdapter(context, options);
}

function summarizeBootstrapResults(results = []) {
  const successes = results.filter((result) => result?.ok);
  const failures = results.filter((result) => !result?.ok);
  return {
    ok: failures.length === 0,
    mode: results.length > 1 ? "multi" : String(results[0]?.mode ?? "external"),
    detail: failures.length === 0
      ? `Auth bootstrap ready for: ${successes.map((result) => result.mode).join(", ")}.`
      : `Auth bootstrap failed for: ${failures.map((result) => result.mode).join(", ")}.`,
    recovery: failures.map((result) => `${result.mode}: ${result.recovery || result.detail}`).join(" "),
    results,
  };
}

export async function probeAuth(options = {}) {
  const runtimeEnv = process.env;
  const homeDir = runtimeEnv.HOME?.trim() || "/home/node";
  const manifest = buildManifestFromEnv(runtimeEnv);
  const mode = normalizeAuthMode(runtimeEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE ?? manifest.security.authBootstrapMode);
  const configuredAgentDir = runtimeEnv.OPENCLAW_AGENT_DIR?.trim() || String(manifest.agent?.agentDir ?? "").trim();
  const agentDirs = await resolveBootstrapAgentDirs(homeDir, configuredAgentDir);
  const context = {
    env: runtimeEnv,
    homeDir,
    manifest,
    agentDirs,
    githubToken: normalizeCopilotCliToken(runtimeEnv.COPILOT_GITHUB_TOKEN?.trim() || "")
      || "",
  };

  if (mode === "external") return await externalAdapter(context, options);
  if (mode === "none") return await noneAdapter(context, options);

  const allowedAgents = Array.isArray(manifest.acp?.allowedAgents) && manifest.acp.allowedAgents.length > 0
    ? manifest.acp.allowedAgents
    : [mode];
  const bootstrapAgents = [...new Set(
    allowedAgents
      .map((agent) => String(agent ?? "").trim().toLowerCase())
      .filter((agent) => SUPPORTED_PROVIDER_AGENTS.includes(agent)),
  )];
  if (bootstrapAgents.length <= 1) {
    return await runAgentBootstrap(bootstrapAgents[0] || mode, context, options);
  }

  const orderedAgents = [
    ...new Set([
      ...(SUPPORTED_PROVIDER_AGENTS.includes(mode) ? [mode] : []),
      ...bootstrapAgents,
    ]),
  ];
  const results = [];
  for (const agentId of orderedAgents) {
    results.push(await runAgentBootstrap(agentId, context, options));
  }
  return summarizeBootstrapResults(results);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await probeAuth({ probeOnly: args.probeOnly });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(result.detail);
    if (result.recovery) console.error(result.recovery);
    if (result.stderr) console.error(result.stderr.trim());
  }

  if (!result.ok) process.exit(1);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
