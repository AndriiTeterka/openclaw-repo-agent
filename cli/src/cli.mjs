import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  deepMerge,
  ensureDir,
  fileExists,
  readJsonFile,
  readTextFile,
  resolveBoolean,
  safeRunCommand,
  writeJsonFile,
  writeTextFile
} from "../../runtime/shared.mjs";
import {
  normalizeAuthMode,
  normalizeProjectManifest,
  validateProjectManifest
} from "../../runtime/manifest-contract.mjs";
import {
  BUILTIN_PROFILES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_NPM_PACKAGE_NAME,
  DEFAULT_OPENCLAW_IMAGE,
  DEFAULT_RUNTIME_IMAGE_REPOSITORY,
  PRODUCT_NAME,
  PRODUCT_VERSION,
  listBuiltinProfileNames
} from "./builtin-profiles.mjs";
import {
  defaultInstructionsTemplate,
  defaultKnowledgeTemplate,
  defaultLocalEnvExample,
  renderDockerMcpConfigTemplate,
  renderComposeTemplate
} from "./templates.mjs";
import {
  buildDockerMcpSecretPlan,
  DEFAULT_DOCKER_MCP_SERVERS,
  DOCKER_MCP_REQUIRED_RECOVERY,
  hashDockerMcpSecretValue,
  summarizeDockerMcpSecretPlan
} from "./docker-mcp.mjs";
import { detectRepository } from "./repository-detection.mjs";
import { buildLocalRuntimeEnvOverrides, shouldAutoUseLocalBuild } from "./runtime-image.mjs";

const ARRAY_FLAGS = new Set([
  "instruction-file",
  "knowledge-file",
  "verification-command",
  "allow-user",
  "group-allow-user",
  "acp-allowed-agent"
]);

const BOOLEAN_FLAGS = new Set([
  "yes",
  "non-interactive",
  "json",
  "fix",
  "verify",
  "topic-acp",
  "check-updates",
  "use-local-build",
  "force"
]);

const STRING_FLAGS = new Set([
  "repo-root",
  "product-root",
  "profile",
  "project-name",
  "tooling-profile",
  "runtime-profile",
  "queue-profile",
  "deployment-profile",
  "auth-mode",
  "agent-default-model",
  "acp-default-agent",
  "approve",
  "switch-dm-policy",
  "switch-group-policy",
  "dm-policy",
  "group-policy",
  "reply-to-mode",
  "stream-mode",
  "telegram-proxy",
  "auto-select-family",
  "telegram-bot-token",
  "openai-api-key",
  "target-auth-path"
]);

const DEFAULT_STATE_COMPOSE_FILE = "docker-compose.openclaw.yml";
const DEFAULT_STATE_MANIFEST_FILE = "project-manifest.json";
const DEFAULT_STATE_ENV_FILE = "runtime.env";
const DEFAULT_STATE_DOCKER_MCP_CONFIG_FILE = "docker-mcp.config.yaml";
const DEFAULT_STATE_DOCKER_MCP_SECRETS_FILE = "docker-mcp.secrets.json";
const DEFAULT_LOCAL_ENV_FILE = "local.env";
const DEFAULT_LOCAL_ENV_EXAMPLE_FILE = "local.env.example";
const DEFAULT_PLUGIN_FILE = "plugin.json";
const DEFAULT_INSTRUCTIONS_FILE = "instructions.md";
const DEFAULT_KNOWLEDGE_FILE = "knowledge.md";
const LOCAL_ENV_HEADER = "Local-only OpenClaw configuration. Keep this file out of git.";

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeTelegramPrincipal(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "*" || /^tg:/i.test(raw) || /^telegram:/i.test(raw) || raw.startsWith("@")) return raw;
  if (/^-?\d+$/.test(raw)) return `tg:${raw}`;
  return raw;
}

function normalizePrincipalArray(values) {
  return uniqueStrings(values.map((value) => normalizeTelegramPrincipal(value)));
}

function normalizeAllowedAgents(defaultAgent, allowedAgents = []) {
  return uniqueStrings([
    ...allowedAgents,
    ...(defaultAgent ? [defaultAgent] : [])
  ]);
}

function parseFlexibleArray(rawValue, fallback = []) {
  if (rawValue == null || rawValue === "") return [...fallback];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) throw new Error("expected array");
    return uniqueStrings(parsed);
  } catch {
    return uniqueStrings(String(rawValue).split(/[\n,]+/g));
  }
}

function parseBooleanString(rawValue, fallback) {
  return resolveBoolean(rawValue, fallback);
}

function toDockerPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function defaultDeploymentProfile() {
  return process.platform === "win32" ? "wsl2" : "docker-local";
}

function defaultRuntimeImage() {
  return `${DEFAULT_RUNTIME_IMAGE_REPOSITORY}:${PRODUCT_VERSION}-polyglot`;
}

function isCodexAgent(value) {
  return String(value ?? "").trim().toLowerCase() === "codex";
}

function defaultAgentModelForAcpAgent(agentId) {
  return isCodexAgent(agentId) ? DEFAULT_CODEX_MODEL : "";
}

function normalizeDefaultAgentModel(value, acpDefaultAgent) {
  const normalized = String(value ?? "").trim();
  return normalized || defaultAgentModelForAcpAgent(acpDefaultAgent);
}

function resolvePreferredAuthMode(rawAuthMode, acpDefaultAgent) {
  const normalized = String(rawAuthMode ?? "").trim();
  if (normalized) return normalizeAuthMode(normalized);
  return isCodexAgent(acpDefaultAgent) ? "codex" : "external";
}

function shouldUpgradeLegacyCodexBootstrap({ cliAuthMode, localEnvAuthMode, pluginAuthMode, acpDefaultAgent }) {
  if (!isCodexAgent(acpDefaultAgent)) return false;
  if (String(cliAuthMode ?? "").trim()) return false;
  if (String(localEnvAuthMode ?? "").trim()) return false;
  return normalizeAuthMode(pluginAuthMode) === "external";
}

async function detectDefaultCodexAuthPath() {
  const candidates = uniqueStrings([
    process.env.CODEX_HOME,
    path.join(os.homedir(), ".codex")
  ]);

  for (const candidate of candidates) {
    const authFile = path.join(candidate, "auth.json");
    if (await fileExists(authFile)) return toDockerPath(path.resolve(candidate));
  }

  return "";
}

function compareVersions(left, right) {
  const leftParts = String(left ?? "").replace(/^v/i, "").split(".").map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = String(right ?? "").replace(/^v/i, "").split(".").map((value) => Number.parseInt(value, 10) || 0);
  const size = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < size; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function randomToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function isBooleanLike(value) {
  return ["true", "false", "yes", "no", "1", "0", "on", "off"].includes(String(value ?? "").toLowerCase());
}

function readOptionValue(argv, index, key, inlineValue) {
  if (inlineValue != null) {
    if (inlineValue === "") throw new Error(`Missing value for --${key}`);
    return {
      value: inlineValue,
      nextIndex: index
    };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("--") || next === "-h" || next === "-v") {
    throw new Error(`Missing value for --${key}`);
  }

  return {
    value: next,
    nextIndex: index + 1
  };
}

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      options.version = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    const separatorIndex = option.indexOf("=");
    const key = separatorIndex >= 0 ? option.slice(0, separatorIndex) : option;
    const inlineValue = separatorIndex >= 0 ? option.slice(separatorIndex + 1) : null;
    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue != null) {
        options[toCamelCase(key)] = parseBooleanString(inlineValue, true);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && next !== "-h" && next !== "-v" && isBooleanLike(next)) {
        options[toCamelCase(key)] = parseBooleanString(next, true);
        index += 1;
      } else {
        options[toCamelCase(key)] = true;
      }
      continue;
    }

    if (ARRAY_FLAGS.has(key)) {
      const { value, nextIndex } = readOptionValue(argv, index, key, inlineValue);
      const optionKey = toCamelCase(key);
      if (!Array.isArray(options[optionKey])) options[optionKey] = [];
      options[optionKey].push(value);
      index = nextIndex;
      continue;
    }

    if (STRING_FLAGS.has(key)) {
      const { value, nextIndex } = readOptionValue(argv, index, key, inlineValue);
      options[toCamelCase(key)] = value;
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option: --${key}`);
  }

  return {
    positionals,
    options
  };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function resolveProductRoot(explicitProductRoot) {
  if (explicitProductRoot) return path.resolve(explicitProductRoot);
  if (process.pkg) return path.dirname(process.execPath);
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

function resolvePaths(repoRoot) {
  const openclawDir = path.join(repoRoot, ".openclaw");
  const stateDir = path.join(openclawDir, "state");
  return {
    openclawDir,
    stateDir,
    pluginFile: path.join(openclawDir, DEFAULT_PLUGIN_FILE),
    instructionsFile: path.join(openclawDir, DEFAULT_INSTRUCTIONS_FILE),
    knowledgeFile: path.join(openclawDir, DEFAULT_KNOWLEDGE_FILE),
    localEnvFile: path.join(openclawDir, DEFAULT_LOCAL_ENV_FILE),
    localEnvExampleFile: path.join(openclawDir, DEFAULT_LOCAL_ENV_EXAMPLE_FILE),
    composeFile: path.join(stateDir, DEFAULT_STATE_COMPOSE_FILE),
    manifestFile: path.join(stateDir, DEFAULT_STATE_MANIFEST_FILE),
    runtimeEnvFile: path.join(stateDir, DEFAULT_STATE_ENV_FILE),
    dockerMcpConfigFile: path.join(stateDir, DEFAULT_STATE_DOCKER_MCP_CONFIG_FILE),
    dockerMcpSecretsFile: path.join(stateDir, DEFAULT_STATE_DOCKER_MCP_SECRETS_FILE),
    emptyAuthDir: path.join(stateDir, "auth-empty")
  };
}

async function readEnvFile(filePath) {
  if (!(await fileExists(filePath))) return {};
  const raw = await readTextFile(filePath, "");
  const result = {};
  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    result[key] = value;
  }
  return result;
}

async function writeEnvFile(filePath, values, header = "") {
  const lines = [];
  if (header) {
    for (const line of header.trimEnd().split(/\r?\n/g)) lines.push(`# ${line}`);
    lines.push("");
  }
  for (const [key, value] of Object.entries(values)) {
    lines.push(`${key}=${value == null ? "" : String(value)}`);
  }
  await writeTextFile(filePath, `${lines.join("\n")}\n`);
}

async function ensureGitignoreEntries(repoRoot) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const requiredEntries = [".openclaw/local.env", ".openclaw/state/"];
  const current = await readTextFile(gitignorePath, "");
  const next = [...requiredEntries.filter((entry) => !current.includes(entry))];
  if (next.length === 0) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await writeTextFile(gitignorePath, `${current}${separator}${next.join("\n")}\n`);
  return true;
}

function cloneProfile(profileName) {
  return deepMerge(BUILTIN_PROFILES[profileName] ?? BUILTIN_PROFILES.custom);
}

function normalizePluginConfig(rawConfig, repoRoot, detection, options = {}) {
  const requestedProfile = String(options.profile ?? rawConfig?.profile ?? detection.profile ?? "custom").trim();
  const profileName = BUILTIN_PROFILES[requestedProfile] ? requestedProfile : "custom";
  const profileDefaults = cloneProfile(profileName);
  const merged = deepMerge(profileDefaults, rawConfig ?? {});

  const instructionFiles = options.instructionFile?.length
    ? options.instructionFile
    : Array.isArray(rawConfig?.instructionFiles) && rawConfig.instructionFiles.length > 0
      ? rawConfig.instructionFiles
      : [...detection.instructionCandidates, ...profileDefaults.instructionFiles];

  const knowledgeFiles = options.knowledgeFile?.length
    ? options.knowledgeFile
    : Array.isArray(rawConfig?.knowledgeFiles) && rawConfig.knowledgeFiles.length > 0
      ? rawConfig.knowledgeFiles
      : [...profileDefaults.knowledgeFiles];

  const verificationCommands = options.verificationCommand?.length
    ? options.verificationCommand
    : Array.isArray(rawConfig?.verificationCommands) && rawConfig.verificationCommands.length > 0
      ? rawConfig.verificationCommands
      : [...detection.verificationCommands, ...profileDefaults.verificationCommands];

  const detectedProjectName = detection.projectName || path.basename(repoRoot);
  const projectName = String(options.projectName ?? merged.projectName ?? detectedProjectName).trim() || detectedProjectName;
  const deploymentProfile = String(options.deploymentProfile ?? merged.deploymentProfile ?? defaultDeploymentProfile()).trim() || defaultDeploymentProfile();
  const runtimeProfile = String(options.runtimeProfile ?? merged.runtimeProfile ?? "stable-chat").trim() || "stable-chat";
  const queueProfile = String(options.queueProfile ?? merged.queueProfile ?? runtimeProfile).trim() || runtimeProfile;
  const toolingProfile = String(options.toolingProfile ?? rawConfig?.toolingProfile ?? detection.toolingProfile ?? merged.toolingProfile ?? "none").trim() || "none";
  const requestedAllowedAgents = options.acpAllowedAgent?.length
    ? options.acpAllowedAgent
    : Array.isArray(merged.acp?.allowedAgents)
      ? merged.acp.allowedAgents
      : [];

  const plugin = {
    version: 1,
    profile: profileName,
    projectName,
    deploymentProfile,
    toolingProfile,
    runtimeProfile,
    queueProfile,
    instructionFiles: uniqueStrings(instructionFiles),
    knowledgeFiles: uniqueStrings(knowledgeFiles.length > 0 ? knowledgeFiles : [".openclaw/knowledge.md"]),
    verificationCommands: uniqueStrings(verificationCommands),
    agent: deepMerge(merged.agent ?? {}),
    telegram: deepMerge(merged.telegram ?? {}),
    acp: deepMerge(merged.acp ?? {}),
    security: deepMerge(merged.security ?? {})
  };

  plugin.agent.id = String(plugin.agent.id ?? profileDefaults.agent.id ?? "workspace").trim() || "workspace";
  plugin.agent.name = String(plugin.agent.name ?? `${projectName} Workspace`).trim() || `${projectName} Workspace`;
  plugin.agent.maxConcurrent = Number.isInteger(plugin.agent.maxConcurrent) && plugin.agent.maxConcurrent > 0 ? plugin.agent.maxConcurrent : 4;
  plugin.agent.skipBootstrap = resolveBoolean(plugin.agent.skipBootstrap, true);
  plugin.agent.verboseDefault = String(plugin.agent.verboseDefault ?? "off").trim() || "off";
  plugin.agent.blockStreamingDefault = String(plugin.agent.blockStreamingDefault ?? "off").trim() || "off";
  plugin.agent.blockStreamingBreak = String(plugin.agent.blockStreamingBreak ?? "text_end").trim() || "text_end";
  plugin.agent.typingMode = String(plugin.agent.typingMode ?? "never").trim() || "never";
  plugin.agent.typingIntervalSeconds = Number.isInteger(plugin.agent.typingIntervalSeconds) ? plugin.agent.typingIntervalSeconds : 12;
  plugin.agent.tools = {
    deny: uniqueStrings(plugin.agent.tools?.deny ?? plugin.security.toolDeny ?? ["process"])
  };

  plugin.telegram.dmPolicy = String(options.dmPolicy ?? plugin.telegram.dmPolicy ?? "pairing").trim() || "pairing";
  plugin.telegram.groupPolicy = String(options.groupPolicy ?? plugin.telegram.groupPolicy ?? "disabled").trim() || "disabled";
  plugin.telegram.streamMode = String(options.streamMode ?? plugin.telegram.streamMode ?? "partial").trim() || "partial";
  plugin.telegram.blockStreaming = resolveBoolean(plugin.telegram.blockStreaming, false);
  plugin.telegram.replyToMode = String(options.replyToMode ?? plugin.telegram.replyToMode ?? "first").trim() || "first";
  plugin.telegram.reactionLevel = String(plugin.telegram.reactionLevel ?? "minimal").trim() || "minimal";
  plugin.telegram.configWrites = resolveBoolean(plugin.telegram.configWrites, false);
  plugin.telegram.groups = deepMerge(plugin.telegram.groups ?? { "*": { requireMention: true } });
  plugin.telegram.threadBindings = {
    spawnAcpSessions: resolveBoolean(plugin.telegram.threadBindings?.spawnAcpSessions, false)
  };
  plugin.telegram.network = {
    autoSelectFamily: resolveBoolean(plugin.telegram.network?.autoSelectFamily, true)
  };
  delete plugin.telegram.allowFrom;
  delete plugin.telegram.groupAllowFrom;
  delete plugin.telegram.proxy;

  plugin.acp.defaultAgent = String(options.acpDefaultAgent ?? plugin.acp.defaultAgent ?? "").trim();
  plugin.acp.allowedAgents = normalizeAllowedAgents(plugin.acp.defaultAgent, requestedAllowedAgents);
  plugin.acp.preferredMode = String(plugin.acp.preferredMode ?? "oneshot").trim() || "oneshot";
  plugin.acp.maxConcurrentSessions = Number.isInteger(plugin.acp.maxConcurrentSessions) ? plugin.acp.maxConcurrentSessions : 4;
  plugin.acp.ttlMinutes = Number.isInteger(plugin.acp.ttlMinutes) ? plugin.acp.ttlMinutes : 120;
  plugin.acp.stream = {
    coalesceIdleMs: Number.isInteger(plugin.acp.stream?.coalesceIdleMs) ? plugin.acp.stream.coalesceIdleMs : 300,
    maxChunkChars: Number.isInteger(plugin.acp.stream?.maxChunkChars) ? plugin.acp.stream.maxChunkChars : 1200
  };

  plugin.agent.defaultModel = normalizeDefaultAgentModel(
    options.agentDefaultModel ?? plugin.agent.defaultModel,
    plugin.acp.defaultAgent
  );
  plugin.security.authBootstrapMode = resolvePreferredAuthMode(options.authMode ?? merged.security?.authBootstrapMode, plugin.acp.defaultAgent);
  plugin.security.commandLoggerEnabled = resolveBoolean(plugin.security.commandLoggerEnabled, true);
  plugin.security.toolDeny = uniqueStrings(plugin.security.toolDeny ?? ["process"]);

  if (options.topicAcp) {
    plugin.runtimeProfile = "topic-bound-acp";
    plugin.queueProfile = "topic-bound-acp";
    plugin.telegram.groupPolicy = "allowlist";
    plugin.telegram.threadBindings.spawnAcpSessions = true;
  }

  return plugin;
}

function localOverrideValue(optionsValue, envValue, fallback) {
  if (optionsValue != null && optionsValue !== "") return optionsValue;
  if (envValue != null && envValue !== "") return envValue;
  return fallback;
}

function buildEffectiveManifest(plugin, repoRoot, localEnv, options = {}) {
  const runtimeProfile = localOverrideValue(options.runtimeProfile, localEnv.OPENCLAW_RUNTIME_PROFILE, plugin.runtimeProfile);
  const queueProfile = localOverrideValue(options.queueProfile, localEnv.OPENCLAW_QUEUE_PROFILE, plugin.queueProfile || runtimeProfile);
  const toolingProfile = localOverrideValue(options.toolingProfile, localEnv.OPENCLAW_TOOLING_PROFILE, plugin.toolingProfile);
  const deploymentProfile = localOverrideValue(options.deploymentProfile, localEnv.OPENCLAW_DEPLOYMENT_PROFILE, plugin.deploymentProfile || defaultDeploymentProfile());
  const topicAcp = resolveBoolean(localOverrideValue(options.topicAcp, localEnv.OPENCLAW_TOPIC_ACP, false), false);
  const acpDefaultAgent = localOverrideValue(options.acpDefaultAgent, localEnv.OPENCLAW_ACP_DEFAULT_AGENT, plugin.acp.defaultAgent);
  const authMode = shouldUpgradeLegacyCodexBootstrap({
    cliAuthMode: options.authMode,
    localEnvAuthMode: localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    pluginAuthMode: plugin.security.authBootstrapMode,
    acpDefaultAgent
  })
    ? "codex"
    : normalizeAuthMode(localOverrideValue(options.authMode, localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE, plugin.security.authBootstrapMode));
  const acpAllowedAgents = options.acpAllowedAgent?.length
    ? uniqueStrings(options.acpAllowedAgent)
    : parseFlexibleArray(localEnv.OPENCLAW_ACP_ALLOWED_AGENTS, plugin.acp.allowedAgents);

  const manifestSeed = deepMerge(plugin, {
    projectName: localOverrideValue(options.projectName, localEnv.OPENCLAW_PROJECT_NAME, plugin.projectName),
    repoPath: repoRoot,
    deploymentProfile,
    toolingProfile,
    runtimeProfile,
    queueProfile,
    instructionFiles: options.instructionFile?.length ? options.instructionFile : plugin.instructionFiles,
    knowledgeFiles: options.knowledgeFile?.length ? options.knowledgeFile : plugin.knowledgeFiles,
    verificationCommands: options.verificationCommand?.length ? options.verificationCommand : plugin.verificationCommands,
    agent: {
      defaultModel: normalizeDefaultAgentModel(
        localOverrideValue(options.agentDefaultModel, localEnv.OPENCLAW_AGENT_DEFAULT_MODEL, plugin.agent.defaultModel),
        acpDefaultAgent
      )
    },
    telegram: {
      dmPolicy: localOverrideValue(options.dmPolicy, localEnv.OPENCLAW_TELEGRAM_DM_POLICY, plugin.telegram.dmPolicy),
      groupPolicy: localOverrideValue(options.groupPolicy, localEnv.OPENCLAW_TELEGRAM_GROUP_POLICY, plugin.telegram.groupPolicy),
      streamMode: localOverrideValue(options.streamMode, localEnv.OPENCLAW_TELEGRAM_STREAM_MODE, plugin.telegram.streamMode),
      blockStreaming: parseBooleanString(localOverrideValue(null, localEnv.OPENCLAW_TELEGRAM_BLOCK_STREAMING, plugin.telegram.blockStreaming), plugin.telegram.blockStreaming),
      replyToMode: localOverrideValue(options.replyToMode, localEnv.OPENCLAW_TELEGRAM_REPLY_TO_MODE, plugin.telegram.replyToMode),
      reactionLevel: localOverrideValue(null, localEnv.OPENCLAW_TELEGRAM_REACTION_LEVEL, plugin.telegram.reactionLevel),
      proxy: localOverrideValue(options.telegramProxy, localEnv.OPENCLAW_TELEGRAM_PROXY, ""),
      allowFrom: normalizePrincipalArray(parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, [])),
      groupAllowFrom: normalizePrincipalArray(parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, [])),
      network: {
        autoSelectFamily: parseBooleanString(localOverrideValue(options.autoSelectFamily, localEnv.OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY, plugin.telegram.network.autoSelectFamily), true)
      },
      threadBindings: {
        spawnAcpSessions: topicAcp || resolveBoolean(plugin.telegram.threadBindings?.spawnAcpSessions, false)
      }
    },
    acp: {
      defaultAgent: acpDefaultAgent,
      allowedAgents: normalizeAllowedAgents(acpDefaultAgent, acpAllowedAgents)
    },
    security: {
      authBootstrapMode: authMode
    }
  });

  if (topicAcp) {
    manifestSeed.runtimeProfile = "topic-bound-acp";
    manifestSeed.queueProfile = "topic-bound-acp";
    manifestSeed.telegram.groupPolicy = "allowlist";
    manifestSeed.telegram.threadBindings.spawnAcpSessions = true;
  }

  return normalizeProjectManifest(manifestSeed, {
    hostPlatform: process.platform
  });
}

function buildLocalEnvTemplateValues(plugin, existingLocalEnv, options, useLocalBuild, defaultTargetAuthPath = "") {
  const defaults = {
    OPENCLAW_STACK_IMAGE: useLocalBuild ? "openclaw-repo-agent-runtime:local" : defaultRuntimeImage(),
    OPENCLAW_IMAGE: DEFAULT_OPENCLAW_IMAGE,
    OPENCLAW_AGENT_NPM_PACKAGES: "",
    OPENCLAW_AGENT_INSTALL_COMMAND: "",
    OPENCLAW_TOOLING_PROFILE: "",
    OPENCLAW_TOOLING_INSTALL_COMMAND: "",
    OPENCLAW_DEPLOYMENT_PROFILE: "",
    OPENCLAW_RUNTIME_PROFILE: "",
    OPENCLAW_QUEUE_PROFILE: "",
    OPENCLAW_BOOTSTRAP_AUTH_MODE: "",
    OPENCLAW_AGENT_DEFAULT_MODEL: "",
    OPENCLAW_ACP_DEFAULT_AGENT: "",
    OPENCLAW_ACP_ALLOWED_AGENTS: "",
    OPENCLAW_TELEGRAM_DM_POLICY: "",
    OPENCLAW_TELEGRAM_GROUP_POLICY: "",
    OPENCLAW_TELEGRAM_STREAM_MODE: "",
    OPENCLAW_TELEGRAM_BLOCK_STREAMING: "",
    OPENCLAW_TELEGRAM_REPLY_TO_MODE: "",
    OPENCLAW_TELEGRAM_REACTION_LEVEL: "",
    OPENCLAW_TELEGRAM_ALLOW_FROM: "[]",
    OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: "[]",
    OPENCLAW_TELEGRAM_PROXY: "",
    OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY: "true",
    OPENCLAW_TOPIC_ACP: "",
    OPENCLAW_USE_LOCAL_BUILD: useLocalBuild ? "true" : "false",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_BIND: "lan",
    OPENCLAW_GATEWAY_TOKEN: randomToken(),
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: "",
    TELEGRAM_BOT_TOKEN: "replace-with-your-botfather-token",
    OPENAI_API_KEY: "",
    GITHUB_PERSONAL_ACCESS_TOKEN: "",
    TARGET_AUTH_PATH: ""
  };

  const merged = {
    ...defaults,
    ...existingLocalEnv,
    ...(options.useLocalBuild != null ? { OPENCLAW_USE_LOCAL_BUILD: options.useLocalBuild ? "true" : "false" } : {}),
    ...(options.telegramBotToken ? { TELEGRAM_BOT_TOKEN: options.telegramBotToken } : {}),
    ...(options.openaiApiKey ? { OPENAI_API_KEY: options.openaiApiKey } : {}),
    ...(options.targetAuthPath != null ? { TARGET_AUTH_PATH: toDockerPath(path.resolve(options.targetAuthPath)) } : {}),
    ...(options.acpAllowedAgent?.length ? { OPENCLAW_ACP_ALLOWED_AGENTS: JSON.stringify(uniqueStrings(options.acpAllowedAgent)) } : {}),
    ...(options.allowUser?.length ? { OPENCLAW_TELEGRAM_ALLOW_FROM: JSON.stringify(normalizePrincipalArray(options.allowUser)) } : {}),
    ...(options.groupAllowUser?.length ? { OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: JSON.stringify(normalizePrincipalArray(options.groupAllowUser)) } : {})
  };

  if (!String(merged.TARGET_AUTH_PATH ?? "").trim() && defaultTargetAuthPath) {
    merged.TARGET_AUTH_PATH = defaultTargetAuthPath;
  }

  if (plugin.security.authBootstrapMode !== "codex" && !options.openaiApiKey && options.targetAuthPath == null) {
    merged.OPENAI_API_KEY = merged.OPENAI_API_KEY || "";
    merged.TARGET_AUTH_PATH = merged.TARGET_AUTH_PATH || "";
  }

  return merged;
}

function buildRuntimeEnv(context, manifest, localEnv, useLocalBuild, detectedCodexAuthPath = "") {
  const gatewayPort = localEnv.OPENCLAW_GATEWAY_PORT || "18789";
  const controlUiOrigins = localEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS
    || JSON.stringify([`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`]);
  const effectiveTargetAuthPath = String(localEnv.TARGET_AUTH_PATH ?? "").trim() || detectedCodexAuthPath;
  const targetAuthPath = effectiveTargetAuthPath
    ? path.resolve(effectiveTargetAuthPath.replace(/\//g, path.sep))
    : context.paths.emptyAuthDir;

  return {
    OPENCLAW_PRODUCT_ROOT: toDockerPath(context.productRoot),
    OPENCLAW_STACK_IMAGE: localEnv.OPENCLAW_STACK_IMAGE || defaultRuntimeImage(),
    OPENCLAW_IMAGE: localEnv.OPENCLAW_IMAGE || DEFAULT_OPENCLAW_IMAGE,
    OPENCLAW_AGENT_NPM_PACKAGES: localEnv.OPENCLAW_AGENT_NPM_PACKAGES || "",
    OPENCLAW_AGENT_INSTALL_COMMAND: localEnv.OPENCLAW_AGENT_INSTALL_COMMAND || "",
    OPENCLAW_TOOLING_INSTALL_COMMAND: localEnv.OPENCLAW_TOOLING_INSTALL_COMMAND || "",
    OPENCLAW_EFFECTIVE_TOOLING_PROFILE: manifest.toolingProfile,
    OPENCLAW_GATEWAY_PORT: gatewayPort,
    OPENCLAW_GATEWAY_BIND: localEnv.OPENCLAW_GATEWAY_BIND || "lan",
    OPENCLAW_GATEWAY_TOKEN: localEnv.OPENCLAW_GATEWAY_TOKEN || randomToken(),
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: controlUiOrigins,
    TELEGRAM_BOT_TOKEN: localEnv.TELEGRAM_BOT_TOKEN || "",
    OPENAI_API_KEY: localEnv.OPENAI_API_KEY || "",
    OPENCLAW_HOST_PLATFORM: process.platform,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: manifest.security.authBootstrapMode,
    OPENCLAW_AGENT_DEFAULT_MODEL: manifest.agent.defaultModel || "",
    OPENCLAW_AGENT_VERBOSE_DEFAULT: manifest.agent.verboseDefault,
    OPENCLAW_AGENT_TOOLS_DENY: JSON.stringify(manifest.agent.tools.deny),
    OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT: manifest.agent.blockStreamingDefault,
    OPENCLAW_AGENT_BLOCK_STREAMING_BREAK: manifest.agent.blockStreamingBreak,
    OPENCLAW_QUEUE_MODE: manifest.queue.mode,
    OPENCLAW_QUEUE_DEBOUNCE_MS: String(manifest.queue.debounceMs),
    OPENCLAW_QUEUE_CAP: String(manifest.queue.cap),
    OPENCLAW_INBOUND_DEBOUNCE_MS: String(manifest.queue.inboundDebounceMs),
    OPENCLAW_AGENTS_MAX_CONCURRENT: String(manifest.agent.maxConcurrent),
    OPENCLAW_EXEC_TIMEOUT_SEC: String(manifest.tools.exec.timeoutSec),
    OPENCLAW_TELEGRAM_ENABLED: String(Boolean(manifest.telegram.enabled)),
    OPENCLAW_TELEGRAM_DM_POLICY: manifest.telegram.dmPolicy,
    OPENCLAW_TELEGRAM_GROUP_POLICY: manifest.telegram.groupPolicy,
    OPENCLAW_TELEGRAM_STREAM_MODE: manifest.telegram.streamMode,
    OPENCLAW_TELEGRAM_STREAMING: manifest.telegram.streamMode,
    OPENCLAW_TELEGRAM_BLOCK_STREAMING: String(Boolean(manifest.telegram.blockStreaming)),
    OPENCLAW_TELEGRAM_REPLY_TO_MODE: manifest.telegram.replyToMode,
    OPENCLAW_TELEGRAM_REACTION_LEVEL: manifest.telegram.reactionLevel,
    OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY: String(Boolean(manifest.telegram.network.autoSelectFamily)),
    OPENCLAW_TELEGRAM_PROXY: manifest.telegram.proxy || "",
    OPENCLAW_TELEGRAM_CONFIG_WRITES: String(Boolean(manifest.telegram.configWrites)),
    OPENCLAW_ACP_DEFAULT_AGENT: manifest.acp.defaultAgent,
    OPENCLAW_ACP_ALLOWED_AGENTS: JSON.stringify(manifest.acp.allowedAgents),
    OPENCLAW_ACP_PREFERRED_MODE: manifest.acp.preferredMode,
    OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS: String(manifest.acp.maxConcurrentSessions),
    OPENCLAW_ACP_TTL_MINUTES: String(manifest.acp.ttlMinutes),
    OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS: String(manifest.acp.stream.coalesceIdleMs),
    OPENCLAW_ACP_STREAM_MAX_CHARS: String(manifest.acp.stream.maxChunkChars),
    OPENCLAW_ACPX_PERMISSION_MODE: "approve-all",
    OPENCLAW_ACPX_NON_INTERACTIVE_PERMISSIONS: "fail",
    OPENCLAW_COMMAND_LOGGER_ENABLED: String(Boolean(manifest.security.commandLoggerEnabled)),
    TARGET_REPO_PATH: toDockerPath(context.repoRoot),
    GENERATED_MANIFEST_PATH: toDockerPath(context.paths.manifestFile),
    TARGET_AUTH_PATH: toDockerPath(targetAuthPath),
    OPENCLAW_USE_LOCAL_BUILD: useLocalBuild ? "true" : "false"
  };
}

async function ensureDockerMcpConfig(context) {
  await ensureDir(context.paths.stateDir);
  const config = renderDockerMcpConfigTemplate(toDockerPath(path.resolve(context.repoRoot)));
  await writeTextFile(context.paths.dockerMcpConfigFile, config);
  return context.paths.dockerMcpConfigFile;
}

async function runLiveCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
  });
}

async function dockerCompose(context, args, options = {}) {
  const commandArgs = ["compose", "-f", context.paths.composeFile, "--env-file", context.paths.runtimeEnvFile, ...args];
  if (options.capture) return await safeRunCommand("docker", commandArgs, { cwd: context.repoRoot });
  const code = await runLiveCommand("docker", commandArgs, { cwd: context.repoRoot });
  if (code !== 0) throw new Error(`docker compose ${args.join(" ")} failed with exit code ${code}`);
  return { code, stdout: "", stderr: "" };
}

async function openclawGatewayCommand(context, args, options = {}) {
  return await dockerCompose(context, ["exec", "-T", "openclaw-gateway", "openclaw", ...args], options);
}

async function gatewayRunning(context) {
  try {
    const result = await dockerCompose(context, ["ps", "-q", "openclaw-gateway"], { capture: true });
    return result.code === 0 && Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}

async function rerenderIfRunning(context) {
  if (!(await gatewayRunning(context))) return;
  await dockerCompose(context, ["exec", "openclaw-gateway", "node", "/opt/openclaw/render-openclaw-config.mjs"]);
}

async function prepareState(context, options = {}) {
  const pluginRaw = await readJsonFile(context.paths.pluginFile, null);
  if (!pluginRaw) {
    throw new Error(`Missing ${context.paths.pluginFile}. Run ${PRODUCT_NAME} init first.`);
  }

  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  const localEnv = await readEnvFile(context.paths.localEnvFile);
  const detectedCodexAuthPath = await detectDefaultCodexAuthPath();
  const useLocalBuild = resolveBoolean(localOverrideValue(options.useLocalBuild, localEnv.OPENCLAW_USE_LOCAL_BUILD, false), false);
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnv, options);
  const validationErrors = validateProjectManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Plugin config is invalid: ${validationErrors.join("; ")}`);
  }

  await ensureDir(context.paths.stateDir);
  await ensureDir(context.paths.emptyAuthDir);
  await ensureDockerMcpConfig(context);
  await writeJsonFile(context.paths.manifestFile, manifest);
  await writeTextFile(context.paths.composeFile, renderComposeTemplate({ useLocalBuild }));
  const runtimeEnv = buildRuntimeEnv(context, manifest, localEnv, useLocalBuild, detectedCodexAuthPath);
  await writeEnvFile(context.paths.runtimeEnvFile, runtimeEnv);

  return {
    plugin,
    localEnv,
    manifest,
    runtimeEnv,
    useLocalBuild,
    detectedCodexAuthPath
  };
}

async function dockerMcpCapture(args, cwd = process.cwd()) {
  return await safeRunCommand("docker", ["mcp", ...args], { cwd });
}

async function ensureDockerMcpAvailable(cwd) {
  const result = await dockerMcpCapture(["--help"], cwd);
  if (result.code !== 0) {
    throw new Error("Docker MCP Toolkit is required. Install or update Docker Desktop / Docker MCP Toolkit and retry.");
  }
}

function buildMcpStatusPayload(repoConfigPath, configPathResult, clientListResult) {
  const activeConfigPath = configPathResult.code === 0 ? configPathResult.stdout.trim() : "";
  let codexConnected = false;
  let codexInstalled = false;

  if (clientListResult.code === 0) {
    try {
      const payload = JSON.parse(clientListResult.stdout);
      const codex = payload.codex;
      codexConnected = Boolean(codex?.dockerMCPCatalogConnected);
      codexInstalled = Boolean(codex?.isInstalled);
    } catch {}
  }

  return {
    repoConfigPath,
    activeConfigPath,
    usesRepoConfig: Boolean(activeConfigPath) && path.resolve(activeConfigPath) === path.resolve(repoConfigPath),
    codexConnected,
    codexInstalled
  };
}

async function readDockerMcpStatus(context, repoConfigPath = context.paths.dockerMcpConfigFile) {
  const configPathResult = await dockerMcpCapture(["config", "read"], context.repoRoot);
  const clientListResult = await dockerMcpCapture(["client", "ls", "--global", "--json"], context.repoRoot);
  return buildMcpStatusPayload(repoConfigPath, configPathResult, clientListResult);
}

async function readDockerMcpSecretEntries(context) {
  const secretListResult = await dockerMcpCapture(["secret", "ls", "--json"], context.repoRoot);
  if (secretListResult.code !== 0) {
    throw new Error(secretListResult.stderr.trim() || secretListResult.stdout.trim() || "Failed to read Docker MCP secrets.");
  }

  try {
    const payload = JSON.parse(secretListResult.stdout || "[]");
    return Array.isArray(payload) ? payload : [];
  } catch {
    throw new Error("Failed to parse Docker MCP secret state.");
  }
}

async function readDockerMcpSecretStatus(context, localEnv) {
  const secretEntries = await readDockerMcpSecretEntries(context);
  const plan = buildDockerMcpSecretPlan(context.repoRoot, localEnv, secretEntries);
  return {
    ok: true,
    plan,
    ...summarizeDockerMcpSecretPlan(plan)
  };
}

function emptyDockerMcpSecretStatus() {
  return {
    configuredCount: 0,
    syncedConfiguredCount: 0,
    missingConfiguredSecrets: [],
    managedSecretNames: [],
    configuredSecretNames: []
  };
}

async function ensureRuntimeImageReady(context, state, options = {}) {
  let nextState = state;
  let autoSwitchedToLocalBuild = false;

  if (nextState.useLocalBuild) {
    return { state: nextState, autoSwitchedToLocalBuild };
  }

  const defaultStackImage = defaultRuntimeImage();
  const pull = await dockerCompose(context, ["pull", "openclaw-gateway"], { capture: true });
  const pullOutput = [pull.stderr, pull.stdout].filter(Boolean).join("\n");
  if (pull.code === 0) {
    return { state: nextState, autoSwitchedToLocalBuild };
  }

  if (!shouldAutoUseLocalBuild({
    useLocalBuild: nextState.useLocalBuild,
    stackImage: nextState.localEnv.OPENCLAW_STACK_IMAGE || defaultStackImage,
    defaultStackImage,
    errorOutput: pullOutput
  })) {
    throw new Error(pullOutput || "Failed to pull the runtime image.");
  }

  const nextLocalEnv = buildLocalRuntimeEnvOverrides(nextState.localEnv, defaultStackImage);
  await writeEnvFile(context.paths.localEnvFile, nextLocalEnv, LOCAL_ENV_HEADER);
  nextState = await prepareState(context, { ...options, useLocalBuild: true });
  autoSwitchedToLocalBuild = true;
  return { state: nextState, autoSwitchedToLocalBuild };
}

async function syncDockerMcpSecrets(context, localEnv) {
  await ensureDir(context.paths.stateDir);
  const previousState = await readJsonFile(context.paths.dockerMcpSecretsFile, {
    version: 1,
    secrets: {}
  });
  const initialSecretStatus = await readDockerMcpSecretStatus(context, localEnv);
  const actions = [];

  for (const entry of initialSecretStatus.plan) {
    if (!entry.configured) continue;
    const rawValue = String(localEnv?.[entry.envKey] ?? "").trim();
    const previousHash = String(previousState?.secrets?.[entry.secretName] ?? "");
    if (entry.present && previousHash === entry.desiredHash) continue;

    const setResult = await dockerMcpCapture(["secret", "set", `${entry.secretName}=${rawValue}`], context.repoRoot);
    if (setResult.code !== 0) {
      throw new Error(setResult.stderr.trim() || setResult.stdout.trim() || `Failed to store ${entry.label} in Docker MCP secrets.`);
    }
    actions.push(`synced ${entry.label}`);
  }

  const finalSecretStatus = actions.length > 0
    ? await readDockerMcpSecretStatus(context, localEnv)
    : initialSecretStatus;
  await writeJsonFile(context.paths.dockerMcpSecretsFile, {
    version: 1,
    secrets: Object.fromEntries(finalSecretStatus.plan
      .filter((entry) => entry.configured)
      .map((entry) => [entry.secretName, hashDockerMcpSecretValue(String(localEnv?.[entry.envKey] ?? "").trim())])),
    updatedAt: new Date().toISOString()
  });

  return {
    ...finalSecretStatus,
    actions
  };
}

async function ensurePermanentDockerMcp(context, options = {}) {
  const repoConfigPath = options.repoConfigPath ?? await ensureDockerMcpConfig(context);
  await ensureDockerMcpAvailable(context.repoRoot);

  const catalog = await dockerMcpCapture(["catalog", "show"], context.repoRoot);
  if (catalog.code !== 0) {
    throw new Error(catalog.stderr.trim() || catalog.stdout.trim() || "Failed to load the Docker MCP catalog.");
  }

  const enable = await dockerMcpCapture(["server", "enable", ...DEFAULT_DOCKER_MCP_SERVERS], context.repoRoot);
  if (enable.code !== 0) {
    throw new Error(enable.stderr.trim() || enable.stdout.trim() || "Failed to enable the required Docker MCP servers.");
  }

  const statusBefore = await readDockerMcpStatus(context, repoConfigPath);
  const actions = [];

  if (!statusBefore.usesRepoConfig) {
    const configWrite = await dockerMcpCapture(["config", "write", repoConfigPath], context.repoRoot);
    if (configWrite.code !== 0) {
      throw new Error(configWrite.stderr.trim() || configWrite.stdout.trim() || "Failed to point Docker MCP at the repo-local config.");
    }
    actions.push("activated repo config");
  }

  const statusAfterConfig = statusBefore.usesRepoConfig
    ? statusBefore
    : await readDockerMcpStatus(context, repoConfigPath);
  if (!statusAfterConfig.codexConnected) {
    const connect = await dockerMcpCapture(["client", "connect", "codex", "--global"], context.repoRoot);
    if (connect.code !== 0) {
      throw new Error(connect.stderr.trim() || connect.stdout.trim() || "Failed to connect Codex to the Docker MCP gateway.");
    }
    actions.push("connected Codex");
  }

  const finalStatus = statusAfterConfig.codexConnected
    ? statusAfterConfig
    : await readDockerMcpStatus(context, repoConfigPath);
  if (!finalStatus.codexConnected) {
    throw new Error("Codex could not be connected to the Docker MCP gateway. Install Codex locally and rerun the command.");
  }
  const localEnv = options.localEnv ?? await readEnvFile(context.paths.localEnvFile);
  const secretStatus = await syncDockerMcpSecrets(context, localEnv);
  actions.push(...secretStatus.actions);

  return {
    ok: true,
    servers: DEFAULT_DOCKER_MCP_SERVERS,
    actions,
    secretStatus,
    ...finalStatus
  };
}

async function promptRequired(rl, label, fallback = "") {
  while (true) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim() || fallback;
    if (answer) return answer;
    console.log(`${label} is required.`);
  }
}

function parsePromptPrincipals(value, fallback = []) {
  return normalizePrincipalArray(parseFlexibleArray(value, fallback));
}

function formatPromptList(values) {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function shouldPromptForAllowlist(policy, currentValues) {
  return policy === "allowlist" || currentValues.length > 0;
}

async function promptForInit(context, plugin, existingLocalEnv, options, detectedCodexAuthPath = "") {
  if (options.yes || options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { plugin, localEnv: {} };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    console.log("Detected repo settings:");
    console.log(`- Project: ${plugin.projectName}`);
    console.log(`- Tooling profile: ${plugin.toolingProfile}`);
    console.log(`- Deployment profile: ${plugin.deploymentProfile}`);
    console.log(`- Runtime profile: ${plugin.runtimeProfile}`);
    console.log(`- Queue profile: ${plugin.queueProfile}`);
    console.log(`- Instruction files: ${formatPromptList(plugin.instructionFiles)}`);
    console.log(`- Knowledge files: ${formatPromptList(plugin.knowledgeFiles)}`);
    console.log(`- Verification commands: ${formatPromptList(plugin.verificationCommands)}`);
    console.log("Use CLI flags or edit .openclaw/plugin.json later if you need to override these.");

    const customizeDetectedSettings = parseBooleanString(
      (await rl.question("Override detected repo settings now [no]: ")).trim(),
      false
    );

    let projectName = plugin.projectName;
    let profile = plugin.profile;
    let toolingProfile = plugin.toolingProfile;
    let deploymentProfile = plugin.deploymentProfile;
    let runtimeProfile = plugin.runtimeProfile;
    let queueProfile = plugin.queueProfile;
    let instructionFiles = plugin.instructionFiles;
    let knowledgeFiles = plugin.knowledgeFiles;
    let verificationCommands = plugin.verificationCommands;

    if (customizeDetectedSettings) {
      if (listBuiltinProfileNames().length > 1) {
        const availableProfiles = listBuiltinProfileNames().join(", ");
        profile = (await rl.question(`Preset profile [${plugin.profile}] (${availableProfiles}): `)).trim() || plugin.profile;
      }
      projectName = (await rl.question(`Project name [${plugin.projectName}]: `)).trim() || plugin.projectName;
      toolingProfile = (await rl.question(`Tooling profile [${plugin.toolingProfile}]: `)).trim() || plugin.toolingProfile;
      deploymentProfile = (await rl.question(`Deployment profile [${plugin.deploymentProfile}]: `)).trim() || plugin.deploymentProfile;
      runtimeProfile = (await rl.question(`Runtime profile [${plugin.runtimeProfile}]: `)).trim() || plugin.runtimeProfile;
      queueProfile = (await rl.question(`Queue profile [${plugin.queueProfile}]: `)).trim() || plugin.queueProfile;
      const instructionFilesInput = (await rl.question(`Instruction files [${plugin.instructionFiles.join(", ")}]: `)).trim();
      const knowledgeFilesInput = (await rl.question(`Knowledge files [${plugin.knowledgeFiles.join(", ")}]: `)).trim();
      const verificationCommandsInput = (await rl.question(`Verification commands [${plugin.verificationCommands.join(", ")}]: `)).trim();
      instructionFiles = instructionFilesInput ? instructionFilesInput.split(/\s*,\s*/g) : plugin.instructionFiles;
      knowledgeFiles = knowledgeFilesInput ? knowledgeFilesInput.split(/\s*,\s*/g) : plugin.knowledgeFiles;
      verificationCommands = verificationCommandsInput ? verificationCommandsInput.split(/\s*,\s*/g) : plugin.verificationCommands;
    }

    const acpDefaultAgent = await promptRequired(rl, "ACP default agent", plugin.acp.defaultAgent);
    const defaultAuthMode = shouldUpgradeLegacyCodexBootstrap({
      cliAuthMode: options.authMode,
      localEnvAuthMode: existingLocalEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE,
      pluginAuthMode: plugin.security.authBootstrapMode,
      acpDefaultAgent
    })
      ? "codex"
      : resolvePreferredAuthMode(plugin.security.authBootstrapMode, acpDefaultAgent);
    const authMode = (await rl.question(`Auth mode [${defaultAuthMode}]: `)).trim() || defaultAuthMode;
    const dmPolicy = (await rl.question(`Telegram DM policy [${plugin.telegram.dmPolicy}]: `)).trim() || plugin.telegram.dmPolicy;
    const groupPolicy = (await rl.question(`Telegram group policy [${plugin.telegram.groupPolicy}]: `)).trim() || plugin.telegram.groupPolicy;

    const currentAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, []);
    const currentGroupAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, []);
    const allowUsersInput = shouldPromptForAllowlist(dmPolicy, currentAllowUsers)
      ? (await rl.question(`Telegram DM allowlist [${currentAllowUsers.join(", ")}]: `)).trim()
      : "";
    const groupAllowUsersInput = shouldPromptForAllowlist(groupPolicy, currentGroupAllowUsers)
      ? (await rl.question(`Telegram group allowlist [${currentGroupAllowUsers.join(", ")}]: `)).trim()
      : "";

    const hasTelegramToken = Boolean(existingLocalEnv.TELEGRAM_BOT_TOKEN) && !String(existingLocalEnv.TELEGRAM_BOT_TOKEN).startsWith("replace-with-");
    const telegramTokenHint = hasTelegramToken ? "configured" : "replace-with-your-botfather-token";
    const telegramBotTokenInput = hasTelegramToken
      ? ""
      : (await rl.question(`Telegram bot token [${telegramTokenHint}]: `)).trim();

    let openAiApiKey = String(existingLocalEnv.OPENAI_API_KEY ?? "");
    let targetAuthPath = String(existingLocalEnv.TARGET_AUTH_PATH ?? "") || detectedCodexAuthPath;
    if (authMode === "codex") {
      if (!openAiApiKey) {
        openAiApiKey = (await rl.question("OpenAI API key: ")).trim();
      }
      if (!targetAuthPath) {
        targetAuthPath = (await rl.question("Codex auth path: ")).trim();
      }
    }

    const acpAllowedAgents = normalizeAllowedAgents(acpDefaultAgent, plugin.acp.allowedAgents);

    const nextPlugin = normalizePluginConfig({
      ...plugin,
      profile,
      projectName,
      deploymentProfile,
      toolingProfile,
      runtimeProfile,
      queueProfile,
      verificationCommands,
      acp: {
        ...plugin.acp,
        defaultAgent: acpDefaultAgent,
        allowedAgents: acpAllowedAgents
      },
      telegram: {
        ...plugin.telegram,
        dmPolicy,
        groupPolicy
      },
      security: {
        ...plugin.security,
        authBootstrapMode: authMode
      }
    }, context.repoRoot, context.detection, {
      ...options,
      profile,
      projectName,
      deploymentProfile,
      toolingProfile,
      runtimeProfile,
      queueProfile,
      authMode,
      acpDefaultAgent,
      acpAllowedAgent: acpAllowedAgents,
      dmPolicy,
      groupPolicy,
      instructionFile: instructionFiles,
      knowledgeFile: knowledgeFiles,
      verificationCommand: verificationCommands
    });

    return {
      plugin: nextPlugin,
      localEnv: {
        TELEGRAM_BOT_TOKEN: telegramBotTokenInput || (hasTelegramToken ? existingLocalEnv.TELEGRAM_BOT_TOKEN : "replace-with-your-botfather-token"),
        OPENCLAW_TELEGRAM_ALLOW_FROM: JSON.stringify(
          shouldPromptForAllowlist(dmPolicy, currentAllowUsers)
            ? parsePromptPrincipals(allowUsersInput, currentAllowUsers)
            : currentAllowUsers
        ),
        OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: JSON.stringify(
          shouldPromptForAllowlist(groupPolicy, currentGroupAllowUsers)
            ? parsePromptPrincipals(groupAllowUsersInput, currentGroupAllowUsers)
            : currentGroupAllowUsers
        ),
        OPENAI_API_KEY: authMode === "codex" ? openAiApiKey : "",
        TARGET_AUTH_PATH: authMode === "codex" && targetAuthPath ? toDockerPath(path.resolve(targetAuthPath)) : ""
      }
    };
  } finally {
    rl.close();
  }
}

async function handleInit(context, options) {
  await ensureDir(context.paths.openclawDir);
  const existingPlugin = await readJsonFile(context.paths.pluginFile, null);
  const existingLocalEnv = await readEnvFile(context.paths.localEnvFile);
  const detectedCodexAuthPath = await detectDefaultCodexAuthPath();
  const basePlugin = normalizePluginConfig(existingPlugin ?? {}, context.repoRoot, context.detection, options);
  const initState = existingPlugin && !options.force
    ? { plugin: basePlugin, localEnv: {} }
    : await promptForInit(context, basePlugin, existingLocalEnv, options, detectedCodexAuthPath);
  const plugin = initState.plugin;
  const useLocalBuild = resolveBoolean(localOverrideValue(options.useLocalBuild, existingLocalEnv.OPENCLAW_USE_LOCAL_BUILD, false), false);

  if (!plugin.acp.defaultAgent) {
    throw new Error("ACP default agent is required. Pass --acp-default-agent in non-interactive mode or rerun init interactively.");
  }

  const localEnvValues = {
    ...buildLocalEnvTemplateValues(plugin, existingLocalEnv, options, useLocalBuild, detectedCodexAuthPath),
    ...initState.localEnv
  };
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnvValues, options);
  const validationErrors = validateProjectManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Cannot initialize workspace: ${validationErrors.join("; ")}`);
  }

  if (!existingPlugin || options.force) {
    await writeJsonFile(context.paths.pluginFile, plugin);
    console.log(`Wrote ${path.relative(context.repoRoot, context.paths.pluginFile)}`);
  } else {
    console.log(`Keeping existing ${path.relative(context.repoRoot, context.paths.pluginFile)}`);
  }

  if (!(await fileExists(context.paths.instructionsFile)) || options.force) {
    await writeTextFile(context.paths.instructionsFile, defaultInstructionsTemplate(plugin.projectName));
  }
  if (!(await fileExists(context.paths.knowledgeFile)) || options.force) {
    await writeTextFile(context.paths.knowledgeFile, defaultKnowledgeTemplate(plugin.projectName));
  }

  await writeTextFile(context.paths.localEnvExampleFile, defaultLocalEnvExample(useLocalBuild));

  if (!(await fileExists(context.paths.localEnvFile)) || options.force) {
    await writeEnvFile(
      context.paths.localEnvFile,
      localEnvValues,
      LOCAL_ENV_HEADER
    );
  }

  await ensureGitignoreEntries(context.repoRoot);
  const state = await prepareState(context, options);
  const mcp = await ensurePermanentDockerMcp(context, {
    repoConfigPath: context.paths.dockerMcpConfigFile,
    localEnv: state.localEnv
  });

  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.localEnvFile)}`);
  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.manifestFile)}`);
  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.composeFile)}`);
  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.dockerMcpConfigFile)}`);
  console.log(`Detected preset: ${plugin.profile}`);
  console.log(`Effective tooling profile: ${state.manifest.toolingProfile}`);
  console.log(`Docker MCP: ${mcp.actions.length > 0 ? mcp.actions.join(", ") : "ready"}`);
}

async function handleConfigValidate(context, options) {
  const pluginRaw = await readJsonFile(context.paths.pluginFile, null);
  if (!pluginRaw) throw new Error(`Missing ${context.paths.pluginFile}`);
  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  const localEnv = await readEnvFile(context.paths.localEnvFile);
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnv, options);
  const errors = validateProjectManifest(manifest);
  const payload = {
    ok: errors.length === 0,
    productVersion: PRODUCT_VERSION,
    plugin,
    manifest,
    errors
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Plugin profile: ${plugin.profile}`);
    console.log(`Project: ${plugin.projectName}`);
    console.log(`Deployment: ${plugin.deploymentProfile}`);
    console.log(`Validation: ${errors.length === 0 ? "ok" : errors.join("; ")}`);
  }

  if (errors.length > 0) process.exitCode = 1;
}

async function handleConfigMigrate(context, options) {
  const pluginRaw = await readJsonFile(context.paths.pluginFile, null);
  if (!pluginRaw) throw new Error(`Missing ${context.paths.pluginFile}`);
  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  await writeJsonFile(context.paths.pluginFile, plugin);
  console.log(`Migrated ${path.relative(context.repoRoot, context.paths.pluginFile)} to version ${plugin.version}`);
}

async function handleUp(context, options) {
  let state = await prepareState(context, options);
  const mcp = await ensurePermanentDockerMcp(context, {
    repoConfigPath: context.paths.dockerMcpConfigFile,
    localEnv: state.localEnv
  });
  if (state.manifest.deploymentProfile === "native-dev") {
    console.log("Deployment profile is native-dev.");
    console.log(`Use ${path.relative(context.repoRoot, context.paths.manifestFile)} with the official OpenClaw onboarding flow.`);
    return;
  }

  const runtimeReady = await ensureRuntimeImageReady(context, state, options);
  state = runtimeReady.state;
  if (runtimeReady.autoSwitchedToLocalBuild) {
    console.log("Remote runtime image is unavailable. Falling back to a local runtime build.");
  }

  const args = ["up", "-d"];
  if (state.useLocalBuild) args.push("--build");
  await dockerCompose(context, args);
  if (mcp.actions.length > 0) {
    console.log(`Docker MCP: ${mcp.actions.join(", ")}.`);
  }
  if (runtimeReady.autoSwitchedToLocalBuild) {
    console.log(`Saved OPENCLAW_USE_LOCAL_BUILD=true in ${path.relative(context.repoRoot, context.paths.localEnvFile)}.`);
  }
  console.log("OpenClaw stack is starting.");
}

async function handleDown(context) {
  await prepareState(context);
  await dockerCompose(context, ["down"]);
}

async function handleVerify(context, options) {
  const state = await prepareState(context, options);
  if (!(await gatewayRunning(context))) {
    throw new Error("OpenClaw gateway is not running. Start it with openclaw-repo-agent up first.");
  }
  if (state.manifest.verificationCommands.length === 0) {
    throw new Error(`No verification commands are configured in ${context.paths.pluginFile}.`);
  }
  for (const command of state.manifest.verificationCommands) {
    console.log(`Running verification: ${command}`);
    await dockerCompose(context, ["exec", "openclaw-gateway", "sh", "-lc", command]);
  }
}

async function handlePair(context, options) {
  await prepareState(context, options);
  if (!(await gatewayRunning(context))) {
    throw new Error("OpenClaw gateway is not running. Start it with openclaw-repo-agent up first.");
  }

  if (options.approve) {
    await openclawGatewayCommand(context, ["pairing", "approve", "telegram", options.approve]);
  } else {
    await openclawGatewayCommand(context, ["pairing", "list", "telegram"]);
  }

  if ((options.allowUser?.length ?? 0) === 0
    && (options.groupAllowUser?.length ?? 0) === 0
    && !options.switchDmPolicy
    && !options.switchGroupPolicy) {
    return;
  }

  const localEnv = await readEnvFile(context.paths.localEnvFile);
  localEnv.OPENCLAW_TELEGRAM_ALLOW_FROM = JSON.stringify(normalizePrincipalArray([
    ...parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, []),
    ...(options.allowUser ?? [])
  ]));
  localEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM = JSON.stringify(normalizePrincipalArray([
    ...parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, []),
    ...(options.groupAllowUser ?? [])
  ]));
  if (options.switchDmPolicy) localEnv.OPENCLAW_TELEGRAM_DM_POLICY = options.switchDmPolicy;
  if (options.switchGroupPolicy) localEnv.OPENCLAW_TELEGRAM_GROUP_POLICY = options.switchGroupPolicy;

  const plugin = normalizePluginConfig(await readJsonFile(context.paths.pluginFile, {}), context.repoRoot, context.detection, options);
  await writeEnvFile(
    context.paths.localEnvFile,
    {
      ...buildLocalEnvTemplateValues(plugin, localEnv, options, resolveBoolean(localEnv.OPENCLAW_USE_LOCAL_BUILD, false)),
      ...localEnv
    },
    LOCAL_ENV_HEADER
  );
  await prepareState(context, options);
  await rerenderIfRunning(context);
  console.log("OpenClaw local allowlists updated.");
}

async function checkLatestPackageVersion(packageName) {
  return await new Promise((resolve) => {
    const request = https.get(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: {
        "User-Agent": PRODUCT_NAME,
        Accept: "application/json"
      },
      timeout: 3000
    }, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(String(payload.version ?? "").replace(/^v/i, "") || null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

async function handleStatus(context, options) {
  const state = await prepareState(context, options);
  const packageName = process.env.NPM_PACKAGE_NAME || DEFAULT_NPM_PACKAGE_NAME;
  const latestVersion = options.checkUpdates ? await checkLatestPackageVersion(packageName) : null;
  const updateStatus = latestVersion
    ? compareVersions(latestVersion, PRODUCT_VERSION) > 0
      ? `update available (${latestVersion})`
      : "current"
    : "unknown";
  const running = await gatewayRunning(context);
  const payload = {
    productVersion: PRODUCT_VERSION,
    latestVersion,
    updateStatus,
    running,
    manifest: {
      projectName: state.manifest.projectName,
      deploymentProfile: state.manifest.deploymentProfile,
      toolingProfile: state.manifest.toolingProfile,
      runtimeProfile: state.manifest.runtimeProfile,
      queueProfile: state.manifest.queueProfile,
      authMode: state.manifest.security.authBootstrapMode,
      verificationCommands: state.manifest.verificationCommands
    }
  };
  const dockerMcpAvailable = (await dockerMcpCapture(["--help"], context.repoRoot)).code === 0;
  payload.mcp = dockerMcpAvailable
    ? {
        available: true,
        ...(await readDockerMcpStatus(context, context.paths.dockerMcpConfigFile)),
        secretStatus: await readDockerMcpSecretStatus(context, state.localEnv)
      }
    : {
        available: false,
        repoConfigPath: context.paths.dockerMcpConfigFile
      };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Version: ${PRODUCT_VERSION}`);
    console.log(`Update status: ${updateStatus}`);
    console.log(`Project: ${state.manifest.projectName}`);
    console.log(`Deployment: ${state.manifest.deploymentProfile}`);
    console.log(`Tooling: ${state.manifest.toolingProfile}`);
    console.log(`Runtime: ${state.manifest.runtimeProfile}`);
    console.log(`Queue: ${state.manifest.queueProfile}`);
    console.log(`Auth: ${state.manifest.security.authBootstrapMode}`);
    console.log(`Gateway: ${running ? "running" : "stopped"}`);
    console.log(`Docker MCP: ${payload.mcp.available ? (payload.mcp.usesRepoConfig && payload.mcp.codexConnected ? "ready" : "needs attention") : "unavailable"}`);
    if (payload.mcp.available) {
      console.log(`Docker MCP secrets: ${payload.mcp.secretStatus.syncedConfiguredCount}/${payload.mcp.secretStatus.configuredCount} configured secrets synced`);
    }
    console.log(`Verification commands: ${state.manifest.verificationCommands.length}`);
  }
}

function pushCheck(results, key, ok, detail, recovery = "") {
  results.push({ key, ok, detail, recovery });
}

async function handleDoctor(context, options) {
  const state = await prepareState(context, options);
  const results = [];

  const dockerVersion = await safeRunCommand("docker", ["--version"]);
  pushCheck(
    results,
    "docker",
    dockerVersion.code === 0,
    dockerVersion.code === 0 ? dockerVersion.stdout.trim() || dockerVersion.stderr.trim() : "Docker CLI is not available.",
    dockerVersion.code === 0 ? "" : "Install Docker Desktop or Docker Engine and ensure `docker` is on PATH."
  );

  const composeVersion = await safeRunCommand("docker", ["compose", "version"]);
  pushCheck(
    results,
    "compose",
    composeVersion.code === 0,
    composeVersion.code === 0 ? composeVersion.stdout.trim() || composeVersion.stderr.trim() : "Docker Compose plugin is not available.",
    composeVersion.code === 0 ? "" : "Install the Docker Compose plugin or update Docker."
  );

  const dockerMcpVersion = await dockerMcpCapture(["version"], context.repoRoot);
  pushCheck(
    results,
    "docker-mcp",
    dockerMcpVersion.code === 0,
    dockerMcpVersion.code === 0 ? dockerMcpVersion.stdout.trim() || "Docker MCP Toolkit is available." : "Docker MCP Toolkit is not available.",
    dockerMcpVersion.code === 0 ? "" : "Install or update Docker MCP Toolkit before using this project."
  );

  if (dockerMcpVersion.code === 0) {
    const mcpStatus = await readDockerMcpStatus(context, context.paths.dockerMcpConfigFile);
    const secretStatus = await readDockerMcpSecretStatus(context, state.localEnv);
    pushCheck(
      results,
      "docker-mcp-config",
      mcpStatus.usesRepoConfig,
      mcpStatus.usesRepoConfig ? "Docker MCP is using this repo's generated config." : "Docker MCP is not using this repo's generated config.",
      mcpStatus.usesRepoConfig ? "" : DOCKER_MCP_REQUIRED_RECOVERY
    );
    pushCheck(
      results,
      "docker-mcp-codex",
      mcpStatus.codexInstalled && mcpStatus.codexConnected,
      mcpStatus.codexInstalled
        ? (mcpStatus.codexConnected ? "Codex is connected to the Docker MCP gateway." : "Codex is installed but not connected to the Docker MCP gateway.")
        : "Codex is not installed.",
      mcpStatus.codexInstalled && mcpStatus.codexConnected ? "" : DOCKER_MCP_REQUIRED_RECOVERY
    );
    pushCheck(
      results,
      "docker-mcp-secrets",
      secretStatus.missingConfiguredSecrets.length === 0,
      secretStatus.configuredCount > 0
        ? `Docker MCP secrets are synced for ${secretStatus.syncedConfiguredCount}/${secretStatus.configuredCount} configured credentials.`
        : "No Docker MCP-managed credentials are configured yet.",
      secretStatus.missingConfiguredSecrets.length === 0 ? "" : "Run `openclaw-repo-agent up` or `openclaw-repo-agent mcp setup` to resync Docker MCP secrets."
    );
  }

  const localEnv = await readEnvFile(context.paths.localEnvFile);
  const telegramToken = String(localEnv.TELEGRAM_BOT_TOKEN ?? "").trim();
  pushCheck(
    results,
    "telegram-token",
    Boolean(telegramToken) && !telegramToken.startsWith("replace-with-"),
    Boolean(telegramToken) && !telegramToken.startsWith("replace-with-") ? "Telegram bot token is configured." : "Telegram bot token is missing.",
    Boolean(telegramToken) && !telegramToken.startsWith("replace-with-") ? "" : `Set TELEGRAM_BOT_TOKEN in ${context.paths.localEnvFile}.`
  );

  const authPath = String(localEnv.TARGET_AUTH_PATH ?? "").trim();
  const authPathExists = authPath ? await fileExists(authPath.replace(/\//g, path.sep)) : false;
  const authOk = state.manifest.security.authBootstrapMode !== "codex"
    || authPathExists
    || Boolean(state.detectedCodexAuthPath)
    || Boolean(localEnv.OPENAI_API_KEY);
  pushCheck(
    results,
    "auth",
    authOk,
    authOk ? "Auth bootstrap prerequisites are present." : "Codex auth bootstrap is not ready.",
    authOk ? "" : `Set TARGET_AUTH_PATH to a Codex home with auth.json or provide OPENAI_API_KEY in ${context.paths.localEnvFile}.`
  );

  const manifestErrors = validateProjectManifest(state.manifest);
  pushCheck(
    results,
    "manifest",
    manifestErrors.length === 0,
    manifestErrors.length === 0 ? "Manifest rendered successfully." : manifestErrors.join("; "),
    manifestErrors.length === 0 ? "" : "Run `openclaw-repo-agent config validate` and fix the reported fields."
  );

  if (!state.useLocalBuild) {
    const pull = await dockerCompose(context, ["pull", "openclaw-gateway"], { capture: true });
    pushCheck(
      results,
      "runtime-image",
      pull.code === 0,
      pull.code === 0 ? "Runtime image is available." : pull.stderr.trim() || pull.stdout.trim() || "Failed to pull runtime image.",
      pull.code === 0 ? "" : "Run `openclaw-repo-agent up` to auto-fallback to a local build, or set OPENCLAW_USE_LOCAL_BUILD=true."
    );
  } else {
    pushCheck(results, "runtime-image", true, "Local runtime build mode is enabled.");
  }

  let running = await gatewayRunning(context);
  if (!running && options.fix) {
    await handleUp(context, options);
    running = await gatewayRunning(context);
  }

  pushCheck(
    results,
    "gateway",
    running,
    running ? "OpenClaw gateway container is running." : "OpenClaw gateway is not running.",
    running ? "" : "Run `openclaw-repo-agent up` and retry."
  );

  if (running) {
    const status = await openclawGatewayCommand(context, ["status"], { capture: true });
    pushCheck(
      results,
      "openclaw-status",
      status.code === 0,
      status.code === 0 ? (status.stdout.trim() || "OpenClaw status succeeded.") : (status.stderr.trim() || status.stdout.trim() || "OpenClaw status failed."),
      status.code === 0 ? "" : "Inspect the gateway logs with `docker compose logs -f openclaw-gateway`."
    );

    const channelStatus = await openclawGatewayCommand(context, ["channels", "status", "--probe"], { capture: true });
    pushCheck(
      results,
      "pairing",
      channelStatus.code === 0,
      channelStatus.code === 0 ? "Telegram pairing/channel probe succeeded." : (channelStatus.stderr.trim() || channelStatus.stdout.trim() || "Telegram pairing/channel probe failed."),
      channelStatus.code === 0 ? "" : "Run `openclaw-repo-agent pair` after fixing token or network issues."
    );

    const inContainerDoctor = await dockerCompose(context, ["exec", "openclaw-gateway", "node", "/opt/openclaw/doctor.mjs", "--json"], { capture: true });
    pushCheck(
      results,
      "in-container-doctor",
      inContainerDoctor.code === 0,
      inContainerDoctor.code === 0 ? "In-container doctor checks passed." : (inContainerDoctor.stderr.trim() || inContainerDoctor.stdout.trim() || "In-container doctor failed."),
      inContainerDoctor.code === 0 ? "" : "Review the in-container doctor output and fix auth or render errors."
    );

    const workspaceAccess = await dockerCompose(context, ["exec", "openclaw-gateway", "sh", "-lc", "test -d /workspace && test -r /config/project-manifest.json"], { capture: true });
    pushCheck(
      results,
      "workspace-mount",
      workspaceAccess.code === 0,
      workspaceAccess.code === 0 ? "Workspace and manifest mounts are readable." : "Workspace or manifest mount is not readable inside the container.",
      workspaceAccess.code === 0 ? "" : "Check TARGET_REPO_PATH and GENERATED_MANIFEST_PATH in the rendered runtime env."
    );

    const healthz = await dockerCompose(context, ["exec", "openclaw-gateway", "node", "-e", "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { capture: true });
    pushCheck(
      results,
      "healthz",
      healthz.code === 0,
      healthz.code === 0 ? "Gateway health endpoint is reachable." : "Gateway health endpoint check failed.",
      healthz.code === 0 ? "" : "Inspect `docker compose logs -f openclaw-gateway` for runtime failures."
    );
  }

  const ok = results.every((result) => result.ok);
  if (options.json) {
    console.log(JSON.stringify({ ok, results }, null, 2));
  } else {
    for (const result of results) {
      console.log(`${result.ok ? "OK" : "FAIL"} ${result.key}: ${result.detail}`);
      if (!result.ok && result.recovery) console.log(`Next step: ${result.recovery}`);
    }
  }

  if (ok && options.verify) {
    await handleVerify(context, options);
  }
  if (!ok) process.exitCode = 1;
}

async function handleUpdate(context, options) {
  await handleConfigMigrate(context, options);
  let state = await prepareState(context, options);
  await ensurePermanentDockerMcp(context, {
    repoConfigPath: context.paths.dockerMcpConfigFile,
    localEnv: state.localEnv
  });
  const runtimeReady = await ensureRuntimeImageReady(context, state, options);
  state = runtimeReady.state;
  if (runtimeReady.autoSwitchedToLocalBuild) {
    console.log("Remote runtime image is unavailable. Falling back to a local runtime build.");
    console.log(`Saved OPENCLAW_USE_LOCAL_BUILD=true in ${path.relative(context.repoRoot, context.paths.localEnvFile)}.`);
  }
  if (await gatewayRunning(context)) {
    const args = ["up", "-d"];
    if (state.useLocalBuild) args.push("--build");
    await dockerCompose(context, args);
  }
  await handleDoctor(context, { ...options, verify: false });
}

async function handleMcpSetup(context, options) {
  await ensureGitignoreEntries(context.repoRoot);
  const payload = {
    ...(await ensurePermanentDockerMcp(context)),
    nextStep: "Docker MCP is part of the default flow now; `init` and `up` will keep it active for this repo."
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Prepared ${path.relative(context.repoRoot, payload.repoConfigPath)}`);
  console.log(`Enabled Docker MCP servers: ${DEFAULT_DOCKER_MCP_SERVERS.join(", ")}`);
  console.log(`Active Docker MCP config: ${payload.activeConfigPath || "not set"}`);
  console.log(`Codex connected to Docker MCP: ${payload.codexConnected ? "yes" : "no"}`);
  console.log(`Docker MCP secrets synced: ${payload.secretStatus.syncedConfiguredCount}/${payload.secretStatus.configuredCount}`);
  console.log(`Docker MCP: ${payload.actions.length > 0 ? payload.actions.join(", ") : "ready"}`);
  console.log("GitHub MCP auth can be synced by setting GITHUB_PERSONAL_ACCESS_TOKEN in .openclaw/local.env.");
}

async function handleMcpConnect(context, options) {
  const payload = await ensurePermanentDockerMcp(context);

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Codex is connected to the Docker MCP gateway.");
  console.log("Restart Codex if it is already running.");
}

async function handleMcpStatus(context, options) {
  const repoConfigPath = await ensureDockerMcpConfig(context);
  const payload = {
    ok: true,
    dockerMcpAvailable: false,
    repoConfigPath,
    activeConfigPath: "",
    usesRepoConfig: false,
    codexConnected: false,
    codexInstalled: false,
    secretStatus: emptyDockerMcpSecretStatus()
  };

  const availability = await dockerMcpCapture(["--help"], context.repoRoot);
  if (availability.code !== 0) {
    payload.ok = false;
    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`Prepared ${path.relative(context.repoRoot, repoConfigPath)}`);
    console.log("Docker MCP Toolkit is not available.");
    console.log("Install or update Docker Desktop / Docker MCP Toolkit, then rerun `openclaw-repo-agent init` or `openclaw-repo-agent up`.");
    return;
  }

  payload.dockerMcpAvailable = true;
  const configPathResult = await dockerMcpCapture(["config", "read"], context.repoRoot);
  const clientListResult = await dockerMcpCapture(["client", "ls", "--global", "--json"], context.repoRoot);
  Object.assign(payload, buildMcpStatusPayload(repoConfigPath, configPathResult, clientListResult));
  const localEnv = await readEnvFile(context.paths.localEnvFile);
  payload.secretStatus = await readDockerMcpSecretStatus(context, localEnv);

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Repo Docker MCP config: ${path.relative(context.repoRoot, repoConfigPath)}`);
  console.log(`Active Docker MCP config: ${payload.activeConfigPath || "not set"}`);
  console.log(`Using this repo's config: ${payload.usesRepoConfig ? "yes" : "no"}`);
  console.log(`Codex installed: ${payload.codexInstalled ? "yes" : "no"}`);
  console.log(`Codex connected to Docker MCP: ${payload.codexConnected ? "yes" : "no"}`);
  console.log(`Docker MCP secrets synced: ${payload.secretStatus.syncedConfiguredCount}/${payload.secretStatus.configuredCount}`);
  if (!payload.usesRepoConfig) {
    console.log(`Next step: ${DOCKER_MCP_REQUIRED_RECOVERY}`);
  } else if (!payload.codexConnected) {
    console.log(`Next step: ${DOCKER_MCP_REQUIRED_RECOVERY}`);
  }
}

function printHelp() {
  console.log(`${PRODUCT_NAME} ${PRODUCT_VERSION}

Usage:
  ${PRODUCT_NAME} <command> [options]

Commands:
  init             Initialize or refresh .openclaw files in a repository
  up               Start the local OpenClaw stack
  down             Stop the local OpenClaw stack
  pair             List or approve Telegram pairing requests
  doctor           Check local prerequisites and gateway health
  verify           Run configured verification commands in the gateway
  status           Show rendered manifest and runtime status
  update           Refresh generated state and restart the stack when needed
  mcp setup        Repair or reapply the required Docker MCP setup for this repo
  mcp status       Show Docker MCP activation status for this repo
  mcp connect      Reconnect Codex globally to the Docker MCP gateway
  config validate  Validate the repo plugin and rendered manifest
  config migrate   Rewrite plugin.json using current defaults

Global options:
  --repo-root <path>
  --product-root <path>
  --json
  --help, -h
  --version, -v

Notes:
  init and up now enforce the required Docker MCP setup automatically.

Examples:
  ${PRODUCT_NAME} init --repo-root /path/to/repo
  ${PRODUCT_NAME} status --check-updates
  ${PRODUCT_NAME} doctor --fix --verify
  ${PRODUCT_NAME} mcp setup
  ${PRODUCT_NAME} mcp connect
`);
}

export async function main(argv) {
  const parsed = parseArguments(argv);
  const [command, subcommand] = parsed.positionals;
  if (parsed.options.version) {
    console.log(PRODUCT_VERSION);
    return;
  }
  if (!command || parsed.options.help || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(parsed.options.repoRoot ?? process.cwd());
  const productRoot = resolveProductRoot(parsed.options.productRoot);
  const context = {
    repoRoot,
    productRoot,
    paths: resolvePaths(repoRoot),
    detection: await detectRepository(repoRoot)
  };

  if (command === "init") return await handleInit(context, parsed.options);
  if (command === "up") return await handleUp(context, parsed.options);
  if (command === "down") return await handleDown(context, parsed.options);
  if (command === "pair") return await handlePair(context, parsed.options);
  if (command === "doctor") return await handleDoctor(context, parsed.options);
  if (command === "verify") return await handleVerify(context, parsed.options);
  if (command === "status") return await handleStatus(context, parsed.options);
  if (command === "update") return await handleUpdate(context, parsed.options);
  if (command === "mcp" && subcommand === "setup") return await handleMcpSetup(context, parsed.options);
  if (command === "mcp" && subcommand === "status") return await handleMcpStatus(context, parsed.options);
  if (command === "mcp" && subcommand === "connect") return await handleMcpConnect(context, parsed.options);
  if (command === "config" && subcommand === "validate") return await handleConfigValidate(context, parsed.options);
  if (command === "config" && subcommand === "migrate") return await handleConfigMigrate(context, parsed.options);

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}
