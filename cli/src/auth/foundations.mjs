import os from "node:os";
import path from "node:path";

import {
  fileExists,
  uniqueStrings
} from "../../../runtime/shared.mjs";
import { normalizeAuthMode } from "../../../runtime/manifest-contract.mjs";
import {
  SUPPORTED_ACP_AGENTS,
  assertSupportedAcpAgent,
  assertSupportedAcpAgentList
} from "../../../runtime/supported-acp-agents.mjs";
import {
  getAuthBootstrapProviderForAgent,
  getAuthBootstrapProviderForMode,
  normalizeAllowedAgents
} from "../plugin-config.mjs";
import { parseFlexibleArray } from "../utils/parse-utils.mjs";
import { toDockerPath } from "../utils/path-utils.mjs";

function resolveLocalOverrideValue(optionsValue, envValue, fallback) {
  if (optionsValue != null && optionsValue !== "") return optionsValue;
  if (envValue != null && envValue !== "") return envValue;
  return fallback;
}

async function detectProviderAuthPath(agentId) {
  const authProvider = getAuthBootstrapProviderForAgent(agentId);
  const authFileName = String(authProvider?.authFileName ?? "").trim();
  const authHomeEnvKey = String(authProvider?.authHomeEnvKey ?? "").trim();
  const authHomeDirName = String(authProvider?.authHomeDirName ?? "").trim();
  if (!authFileName || !authHomeDirName) return "";

  const candidates = uniqueStrings([
    authHomeEnvKey ? process.env[authHomeEnvKey] : "",
    path.join(os.homedir(), authHomeDirName)
  ]);

  for (const candidate of candidates) {
    const authFile = path.join(candidate, authFileName);
    if (await fileExists(authFile)) return toDockerPath(path.resolve(candidate));
  }

  return "";
}

export function resolveAgentAuthSourceEnvKey(agentId) {
  return String(getAuthBootstrapProviderForAgent(agentId)?.authSourceEnvKey ?? "").trim();
}

export function normalizeStoredAuthPath(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return toDockerPath(path.resolve(normalized));
}

export function normalizeAuthSourceValue(value, fallback = "") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "auth-folder") return normalized;
  return fallback;
}

export function resolveBootstrapAgentForMode(authMode, defaultAgent = "") {
  const normalizedMode = normalizeAuthMode(authMode);
  const bootstrapProvider = getAuthBootstrapProviderForMode(normalizedMode);
  if (bootstrapProvider?.mode) return bootstrapProvider.mode;
  return assertSupportedAcpAgent(defaultAgent, "acp.defaultAgent");
}

export function resolveExplicitAllowedAgents(rawConfig, options = {}, localEnv = {}) {
  if (options.acpAllowedAgent?.length) {
    return assertSupportedAcpAgentList(uniqueStrings(options.acpAllowedAgent), "--acp-allowed-agent");
  }

  const envAllowedAgents = String(localEnv.OPENCLAW_ACP_ALLOWED_AGENTS ?? "").trim();
  if (envAllowedAgents) {
    return assertSupportedAcpAgentList(parseFlexibleArray(envAllowedAgents, []), "OPENCLAW_ACP_ALLOWED_AGENTS");
  }

  const configuredAllowedAgents = rawConfig?.acp?.allowedAgents;
  if (Array.isArray(configuredAllowedAgents) && configuredAllowedAgents.length > 0) {
    const normalizedConfiguredAllowedAgents = assertSupportedAcpAgentList(configuredAllowedAgents, "acp.allowedAgents");
    const configuredDefaultAgent = assertSupportedAcpAgent(String(rawConfig?.acp?.defaultAgent ?? "").trim(), "acp.defaultAgent");
    if (
      normalizedConfiguredAllowedAgents.length === 1
      && configuredDefaultAgent
      && normalizedConfiguredAllowedAgents[0] === configuredDefaultAgent
    ) {
      return [];
    }
    return normalizedConfiguredAllowedAgents;
  }

  return [];
}

export function resolveDetectedAuthPathForAgent(agentId, detectedAuthPaths = {}) {
  const authProvider = getAuthBootstrapProviderForAgent(agentId);
  if (!authProvider) return "";
  if (typeof detectedAuthPaths === "string") {
    return authProvider.mode === "codex" ? detectedAuthPaths : "";
  }
  if (!detectedAuthPaths || typeof detectedAuthPaths !== "object") return "";
  return String(detectedAuthPaths[authProvider.mode] ?? "").trim();
}

export function resolveStoredAgentAuthPath(agentId, detectedAuthPaths = {}) {
  const authProvider = getAuthBootstrapProviderForAgent(agentId);
  if (!authProvider) return "";
  return resolveDetectedAuthPathForAgent(agentId, detectedAuthPaths);
}

export function resolveStoredAgentAuthSource(agentId, localEnv = {}, detectedAuthPaths = {}, authMode = "") {
  const envKey = resolveAgentAuthSourceEnvKey(agentId);
  const configuredSource = normalizeAuthSourceValue(envKey ? localEnv[envKey] : "");
  if (configuredSource) return configuredSource;

  const authProvider = getAuthBootstrapProviderForAgent(agentId);
  if (!authProvider) return "";
  const detectedAuthPath = resolveStoredAgentAuthPath(agentId, detectedAuthPaths);
  if (detectedAuthPath) return "auth-folder";
  return "";
}

export function inferImplicitAllowedAgents(defaultAgent, localEnv = {}, detectedAuthPaths = {}, authMode = "") {
  const normalizedDefaultAgent = assertSupportedAcpAgent(defaultAgent, "acp.defaultAgent");
  if (!normalizedDefaultAgent) return [];

  const inferredAgents = [normalizedDefaultAgent];
  for (const agentId of SUPPORTED_ACP_AGENTS) {
    const authProvider = getAuthBootstrapProviderForAgent(agentId);
    if (!authProvider) continue;

    const storedAuthPath = resolveStoredAgentAuthPath(agentId, detectedAuthPaths);
    if (storedAuthPath) inferredAgents.push(agentId);
  }

  return normalizeAllowedAgents(normalizedDefaultAgent, inferredAgents);
}

export function resolveEffectiveAllowedAgents(rawConfig, plugin, localEnv = {}, options = {}, detectedAuthPaths = {}) {
  const acpDefaultAgent = assertSupportedAcpAgent(
    resolveLocalOverrideValue(options.acpDefaultAgent, localEnv.OPENCLAW_ACP_DEFAULT_AGENT, plugin.acp.defaultAgent),
    options.acpDefaultAgent != null && options.acpDefaultAgent !== ""
      ? "--acp-default-agent"
      : (String(localEnv.OPENCLAW_ACP_DEFAULT_AGENT ?? "").trim() ? "OPENCLAW_ACP_DEFAULT_AGENT" : "acp.defaultAgent")
  );
  const authMode = normalizeAuthMode(resolveLocalOverrideValue(options.authMode, localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE, plugin.security.authBootstrapMode));
  const explicitAllowedAgents = resolveExplicitAllowedAgents(rawConfig, options, localEnv);
  if (explicitAllowedAgents.length > 0) return normalizeAllowedAgents(acpDefaultAgent, explicitAllowedAgents);
  return inferImplicitAllowedAgents(acpDefaultAgent, localEnv, detectedAuthPaths, authMode);
}

export async function detectDefaultCodexAuthPath() {
  return await detectProviderAuthPath("codex");
}

export async function detectDefaultGeminiAuthPath() {
  return await detectProviderAuthPath("gemini");
}

export async function detectDefaultCopilotAuthPath() {
  return await detectProviderAuthPath("copilot");
}

export async function detectDefaultAuthPathForMode(authMode) {
  const provider = getAuthBootstrapProviderForMode(authMode);
  if (!provider) return "";
  return await detectProviderAuthPath(provider.mode);
}

export async function detectDefaultAuthPaths() {
  const entries = await Promise.all(
    SUPPORTED_ACP_AGENTS.map(async (agentId) => [agentId, await detectProviderAuthPath(agentId)])
  );
  return Object.fromEntries(entries);
}

export function resolveProviderAuthAvailability(agentIds = SUPPORTED_ACP_AGENTS, detectedAuthPaths = {}) {
  const normalizedAgents = Array.isArray(agentIds) ? agentIds : [agentIds];
  return uniqueStrings(assertSupportedAcpAgentList(
    normalizedAgents.filter((agentId) => String(agentId ?? "").trim()),
    "ACP agents"
  )).map((agentId) => {
    const authProvider = getAuthBootstrapProviderForAgent(agentId);
    const authPath = resolveStoredAgentAuthPath(agentId, detectedAuthPaths);
    return {
      agentId,
      agentLabel: authProvider?.agentLabel || agentId,
      authPath,
      available: Boolean(authPath)
    };
  });
}

export function resolveSubscriptionAuthSource(agentId, detectedAuthPaths = {}) {
  return resolveStoredAgentAuthPath(agentId, detectedAuthPaths) ? "auth-folder" : "";
}

export function defaultAuthSource(existingLocalEnv = {}, options = {}, detectedAuthPath = "", authProvider = null) {
  if (!authProvider) return "";

  const existingSource = resolveStoredAgentAuthSource(
    authProvider.mode,
    existingLocalEnv,
    { [authProvider.mode]: detectedAuthPath },
    authProvider.mode
  );
  if (existingSource) return existingSource;
  if (detectedAuthPath) return "auth-folder";
  return "";
}

export function defaultCodexAuthSource(existingLocalEnv, options, detectedCodexAuthPath = "") {
  return defaultAuthSource(
    existingLocalEnv,
    options,
    detectedCodexAuthPath,
    getAuthBootstrapProviderForAgent("codex")
  );
}

export function defaultGeminiAuthSource(existingLocalEnv, options, detectedGeminiAuthPath = "") {
  return defaultAuthSource(
    existingLocalEnv,
    options,
    detectedGeminiAuthPath,
    getAuthBootstrapProviderForAgent("gemini")
  );
}

export function defaultCopilotAuthSource(existingLocalEnv, options, detectedCopilotAuthPath = "") {
  return defaultAuthSource(
    existingLocalEnv,
    options,
    detectedCopilotAuthPath,
    getAuthBootstrapProviderForAgent("copilot")
  );
}
