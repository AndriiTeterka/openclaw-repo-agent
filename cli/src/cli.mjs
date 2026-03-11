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
  runCommand,
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
  renderComposeTemplate
} from "./templates.mjs";

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
const DEFAULT_LOCAL_ENV_FILE = "local.env";
const DEFAULT_LOCAL_ENV_EXAMPLE_FILE = "local.env.example";
const DEFAULT_PLUGIN_FILE = "plugin.json";
const DEFAULT_INSTRUCTIONS_FILE = "instructions.md";
const DEFAULT_KNOWLEDGE_FILE = "knowledge.md";

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

function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && ["true", "false", "yes", "no", "1", "0", "on", "off"].includes(next.toLowerCase())) {
        options[toCamelCase(key)] = parseBooleanString(next, true);
        index += 1;
      } else {
        options[toCamelCase(key)] = true;
      }
      continue;
    }

    if (ARRAY_FLAGS.has(key)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
      const optionKey = toCamelCase(key);
      if (!Array.isArray(options[optionKey])) options[optionKey] = [];
      options[optionKey].push(next);
      index += 1;
      continue;
    }

    if (STRING_FLAGS.has(key)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
      options[toCamelCase(key)] = next;
      index += 1;
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

async function detectRepository(repoRoot) {
  const markers = {
    gradlew: await fileExists(path.join(repoRoot, "gradlew")),
    buildGradle: await fileExists(path.join(repoRoot, "build.gradle")),
    settingsGradle: await fileExists(path.join(repoRoot, "settings.gradle")),
    pomXml: await fileExists(path.join(repoRoot, "pom.xml")),
    packageJson: await fileExists(path.join(repoRoot, "package.json")),
    pyproject: await fileExists(path.join(repoRoot, "pyproject.toml")),
    requirements: await fileExists(path.join(repoRoot, "requirements.txt")),
    goMod: await fileExists(path.join(repoRoot, "go.mod"))
  };

  const signals = [];
  if (markers.gradlew || markers.buildGradle || markers.settingsGradle || markers.pomXml) signals.push("java17");
  if (markers.packageJson) signals.push("node20");
  if (markers.pyproject || markers.requirements) signals.push("python311");
  if (markers.goMod) signals.push("go122");

  const toolingProfile = signals.length > 1 ? "polyglot" : signals[0] ?? "none";

  const instructionCandidates = [];
  if (await fileExists(path.join(repoRoot, "AGENTS.md"))) instructionCandidates.push("AGENTS.md");
  if (await fileExists(path.join(repoRoot, "README.md"))) instructionCandidates.push("README.md");
  instructionCandidates.push(".openclaw/instructions.md");

  const knowledgeCandidates = [".openclaw/knowledge.md"];
  if (await fileExists(path.join(repoRoot, "docs", "openclaw-project-knowledge.md"))) {
    knowledgeCandidates.push("docs/openclaw-project-knowledge.md");
  }

  const verificationCommands = [];
  if (signals.includes("java17")) {
    if (markers.gradlew) verificationCommands.push("./gradlew build");
    else if (markers.pomXml) verificationCommands.push("mvn test");
  }
  if (signals.includes("node20")) {
    verificationCommands.push("npm run build --if-present", "npm test --if-present");
  }
  if (signals.includes("python311")) {
    verificationCommands.push("python -m pytest");
  }
  if (signals.includes("go122")) {
    verificationCommands.push("go test ./...");
  }

  return {
    profile: "custom",
    toolingProfile,
    instructionCandidates: uniqueStrings(instructionCandidates),
    knowledgeCandidates: uniqueStrings(knowledgeCandidates),
    verificationCommands: uniqueStrings(verificationCommands)
  };
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

  const projectName = String(options.projectName ?? merged.projectName ?? path.basename(repoRoot)).trim() || path.basename(repoRoot);
  const deploymentProfile = String(options.deploymentProfile ?? merged.deploymentProfile ?? defaultDeploymentProfile()).trim() || defaultDeploymentProfile();
  const runtimeProfile = String(options.runtimeProfile ?? merged.runtimeProfile ?? "stable-chat").trim() || "stable-chat";
  const queueProfile = String(options.queueProfile ?? merged.queueProfile ?? runtimeProfile).trim() || runtimeProfile;
  const toolingProfile = String(options.toolingProfile ?? rawConfig?.toolingProfile ?? detection.toolingProfile ?? merged.toolingProfile ?? "none").trim() || "none";
  const authMode = normalizeAuthMode(options.authMode ?? merged.security?.authBootstrapMode ?? "external");
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
  plugin.agent.defaultModel = String(options.agentDefaultModel ?? plugin.agent.defaultModel ?? "").trim();
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

  plugin.security.authBootstrapMode = authMode;
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
  const authMode = normalizeAuthMode(localOverrideValue(options.authMode, localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE, plugin.security.authBootstrapMode));
  const topicAcp = resolveBoolean(localOverrideValue(options.topicAcp, localEnv.OPENCLAW_TOPIC_ACP, false), false);
  const acpDefaultAgent = localOverrideValue(options.acpDefaultAgent, localEnv.OPENCLAW_ACP_DEFAULT_AGENT, plugin.acp.defaultAgent);
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
      defaultModel: localOverrideValue(options.agentDefaultModel, localEnv.OPENCLAW_AGENT_DEFAULT_MODEL, plugin.agent.defaultModel)
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

function buildLocalEnvTemplateValues(context, plugin, existingLocalEnv, options, useLocalBuild) {
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

  if (plugin.security.authBootstrapMode !== "codex" && !options.openaiApiKey && options.targetAuthPath == null) {
    merged.OPENAI_API_KEY = merged.OPENAI_API_KEY || "";
    merged.TARGET_AUTH_PATH = merged.TARGET_AUTH_PATH || "";
  }

  return merged;
}

function buildRuntimeEnv(context, manifest, localEnv, useLocalBuild) {
  const gatewayPort = localEnv.OPENCLAW_GATEWAY_PORT || "18789";
  const controlUiOrigins = localEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS
    || JSON.stringify([`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`]);
  const targetAuthPath = localEnv.TARGET_AUTH_PATH
    ? path.resolve(localEnv.TARGET_AUTH_PATH.replace(/\//g, path.sep))
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

async function safeRunCommand(command, args, options = {}) {
  try {
    return await runCommand(command, args, options);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  }
}

async function dockerCompose(context, args, options = {}) {
  const commandArgs = ["compose", "-f", context.paths.composeFile, "--env-file", context.paths.runtimeEnvFile, ...args];
  if (options.capture) return await safeRunCommand("docker", commandArgs, { cwd: context.repoRoot });
  const code = await runLiveCommand("docker", commandArgs, { cwd: context.repoRoot });
  if (code !== 0) throw new Error(`docker compose ${args.join(" ")} failed with exit code ${code}`);
  return { code, stdout: "", stderr: "" };
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
  const useLocalBuild = resolveBoolean(localOverrideValue(options.useLocalBuild, localEnv.OPENCLAW_USE_LOCAL_BUILD, false), false);
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnv, options);
  const validationErrors = validateProjectManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Plugin config is invalid: ${validationErrors.join("; ")}`);
  }

  await ensureDir(context.paths.stateDir);
  await ensureDir(context.paths.emptyAuthDir);
  await writeJsonFile(context.paths.manifestFile, manifest);
  await writeTextFile(context.paths.composeFile, renderComposeTemplate({ useLocalBuild }));
  const runtimeEnv = buildRuntimeEnv(context, manifest, localEnv, useLocalBuild);
  await writeEnvFile(context.paths.runtimeEnvFile, runtimeEnv);

  return {
    plugin,
    localEnv,
    manifest,
    runtimeEnv,
    useLocalBuild
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

async function promptForInit(context, plugin, existingLocalEnv, options) {
  if (options.yes || options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { plugin, localEnv: {} };
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const projectName = (await rl.question(`Project name [${plugin.projectName}]: `)).trim() || plugin.projectName;
    const availableProfiles = listBuiltinProfileNames().join(", ");
    const profile = (await rl.question(`Preset profile [${plugin.profile}] (${availableProfiles}): `)).trim() || plugin.profile;
    const toolingProfile = (await rl.question(`Tooling profile [${plugin.toolingProfile}]: `)).trim() || plugin.toolingProfile;
    const deploymentProfile = (await rl.question(`Deployment profile [${plugin.deploymentProfile}]: `)).trim() || plugin.deploymentProfile;
    const runtimeProfile = (await rl.question(`Runtime profile [${plugin.runtimeProfile}]: `)).trim() || plugin.runtimeProfile;
    const queueProfile = (await rl.question(`Queue profile [${plugin.queueProfile}]: `)).trim() || plugin.queueProfile;
    const authMode = (await rl.question(`Auth mode [${plugin.security.authBootstrapMode}]: `)).trim() || plugin.security.authBootstrapMode;
    const acpDefaultAgent = await promptRequired(rl, "ACP default agent", plugin.acp.defaultAgent);
    const allowedAgentsDefault = plugin.acp.allowedAgents.length > 0 ? plugin.acp.allowedAgents.join(", ") : acpDefaultAgent;
    const allowedAgentsInput = (await rl.question(`ACP allowed agents [${allowedAgentsDefault}]: `)).trim();
    const instructionFiles = (await rl.question(`Instruction files [${plugin.instructionFiles.join(", ")}]: `)).trim();
    const knowledgeFiles = (await rl.question(`Knowledge files [${plugin.knowledgeFiles.join(", ")}]: `)).trim();
    const verificationCommandsInput = (await rl.question(`Verification commands [${plugin.verificationCommands.join(", ")}]: `)).trim();
    const dmPolicy = (await rl.question(`Telegram DM policy [${plugin.telegram.dmPolicy}]: `)).trim() || plugin.telegram.dmPolicy;
    const groupPolicy = (await rl.question(`Telegram group policy [${plugin.telegram.groupPolicy}]: `)).trim() || plugin.telegram.groupPolicy;

    const currentAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, []);
    const currentGroupAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, []);
    const allowUsersInput = (await rl.question(`Telegram DM allowlist [${currentAllowUsers.join(", ")}]: `)).trim();
    const groupAllowUsersInput = (await rl.question(`Telegram group allowlist [${currentGroupAllowUsers.join(", ")}]: `)).trim();

    const hasTelegramToken = Boolean(existingLocalEnv.TELEGRAM_BOT_TOKEN) && !String(existingLocalEnv.TELEGRAM_BOT_TOKEN).startsWith("replace-with-");
    const telegramTokenHint = hasTelegramToken ? "configured" : "replace-with-your-botfather-token";
    const telegramBotTokenInput = (await rl.question(`Telegram bot token [${telegramTokenHint}]: `)).trim();

    let openAiApiKey = "";
    let targetAuthPath = "";
    if (authMode === "codex") {
      const apiKeyHint = existingLocalEnv.OPENAI_API_KEY ? "configured" : "";
      openAiApiKey = (await rl.question(`OpenAI API key${apiKeyHint ? ` [${apiKeyHint}]` : ""}: `)).trim() || String(existingLocalEnv.OPENAI_API_KEY ?? "");
      targetAuthPath = (await rl.question(`Codex auth path [${String(existingLocalEnv.TARGET_AUTH_PATH ?? "")}]: `)).trim() || String(existingLocalEnv.TARGET_AUTH_PATH ?? "");
    }

    const verificationCommands = verificationCommandsInput ? verificationCommandsInput.split(/\s*,\s*/g) : plugin.verificationCommands;
    const acpAllowedAgents = normalizeAllowedAgents(
      acpDefaultAgent,
      allowedAgentsInput ? allowedAgentsInput.split(/\s*,\s*/g) : plugin.acp.allowedAgents
    );

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
      instructionFile: instructionFiles ? instructionFiles.split(/\s*,\s*/g) : plugin.instructionFiles,
      knowledgeFile: knowledgeFiles ? knowledgeFiles.split(/\s*,\s*/g) : plugin.knowledgeFiles,
      verificationCommand: verificationCommands
    });

    return {
      plugin: nextPlugin,
      localEnv: {
        TELEGRAM_BOT_TOKEN: telegramBotTokenInput || (hasTelegramToken ? existingLocalEnv.TELEGRAM_BOT_TOKEN : "replace-with-your-botfather-token"),
        OPENCLAW_TELEGRAM_ALLOW_FROM: JSON.stringify(parsePromptPrincipals(allowUsersInput, currentAllowUsers)),
        OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: JSON.stringify(parsePromptPrincipals(groupAllowUsersInput, currentGroupAllowUsers)),
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
  const basePlugin = normalizePluginConfig(existingPlugin ?? {}, context.repoRoot, context.detection, options);
  const initState = existingPlugin && !options.force
    ? { plugin: basePlugin, localEnv: {} }
    : await promptForInit(context, basePlugin, existingLocalEnv, options);
  const plugin = initState.plugin;
  const useLocalBuild = resolveBoolean(localOverrideValue(options.useLocalBuild, existingLocalEnv.OPENCLAW_USE_LOCAL_BUILD, false), false);

  if (!plugin.acp.defaultAgent) {
    throw new Error("ACP default agent is required. Pass --acp-default-agent in non-interactive mode or rerun init interactively.");
  }

  const localEnvValues = {
    ...buildLocalEnvTemplateValues(context, plugin, existingLocalEnv, options, useLocalBuild),
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
      "Local-only OpenClaw configuration. Keep this file out of git."
    );
  }

  await ensureGitignoreEntries(context.repoRoot);
  const state = await prepareState(context, options);

  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.localEnvFile)}`);
  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.manifestFile)}`);
  console.log(`Prepared ${path.relative(context.repoRoot, context.paths.composeFile)}`);
  console.log(`Detected preset: ${plugin.profile}`);
  console.log(`Effective tooling profile: ${state.manifest.toolingProfile}`);
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
  const state = await prepareState(context, options);
  if (state.manifest.deploymentProfile === "native-dev") {
    console.log("Deployment profile is native-dev.");
    console.log(`Use ${path.relative(context.repoRoot, context.paths.manifestFile)} with the official OpenClaw onboarding flow.`);
    return;
  }
  const args = ["up", "-d"];
  if (state.useLocalBuild) args.push("--build");
  await dockerCompose(context, args);
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
    await dockerCompose(context, ["run", "--rm", "--no-deps", "openclaw-cli", "pairing", "approve", "telegram", options.approve]);
  } else {
    await dockerCompose(context, ["run", "--rm", "--no-deps", "openclaw-cli", "pairing", "list", "telegram"]);
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
      ...buildLocalEnvTemplateValues(context, plugin, localEnv, options, resolveBoolean(localEnv.OPENCLAW_USE_LOCAL_BUILD, false)),
      ...localEnv
    },
    "Local-only OpenClaw configuration. Keep this file out of git."
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
  const authOk = state.manifest.security.authBootstrapMode !== "codex" || authPathExists || Boolean(localEnv.OPENAI_API_KEY);
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
      pull.code === 0 ? "" : "Check registry access or set OPENCLAW_STACK_IMAGE to a reachable image."
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
    const status = await dockerCompose(context, ["run", "--rm", "--no-deps", "openclaw-cli", "status"], { capture: true });
    pushCheck(
      results,
      "openclaw-status",
      status.code === 0,
      status.code === 0 ? (status.stdout.trim() || "OpenClaw status succeeded.") : (status.stderr.trim() || status.stdout.trim() || "OpenClaw status failed."),
      status.code === 0 ? "" : "Inspect the gateway logs with `docker compose logs -f openclaw-gateway`."
    );

    const channelStatus = await dockerCompose(context, ["run", "--rm", "--no-deps", "openclaw-cli", "channels", "status", "--probe"], { capture: true });
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
  const state = await prepareState(context, options);
  if (!state.useLocalBuild) {
    await dockerCompose(context, ["pull", "openclaw-gateway"]);
  }
  if (await gatewayRunning(context)) {
    const args = ["up", "-d"];
    if (state.useLocalBuild) args.push("--build");
    await dockerCompose(context, args);
  }
  await handleDoctor(context, { ...options, verify: false });
}

function printHelp() {
  console.log(`${PRODUCT_NAME} ${PRODUCT_VERSION}

Commands:
  init
  up
  down
  pair
  doctor
  verify
  status
  config validate
  config migrate
  update
`);
}

export async function main(argv) {
  const parsed = parseArguments(argv);
  const [command, subcommand] = parsed.positionals;
  if (!command || command === "help" || command === "--help") {
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
  if (command === "config" && subcommand === "validate") return await handleConfigValidate(context, parsed.options);
  if (command === "config" && subcommand === "migrate") return await handleConfigMigrate(context, parsed.options);

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}
