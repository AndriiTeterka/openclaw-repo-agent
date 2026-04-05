import {
  deepMerge,
  deriveDefaultAgentName,
  deriveProjectRootName,
  isPlainObject,
  resolveBoolean,
  uniqueStrings
} from "../../runtime/shared.mjs";
import {
  DEFAULT_PROJECT_CONFIG,
  defaultDeploymentProfile,
  normalizeAuthMode
} from "../../runtime/manifest-contract.mjs";
import {
  getLatestCurrentProviderModel,
  modelProviderPrefix,
  resolveDefaultModelProvider
} from "../../runtime/model-catalog.mjs";
import {
  assertSupportedAcpAgent,
  assertSupportedAcpAgentList
} from "../../runtime/supported-acp-agents.mjs";
import {
  normalizeStack,
  normalizeToolingProfiles
} from "../../runtime/tooling-stack.mjs";
import {
  getProviderAdapterMetadata,
  getProviderAdapterMetadataForMode
} from "../../runtime/adapters/provider-factory.mjs";

const DEFAULT_CONFIG_FILE = "config.json";

function normalizeSubscriptionOnlyAuthSourceChoices(provider) {
  const authSourceChoices = Array.isArray(provider?.authSourceChoices) ? provider.authSourceChoices : [];
  const authFolderChoice = authSourceChoices.find((choice) => String(choice?.value ?? "").trim() === "auth-folder");
  if (authFolderChoice) return Object.freeze([authFolderChoice]);
  if (!provider?.authFolderLabel) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      value: "auth-folder",
      label: `Use ${provider.authFolderLabel}`
    })
  ]);
}

function toCliAuthBootstrapProvider(provider) {
  if (!provider) return null;
  return Object.freeze({
    ...provider,
    authSourceChoices: normalizeSubscriptionOnlyAuthSourceChoices(provider)
  });
}

export const CODEX_AUTH_SOURCE_CHOICES = toCliAuthBootstrapProvider(getProviderAdapterMetadata("codex"))?.authSourceChoices ?? [];
export const GEMINI_AUTH_SOURCE_CHOICES = toCliAuthBootstrapProvider(getProviderAdapterMetadata("gemini"))?.authSourceChoices ?? [];
export const COPILOT_AUTH_SOURCE_CHOICES = toCliAuthBootstrapProvider(getProviderAdapterMetadata("copilot"))?.authSourceChoices ?? [];

const SUPPORTED_PLUGIN_CONFIG_TOP_LEVEL_KEYS = new Set([
  "projectName",
  "deploymentProfile",
  "toolingProfiles",
  "tooling",
  "stack",
  "runtimeProfile",
  "queueProfile",
  "agent",
  "telegram",
  "acp",
  "security"
]);

function assertSupportedPluginConfig(rawConfig) {
  if (rawConfig == null) return;
  if (!isPlainObject(rawConfig)) {
    throw new Error(`${DEFAULT_CONFIG_FILE} must contain a JSON object at the top level.`);
  }

  const unsupportedKeys = Object.keys(rawConfig)
    .filter((key) => !SUPPORTED_PLUGIN_CONFIG_TOP_LEVEL_KEYS.has(key))
    .sort();
  if (unsupportedKeys.length === 0) return;

  throw new Error(`Unsupported top-level keys in ${DEFAULT_CONFIG_FILE}: ${unsupportedKeys.join(", ")}`);
}

function assertNoDeprecatedTelegramConfig(rawConfig) {
  const telegram = rawConfig?.telegram;
  if (!isPlainObject(telegram)) return;

  const deprecatedKeys = ["allowFrom", "groupAllowFrom", "proxy"].filter((key) => key in telegram);
  if (deprecatedKeys.length === 0) return;

  throw new Error(`Deprecated telegram keys in ${DEFAULT_CONFIG_FILE}: ${deprecatedKeys.map((key) => `telegram.${key}`).join(", ")}`);
}

export function normalizeAllowedAgents(defaultAgent, allowedAgents = []) {
  return uniqueStrings([
    ...assertSupportedAcpAgentList(allowedAgents, "acp.allowedAgents"),
    ...(defaultAgent ? [assertSupportedAcpAgent(defaultAgent, "acp.defaultAgent")] : [])
  ]);
}

export function getAuthBootstrapProviderForAgent(agentId) {
  return getProviderAdapterMetadata(agentId);
}

export function getAuthBootstrapProviderForMode(mode) {
  return getProviderAdapterMetadataForMode(normalizeAuthMode(mode));
}

function resolveCurrentProviderForAgent(agentId, authMode = "", localEnv = {}) {
  return resolveDefaultModelProvider({
    defaultAgent: agentId,
    authMode,
    env: localEnv
  });
}

function normalizeConfiguredAgentModel(value, acpDefaultAgent, authMode = "", localEnv = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";

  const currentProviderPrefix = modelProviderPrefix(normalized);
  const activeProvider = resolveCurrentProviderForAgent(acpDefaultAgent, authMode, localEnv);
  if (currentProviderPrefix && activeProvider && currentProviderPrefix !== activeProvider) return "";

  return normalized;
}

export function normalizeDefaultAgentModel(value, acpDefaultAgent, authMode = "", localEnv = {}, discoveryEnv = process.env) {
  const normalized = normalizeConfiguredAgentModel(value, acpDefaultAgent, authMode, localEnv);
  if (normalized) return normalized;

  const provider = resolveCurrentProviderForAgent(acpDefaultAgent, authMode, localEnv);
  return provider ? getLatestCurrentProviderModel(provider, discoveryEnv) : "";
}

export function resolvePreferredAuthMode(rawAuthMode, acpDefaultAgent) {
  const normalized = String(rawAuthMode ?? "").trim();
  if (normalized) return normalizeAuthMode(normalized);
  return getAuthBootstrapProviderForAgent(acpDefaultAgent)?.mode || "external";
}

export function normalizePluginConfig(rawConfig, repoRoot, detection, options = {}) {
  assertSupportedPluginConfig(rawConfig);
  assertNoDeprecatedTelegramConfig(rawConfig);
  const defaultConfig = deepMerge(DEFAULT_PROJECT_CONFIG);
  const merged = deepMerge(defaultConfig, rawConfig ?? {});

  const configuredProjectName = String(rawConfig?.projectName ?? "").trim();
  const projectName = String(options.projectName ?? configuredProjectName).trim() || deriveProjectRootName(repoRoot);
  const deploymentProfile = String(options.deploymentProfile ?? merged.deploymentProfile ?? defaultDeploymentProfile()).trim() || defaultDeploymentProfile();
  const runtimeProfile = String(options.runtimeProfile ?? merged.runtimeProfile ?? "stable-chat").trim() || "stable-chat";
  const queueProfile = String(options.queueProfile ?? merged.queueProfile ?? runtimeProfile).trim() || runtimeProfile;
  const optionToolingProfiles = Array.isArray(options.toolingProfile) ? normalizeToolingProfiles(options.toolingProfile) : [];
  const configuredToolingProfiles = normalizeToolingProfiles(rawConfig?.toolingProfiles ?? merged.toolingProfiles);
  const detectedToolingProfiles = normalizeToolingProfiles(detection.toolingProfiles);
  const toolingProfiles = optionToolingProfiles.length > 0
    ? optionToolingProfiles
    : (configuredToolingProfiles.length > 0 ? configuredToolingProfiles : detectedToolingProfiles);
  const configuredStack = normalizeStack(rawConfig?.stack ?? merged.stack);
  const detectedStack = normalizeStack(detection.stack);
  const stack = (configuredStack.languages.length > 0 || configuredStack.tools.length > 0)
    ? configuredStack
    : detectedStack;
  const requestedAllowedAgents = options.acpAllowedAgent?.length
    ? options.acpAllowedAgent
    : Array.isArray(merged.acp?.allowedAgents)
      ? merged.acp.allowedAgents
      : [];

  const plugin = {
    projectName,
    deploymentProfile,
    toolingProfiles,
    stack,
    runtimeProfile,
    queueProfile,
    agent: deepMerge(merged.agent ?? {}),
    telegram: deepMerge(merged.telegram ?? {}),
    acp: deepMerge(merged.acp ?? {}),
    security: deepMerge(merged.security ?? {})
  };

  plugin.agent.id = String(plugin.agent.id ?? defaultConfig.agent.id ?? "workspace").trim() || "workspace";
  plugin.agent.name = String(plugin.agent.name ?? "").trim() || deriveDefaultAgentName(projectName, repoRoot);
  plugin.agent.maxConcurrent = Number.isInteger(plugin.agent.maxConcurrent) && plugin.agent.maxConcurrent > 0 ? plugin.agent.maxConcurrent : 4;
  plugin.agent.skipBootstrap = resolveBoolean(plugin.agent.skipBootstrap, true);
  plugin.agent.verboseDefault = String(plugin.agent.verboseDefault ?? "on").trim() || "on";
  plugin.agent.thinkingDefault = String(plugin.agent.thinkingDefault ?? "adaptive").trim() || "adaptive";
  plugin.agent.blockStreamingDefault = String(plugin.agent.blockStreamingDefault ?? "off").trim() || "off";
  plugin.agent.blockStreamingBreak = String(plugin.agent.blockStreamingBreak ?? "text_end").trim() || "text_end";
  plugin.agent.typingMode = String(plugin.agent.typingMode ?? "message").trim() || "message";
  plugin.agent.typingIntervalSeconds = Number.isInteger(plugin.agent.typingIntervalSeconds) ? plugin.agent.typingIntervalSeconds : 12;
  plugin.agent.tools = {
    deny: uniqueStrings(plugin.agent.tools?.deny ?? plugin.security.toolDeny ?? ["process"])
  };

  plugin.telegram.dmPolicy = String(options.dmPolicy ?? plugin.telegram.dmPolicy ?? "pairing").trim() || "pairing";
  plugin.telegram.groupPolicy = String(options.groupPolicy ?? plugin.telegram.groupPolicy ?? "disabled").trim() || "disabled";
  plugin.telegram.streamMode = String(options.streamMode ?? plugin.telegram.streamMode ?? "partial").trim() || "partial";
  plugin.telegram.blockStreaming = resolveBoolean(plugin.telegram.blockStreaming, false);
  plugin.telegram.replyToMode = String(options.replyToMode ?? plugin.telegram.replyToMode ?? "all").trim() || "all";
  plugin.telegram.reactionLevel = String(plugin.telegram.reactionLevel ?? "minimal").trim() || "minimal";
  plugin.telegram.configWrites = resolveBoolean(plugin.telegram.configWrites, false);
  plugin.telegram.groups = deepMerge(plugin.telegram.groups ?? { "*": { requireMention: true } });
  plugin.telegram.threadBindings = {
    spawnAcpSessions: resolveBoolean(plugin.telegram.threadBindings?.spawnAcpSessions, false)
  };
  plugin.telegram.network = {
    autoSelectFamily: resolveBoolean(plugin.telegram.network?.autoSelectFamily, true)
  };

  plugin.acp.defaultAgent = assertSupportedAcpAgent(
    String(options.acpDefaultAgent ?? plugin.acp.defaultAgent ?? "").trim(),
    options.acpDefaultAgent != null && options.acpDefaultAgent !== "" ? "--acp-default-agent" : "acp.defaultAgent"
  );
  plugin.acp.allowedAgents = uniqueStrings([
    ...assertSupportedAcpAgentList(
      requestedAllowedAgents,
      options.acpAllowedAgent?.length ? "--acp-allowed-agent" : "acp.allowedAgents"
    ),
    ...(plugin.acp.defaultAgent ? [plugin.acp.defaultAgent] : [])
  ]);
  plugin.acp.preferredMode = String(plugin.acp.preferredMode ?? "oneshot").trim() || "oneshot";
  plugin.acp.maxConcurrentSessions = Number.isInteger(plugin.acp.maxConcurrentSessions) ? plugin.acp.maxConcurrentSessions : 4;
  plugin.acp.ttlMinutes = Number.isInteger(plugin.acp.ttlMinutes) ? plugin.acp.ttlMinutes : 120;
  plugin.acp.stream = {
    coalesceIdleMs: Number.isInteger(plugin.acp.stream?.coalesceIdleMs) ? plugin.acp.stream.coalesceIdleMs : 300,
    maxChunkChars: Number.isInteger(plugin.acp.stream?.maxChunkChars) ? plugin.acp.stream.maxChunkChars : 1200
  };

  plugin.agent.defaultModel = normalizeConfiguredAgentModel(
    options.agentDefaultModel ?? plugin.agent.defaultModel,
    plugin.acp.defaultAgent,
    options.authMode ?? merged.security?.authBootstrapMode,
    {}
  );
  plugin.security.authBootstrapMode = resolvePreferredAuthMode(options.authMode ?? merged.security?.authBootstrapMode, plugin.acp.defaultAgent);
  plugin.security.commandLoggerEnabled = resolveBoolean(plugin.security.commandLoggerEnabled, true);
  plugin.security.toolDeny = uniqueStrings(plugin.security.toolDeny ?? ["process"]);

  return plugin;
}
