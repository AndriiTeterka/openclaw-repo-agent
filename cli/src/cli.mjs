import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";

import {
  deepMerge,
  ensureDir,
  fileExists,
  normalizePrincipalArray,
  normalizeTelegramPrincipal,
  readJsonFile,
  readTextFile,
  resolveBoolean,
  safeRunCommand,
  uniqueStrings,
  writeJsonFile,
  writeTextFile
} from "../../runtime/shared.mjs";
import {
  defaultDeploymentProfile,
  normalizeAuthMode,
  normalizeProjectManifest,
  validateProjectManifest
} from "../../runtime/manifest-contract.mjs";
import {
  assertSupportedAcpAgent,
  assertSupportedAcpAgentList
} from "../../runtime/supported-acp-agents.mjs";
import {
  BUILTIN_PROFILES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENCLAW_IMAGE
} from "./builtin-profiles.mjs";
import {
  describeCommandFromArgv,
  parseArguments
} from "./command-line.mjs";
import {
  PRODUCT_NAME,
  PRODUCT_VERSION
} from "./product-metadata.mjs";
import {
  defaultInstructionsTemplate,
  renderComposeTemplate
} from "./templates.mjs";
import { detectRepository } from "./repository-detection.mjs";
import {
  allocateGatewayPort,
  buildInstanceMetadata,
  buildRegistryEntry,
  deriveComposeProjectName,
  fingerprintTelegramBotToken,
  LEGACY_COMPOSE_PORT,
  listInstanceRegistryEntries,
  readInstanceRegistry,
  resolveInstanceRegistryPath,
  shouldManageGatewayPort,
  upsertInstanceRegistryEntry
} from "./instance-registry.mjs";
import {
  printReport,
  renderStatusMarker
} from "./reporting.mjs";

export { describeCommandFromArgv } from "./command-line.mjs";

const DEFAULT_STATE_COMPOSE_FILE = "docker-compose.openclaw.yml";
const DEFAULT_STATE_ENV_FILE = "runtime.env";
const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_SECRETS_ENV_FILE = "secrets.env";
const DEFAULT_INSTRUCTIONS_FILE = "instructions.md";
const SECRETS_ENV_HEADER = "OpenClaw secrets. Keep this file out of git.";

export const ACP_AGENT_CHOICES = [
  { value: "codex", label: "codex" },
  { value: "claude", label: "claude" },
  { value: "gemini", label: "gemini" }
];

export const CODEX_AUTH_SOURCE_CHOICES = [
  { value: "auth-folder", label: "Use OpenAI subscription login" },
  { value: "api-key", label: "Use OpenAI API key" }
];

function normalizeAllowedAgents(defaultAgent, allowedAgents = []) {
  return uniqueStrings([
    ...assertSupportedAcpAgentList(allowedAgents, "acp.allowedAgents"),
    ...(defaultAgent ? [assertSupportedAcpAgent(defaultAgent, "acp.defaultAgent")] : [])
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

async function updateInstanceRegistry(context, localEnv = {}) {
  return await upsertInstanceRegistryEntry(context.instanceRegistryFile, buildRegistryEntry(context, localEnv));
}

async function ensureInstanceLocalEnv(context, instanceEnv, options = {}) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const registryEntries = listInstanceRegistryEntries(registry);
  const existingEntry = registryEntries.find((e) => String(e?.instanceId ?? "") === context.instanceId);

  const nextLocalEnv = {
    ...instanceEnv,
    OPENCLAW_STACK_IMAGE: String(context.localRuntimeImage ?? "").trim(),
    OPENCLAW_INSTANCE_ID: context.instanceId,
    OPENCLAW_GATEWAY_PORT: String(instanceEnv.OPENCLAW_GATEWAY_PORT ?? existingEntry?.gatewayPort ?? LEGACY_COMPOSE_PORT).trim(),
    OPENCLAW_PORT_MANAGED: String(instanceEnv.OPENCLAW_PORT_MANAGED ?? (existingEntry?.portManaged ? "true" : "false")).trim(),
    OPENCLAW_GATEWAY_TOKEN: String(instanceEnv.OPENCLAW_GATEWAY_TOKEN ?? existingEntry?.gatewayToken ?? "").trim() || randomToken(),
    OPENCLAW_GATEWAY_BIND: String(instanceEnv.OPENCLAW_GATEWAY_BIND ?? "lan").trim(),
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: String(instanceEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS ?? "").trim(),
  };

  const changes = [];
  let portManaged = shouldManageGatewayPort(nextLocalEnv);
  if (options.reassignPort) {
    portManaged = true;
  }
  nextLocalEnv.OPENCLAW_PORT_MANAGED = portManaged ? "true" : "false";

  const currentPort = Number.parseInt(String(nextLocalEnv.OPENCLAW_GATEWAY_PORT ?? "").trim(), 10);
  if (portManaged && (options.reassignPort || !Number.isInteger(currentPort) || currentPort === LEGACY_COMPOSE_PORT)) {
    const allocatedPort = await allocateGatewayPort({
      instanceId: context.instanceId,
      registryEntries,
      excludeInstanceId: context.instanceId
    });
    nextLocalEnv.OPENCLAW_GATEWAY_PORT = String(allocatedPort);
    changes.push(options.reassignPort ? "reassigned gateway port" : "allocated gateway port");
  }

  if (String(nextLocalEnv.OPENCLAW_STACK_IMAGE ?? "").trim() !== context.localRuntimeImage) {
    nextLocalEnv.OPENCLAW_STACK_IMAGE = context.localRuntimeImage;
    changes.push(`Updated managed runtime image to ${context.localRuntimeImage}.`);
  }
  await updateInstanceRegistry(context, nextLocalEnv);

  return {
    localEnv: nextLocalEnv,
    registry,
    changes
  };
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

function isExternalGatewayPairMode(options) {
  return Boolean(String(options.gatewayUrl ?? "").trim());
}

function validateExternalGatewayPairOptions(options) {
  if (!options.gatewayUrl && (options.gatewayToken || options.gatewayPassword)) {
    throw new Error("--gateway-token and --gateway-password require --gateway-url.");
  }
}

function buildExternalGatewayAuthArgs(options) {
  const url = String(options.gatewayUrl ?? "").trim();
  const token = String(options.gatewayToken ?? "").trim();
  const password = String(options.gatewayPassword ?? "").trim();
  const args = [];
  if (url) args.push("--url", url);
  if (token) args.push("--token", token);
  if (password) args.push("--password", password);
  return args;
}

function normalizePendingPairingRequests(payload) {
  const visited = new Set();

  function collect(value) {
    if (!value || typeof value !== "object") return [];
    if (visited.has(value)) return [];
    visited.add(value);

    if (Array.isArray(value)) {
      return value.flatMap((entry) => collect(entry));
    }

    const code = String(value.code ?? value.pairingCode ?? value.pairing_code ?? "").trim();
    if (code) {
      return [{
        code,
        requestedAt: String(value.requestedAt ?? value.requested ?? value.createdAt ?? value.created_at ?? "").trim(),
        raw: value
      }];
    }

    return Object.values(value).flatMap((entry) => collect(entry));
  }

  return collect(payload);
}

export function selectLatestPendingPairingRequest(payload) {
  const requests = normalizePendingPairingRequests(payload);
  if (requests.length === 0) return null;

  let bestIndex = 0;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < requests.length; index += 1) {
    const timestamp = Date.parse(requests[index].requestedAt);
    if (!Number.isNaN(timestamp) && timestamp >= bestTimestamp) {
      bestIndex = index;
      bestTimestamp = timestamp;
      continue;
    }
    if (Number.isNaN(timestamp) && bestTimestamp === Number.NEGATIVE_INFINITY) {
      bestIndex = index;
    }
  }

  return requests[bestIndex];
}

function parseJsonOutput(output, fallback = null) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    return fallback;
  }
}

function pluralize(label, count) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function summarizeOpenClawStatusPayload(payload) {
  const gateway = payload?.gateway ?? {};
  const gatewayUrl = String(gateway.url ?? "").trim();
  const gatewayVersion = String(gateway?.self?.version ?? "").trim();
  const channelCount = Array.isArray(payload?.channelOrder)
    ? payload.channelOrder.length
    : Array.isArray(payload?.channelSummary)
      ? payload.channelSummary.filter((line) => /^[A-Za-z]/.test(String(line ?? "").trim())).length
      : 0;
  const sessionCount = Number.isInteger(payload?.sessions?.count)
    ? payload.sessions.count
    : Number.isInteger(payload?.agents?.totalSessions)
      ? payload.agents.totalSessions
      : 0;

  if (gateway.reachable === false) {
    const errorDetail = String(gateway.error ?? gateway.authWarning ?? "").trim();
    return `Gateway is not reachable at ${gatewayUrl || "the configured URL"}${errorDetail ? ` (${errorDetail})` : ""}.`;
  }

  const parts = [gatewayUrl ? `Gateway reachable at ${gatewayUrl}` : "Gateway is reachable"];
  if (gatewayVersion) parts.push(`OpenClaw ${gatewayVersion}`);
  parts.push(`${pluralize("channel", channelCount)} configured`);
  parts.push(`${pluralize("session", sessionCount)} detected`);
  return `${parts.join("; ")}.`;
}

function summarizeOpenClawHealthPayload(payload) {
  const telegramProbe = payload?.channels?.telegram?.probe;
  if (payload?.ok) {
    const username = String(telegramProbe?.bot?.username ?? "").trim();
    const elapsedMs = Number.isFinite(telegramProbe?.elapsedMs) ? telegramProbe.elapsedMs : null;
    return `Gateway health RPC succeeded${username ? `; Telegram probe ok for @${username}` : ""}${elapsedMs != null ? ` (${elapsedMs} ms)` : ""}.`;
  }

  const detail = String(telegramProbe?.error ?? "").trim();
  return `Gateway health RPC failed${detail ? ` (${detail})` : ""}.`;
}

function isPlaceholderTelegramBotToken(value) {
  return String(value ?? "").trim().startsWith("replace-with-");
}

function hasConfiguredTelegramBotToken(value) {
  const token = String(value ?? "").trim();
  return Boolean(token) && !isPlaceholderTelegramBotToken(token);
}

export function looksLikeTelegramBotToken(value) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(value ?? "").trim());
}

export function classifyTelegramBotProbeResult(statusCode, payload = null) {
  const description = String(payload?.description ?? "").trim();
  if (statusCode === 200 && payload?.ok === true) {
    return {
      ok: true,
      definitiveFailure: false,
      detail: description
    };
  }

  const definitiveFailure = statusCode === 401
    || statusCode === 404
    || (payload?.ok === false && /unauthorized|not found|invalid|wrong token|bot token/i.test(description));

  return {
    ok: false,
    definitiveFailure,
    detail: description || (statusCode > 0 ? `HTTP ${statusCode}` : "")
  };
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

function printCommandReport(status, title, summary = [], sections = [], meta = {}) {
  printReport({
    status,
    title,
    summaryTitle: meta.summaryTitle || "Overview",
    summary,
    sections
  });
}

function buildStatusSection(title, status, items) {
  const normalizedItems = items.filter(Boolean);
  if (normalizedItems.length === 0) return null;
  return {
    title,
    status,
    items: normalizedItems
  };
}

function summarizeCommandFailure(command, result, fallbackMessage) {
  const detail = [result?.stderr, result?.stdout]
    .flatMap((value) => String(value ?? "").split(/\r?\n/g))
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^\[(warn|info|notice)\]/i.test(line));
  return detail ? `${fallbackMessage} ${detail}` : fallbackMessage;
}

function shouldUseSpinner(options = {}) {
  return !options.json && Boolean(process.stdout?.isTTY);
}

async function runWithSpinner(text, task, options = {}) {
  if (!shouldUseSpinner(options)) return await task();
  const spinner = ora({
    text,
    color: "cyan",
    discardStdin: false
  }).start();

  try {
    const result = await task();
    spinner.stop();
    return result;
  } catch (error) {
    spinner.stop();
    throw error;
  }
}

function resolvePromptChoiceValue(answer, choices, fallbackValue) {
  const normalized = String(answer ?? "").trim();
  if (!normalized) return fallbackValue;

  const numericIndex = Number.parseInt(normalized, 10);
  if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= choices.length) {
    return choices[numericIndex - 1].value;
  }

  const exact = choices.find((choice) => choice.value === normalized);
  return exact?.value || "";
}

function createInteractivePrompter() {
  return {
    async select(message, choices, fallbackValue) {
      const defaultIndex = Math.max(choices.findIndex((choice) => choice.value === fallbackValue), 0);
      console.log("");
      choices.forEach((choice, index) => {
        const prefix = chalk.gray(`  ${index + 1}.`);
        const suffix = index === defaultIndex ? chalk.gray(" (default)") : "";
        console.log(`${prefix} ${choice.label}${suffix}`);
      });
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message: `Choose ${message}`,
        default: "",
        filter(inputValue) {
          return resolvePromptChoiceValue(inputValue, choices, fallbackValue);
        },
        validate(inputValue) {
          if (resolvePromptChoiceValue(inputValue, choices, fallbackValue)) return true;
          return `Enter a number between 1 and ${choices.length}, or one of: ${choices.map((choice) => choice.value).join(", ")}.`;
        }
      }]);
      return String(value ?? "").trim();
    },
    async input(message, fallback = "", options = {}) {
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message,
        default: fallback || undefined,
        validate(inputValue) {
          const normalized = String(inputValue ?? "").trim();
          if (normalized || fallback || !options.required) return true;
          return `${message} is required.`;
        }
      }]);
      return String(value ?? "").trim() || fallback;
    },
    async password(message, fallback = "", options = {}) {
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message,
        default: undefined,
        transformer(inputValue) {
          return String(inputValue ?? "").replace(/./g, "*");
        },
        validate(inputValue) {
          const normalized = String(inputValue ?? "").trim();
          if (normalized || fallback || !options.required) return true;
          return `${message} is required.`;
        }
      }]);
      return String(value ?? "").trim() || fallback;
    }
  };
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
    configFile: path.join(openclawDir, DEFAULT_CONFIG_FILE),
    instructionsFile: path.join(openclawDir, DEFAULT_INSTRUCTIONS_FILE),
    secretsEnvFile: path.join(openclawDir, DEFAULT_SECRETS_ENV_FILE),
    composeFile: path.join(stateDir, DEFAULT_STATE_COMPOSE_FILE),
    runtimeEnvFile: path.join(stateDir, DEFAULT_STATE_ENV_FILE),
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

function normalizeIgnoreEntry(entry) {
  return String(entry ?? "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function hasIgnoreEntry(contents, entry) {
  const normalizedEntry = normalizeIgnoreEntry(entry);
  if (!normalizedEntry) return false;

  return String(contents ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => normalizeIgnoreEntry(line) === normalizedEntry);
}

export async function resolveGitInfoExcludePath(repoRoot) {
  const gitPath = path.join(repoRoot, ".git");
  let stats = null;
  try {
    stats = await fs.lstat(gitPath);
  } catch {
    return "";
  }

  if (stats.isDirectory()) {
    return path.join(gitPath, "info", "exclude");
  }

  if (!stats.isFile()) return "";

  const pointer = await readTextFile(gitPath, "");
  const firstLine = pointer.split(/\r?\n/g).map((line) => line.trim()).find(Boolean) ?? "";
  const match = firstLine.match(/^gitdir:\s*(.+)$/i);
  if (!match) return "";
  return path.join(path.resolve(repoRoot, match[1]), "info", "exclude");
}

export async function ensureGitExcludeEntries(repoRoot) {
  const excludePath = await resolveGitInfoExcludePath(repoRoot);
  if (!excludePath) return false;
  const requiredEntries = [".openclaw/"];
  const current = await readTextFile(excludePath, "");
  const next = [...requiredEntries.filter((entry) => !hasIgnoreEntry(current, entry))];
  if (next.length === 0) return false;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await writeTextFile(excludePath, `${current}${separator}${next.join("\n")}\n`);
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
  const acpDefaultAgent = assertSupportedAcpAgent(
    localOverrideValue(options.acpDefaultAgent, localEnv.OPENCLAW_ACP_DEFAULT_AGENT, plugin.acp.defaultAgent),
    options.acpDefaultAgent != null && options.acpDefaultAgent !== ""
      ? "--acp-default-agent"
      : (String(localEnv.OPENCLAW_ACP_DEFAULT_AGENT ?? "").trim() ? "OPENCLAW_ACP_DEFAULT_AGENT" : "acp.defaultAgent")
  );
  const authMode = shouldUpgradeLegacyCodexBootstrap({
    cliAuthMode: options.authMode,
    localEnvAuthMode: localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    pluginAuthMode: plugin.security.authBootstrapMode,
    acpDefaultAgent
  })
    ? "codex"
    : normalizeAuthMode(localOverrideValue(options.authMode, localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE, plugin.security.authBootstrapMode));
  const acpAllowedAgents = options.acpAllowedAgent?.length
    ? assertSupportedAcpAgentList(uniqueStrings(options.acpAllowedAgent), "--acp-allowed-agent")
    : assertSupportedAcpAgentList(
        parseFlexibleArray(localEnv.OPENCLAW_ACP_ALLOWED_AGENTS, plugin.acp.allowedAgents),
        String(localEnv.OPENCLAW_ACP_ALLOWED_AGENTS ?? "").trim() ? "OPENCLAW_ACP_ALLOWED_AGENTS" : "acp.allowedAgents"
      );

  const manifestSeed = deepMerge(plugin, {
    projectName: localOverrideValue(options.projectName, localEnv.OPENCLAW_PROJECT_NAME, plugin.projectName),
    repoPath: repoRoot,
    deploymentProfile,
    toolingProfile,
    runtimeProfile,
    queueProfile,
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

function buildRuntimeEnv(context, plugin, manifest, localEnv, detectedCodexAuthPath = "") {
  const gatewayPort = localEnv.OPENCLAW_GATEWAY_PORT || String(LEGACY_COMPOSE_PORT);
  const controlUiOrigins = localEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS
    || JSON.stringify([`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`]);
  const effectiveTargetAuthPath = String(localEnv.TARGET_AUTH_PATH ?? "").trim() || detectedCodexAuthPath;
  const targetAuthPath = effectiveTargetAuthPath
    ? path.resolve(effectiveTargetAuthPath.replace(/\//g, path.sep))
    : "";
  const telegramTokenHash = fingerprintTelegramBotToken(localEnv.TELEGRAM_BOT_TOKEN);

  return {
    OPENCLAW_COMPOSE_PROJECT_NAME: context.composeProjectName,
    OPENCLAW_INSTANCE_ID: context.instanceId,
    OPENCLAW_PRODUCT_ROOT: toDockerPath(context.productRoot),
    OPENCLAW_PRODUCT_NAME: PRODUCT_NAME,
    OPENCLAW_PRODUCT_VERSION: PRODUCT_VERSION,
    OPENCLAW_STACK_IMAGE: context.localRuntimeImage,
    OPENCLAW_IMAGE: localEnv.OPENCLAW_IMAGE || DEFAULT_OPENCLAW_IMAGE,
    OPENCLAW_AGENT_NPM_PACKAGES: localEnv.OPENCLAW_AGENT_NPM_PACKAGES || "",
    OPENCLAW_AGENT_INSTALL_COMMAND: localEnv.OPENCLAW_AGENT_INSTALL_COMMAND || "",
    OPENCLAW_TOOLING_INSTALL_COMMAND: localEnv.OPENCLAW_TOOLING_INSTALL_COMMAND || "",
    OPENCLAW_EFFECTIVE_TOOLING_PROFILE: manifest.toolingProfile,
    OPENCLAW_GATEWAY_PORT: gatewayPort,
    OPENCLAW_GATEWAY_BIND: localEnv.OPENCLAW_GATEWAY_BIND || "lan",
    OPENCLAW_GATEWAY_TOKEN: localEnv.OPENCLAW_GATEWAY_TOKEN || randomToken(),
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: controlUiOrigins,
    OPENCLAW_REPO_ROOT_HOST: toDockerPath(context.repoRoot),
    OPENCLAW_TELEGRAM_TOKEN_HASH: telegramTokenHash,
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
    OPENCLAW_PROJECT_NAME: manifest.projectName,
    OPENCLAW_RUNTIME_PROFILE: manifest.runtimeProfile,
    OPENCLAW_QUEUE_PROFILE: manifest.queueProfile,
    OPENCLAW_DEPLOYMENT_PROFILE: manifest.deploymentProfile,
    OPENCLAW_VERIFICATION_COMMANDS: JSON.stringify(manifest.verificationCommands),
    OPENCLAW_TELEGRAM_THREAD_BINDINGS_SPAWN_ACP: String(Boolean(manifest.telegram.threadBindings?.spawnAcpSessions)),
    TARGET_REPO_PATH: toDockerPath(context.repoRoot),
    TARGET_AUTH_PATH: targetAuthPath ? toDockerPath(targetAuthPath) : ""
  };
}

async function dockerCompose(context, args, options = {}) {
  const commandArgs = [
    "compose",
    "--project-name",
    context.composeProjectName,
    "-f",
    context.paths.composeFile,
    "--env-file",
    context.paths.runtimeEnvFile,
    ...args
  ];
  const result = await safeRunCommand("docker", commandArgs, {
    cwd: context.repoRoot,
    timeoutMs: options.timeoutMs
  });
  if (options.capture) return result;
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      `docker compose ${args.join(" ")}`,
      result,
      `Failed to run docker compose ${args.join(" ")}.`
    ));
  }
  return result;
}

function buildComposeUpArgs() {
  return ["up", "-d", "--wait", "--wait-timeout", "90", "--force-recreate"];
}

async function ensureLocalRuntimeImageBuilt(context) {
  await dockerCompose(context, ["build", "--pull", "openclaw-gateway"]);
}

async function openclawHostCommand(context, args, options = {}) {
  let result;
  try {
    result = await safeRunCommand("openclaw", args, { cwd: context.repoRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|is not recognized|ENOENT/i.test(message)) {
      throw new Error("Host OpenClaw CLI is required for --gateway-url pairing. Install `openclaw` locally and retry.");
    }
    throw error;
  }
  if (options.capture) return result;
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      `openclaw ${args.join(" ")}`,
      result,
      `Failed to run openclaw ${args.join(" ")}.`
    ));
  }
  return result;
}

async function openclawGatewayCommand(context, args, options = {}) {
  return await dockerCompose(context, ["exec", "-T", "openclaw-gateway", "openclaw", ...args], options);
}

function normalizePendingDeviceRequests(payload) {
  const pending = Array.isArray(payload?.pending) ? payload.pending : [];
  return pending
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      requestId: String(entry.requestId ?? entry.request_id ?? "").trim(),
      clientId: String(entry.clientId ?? entry.client_id ?? "").trim(),
      clientMode: String(entry.clientMode ?? entry.client_mode ?? "").trim(),
      role: String(entry.role ?? "").trim(),
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : 0
    }))
    .filter((entry) => entry.requestId);
}

export function selectLatestPendingDeviceRequest(payload) {
  const requests = normalizePendingDeviceRequests(payload);
  if (requests.length === 0) return null;
  return requests.reduce((latest, current) => current.ts >= latest.ts ? current : latest);
}

async function probeTelegramBotToken(token) {
  return await new Promise((resolve) => {
    const request = https.get(`https://api.telegram.org/bot${token}/getMe`, {
      timeout: 5000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const payload = parseJsonOutput(body, null);
        resolve({
          statusCode: response.statusCode ?? 0,
          payload,
          ...classifyTelegramBotProbeResult(response.statusCode ?? 0, payload)
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Telegram Bot API probe timed out."));
    });

    request.on("error", (error) => {
      resolve({
        statusCode: 0,
        payload: null,
        ok: false,
        definitiveFailure: false,
        detail: error.message
      });
    });
  });
}

async function ensureTelegramBotTokenReady(context, state) {
  if (!state.manifest.telegram.enabled) return;

  const token = String(state.localEnv.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!hasConfiguredTelegramBotToken(token)) {
    throw new Error(`Telegram bot token is missing. Set TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }
  if (!looksLikeTelegramBotToken(token)) {
    throw new Error(`Telegram bot token format looks invalid. Update TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }

  const probe = await probeTelegramBotToken(token);
  if (probe.definitiveFailure) {
    throw new Error(`Telegram bot token was rejected by the Telegram Bot API${probe.detail ? ` (${probe.detail})` : ""}. Update TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }
}

function extractDashboardUrl(output) {
  const match = String(output ?? "").match(/https?:\/\/\S+/);
  return match ? match[0].trim() : "";
}

async function resolveDashboardUrl(context) {
  const result = await openclawGatewayCommand(context, ["dashboard", "--no-open"], { capture: true });
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw dashboard --no-open",
      result,
      "Failed to resolve the dashboard URL."
    ));
  }

  const dashboardUrl = extractDashboardUrl([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (!dashboardUrl) {
    throw new Error("Failed to resolve the dashboard URL.");
  }
  return dashboardUrl;
}

async function gatewayRunning(context) {
  try {
    const result = await dockerCompose(context, ["ps", "-q", "openclaw-gateway"], { capture: true });
    return result.code === 0 && Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}

async function dockerPsByComposeProject(projectName, options = {}) {
  const args = [
    "ps",
    ...(options.all ? ["-a"] : []),
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--format",
    "{{.Names}}|{{.Status}}"
  ];
  const result = await safeRunCommand("docker", args, { cwd: options.cwd ?? process.cwd() });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, status] = line.split("|");
      return {
        name: String(name ?? "").trim(),
        status: String(status ?? "").trim()
      };
    });
}

async function canBindPort(port) {
  try {
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function detectLegacyComposeProject(context) {
  if (!context.legacyComposeProjectName || context.legacyComposeProjectName === context.composeProjectName) {
    return [];
  }
  return await dockerPsByComposeProject(context.legacyComposeProjectName, {
    all: true,
    cwd: context.repoRoot
  });
}

async function detectGatewayPortState(context, localEnv) {
  const gatewayPort = Number.parseInt(String(localEnv.OPENCLAW_GATEWAY_PORT ?? "").trim(), 10);
  if (!Number.isInteger(gatewayPort)) {
    return {
      ok: false,
      gatewayPort: null,
      portBindable: false,
      duplicateAssignment: null,
      message: "Gateway port is not configured."
    };
  }

  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const duplicateAssignment = listInstanceRegistryEntries(registry).find((entry) =>
    entry.instanceId !== context.instanceId && Number.parseInt(entry.gatewayPort, 10) === gatewayPort
  ) ?? null;
  if (duplicateAssignment) {
    return {
      ok: false,
      gatewayPort,
      portBindable: false,
      duplicateAssignment,
      message: `Gateway port ${gatewayPort} is already assigned to ${duplicateAssignment.instanceId}.`
    };
  }

  if (await gatewayRunning(context)) {
    return {
      ok: true,
      gatewayPort,
      portBindable: true,
      duplicateAssignment: null,
      message: `Gateway port ${gatewayPort} is already in use by this repo's running gateway.`
    };
  }

  const portBindable = await canBindPort(gatewayPort);
  return {
    ok: portBindable,
    gatewayPort,
    portBindable,
    duplicateAssignment: null,
    message: portBindable
      ? `Gateway port ${gatewayPort} is available.`
      : `Gateway port ${gatewayPort} is already bound by another process.`
  };
}

function findRegisteredTelegramTokenConflicts(context, registry, localEnv) {
  const tokenHash = fingerprintTelegramBotToken(localEnv.TELEGRAM_BOT_TOKEN);
  if (!tokenHash) return [];
  return listInstanceRegistryEntries(registry).filter((entry) =>
    entry.instanceId !== context.instanceId && entry.telegramTokenHash === tokenHash
  );
}

async function findRunningTelegramTokenConflicts(context, localEnv) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const candidates = findRegisteredTelegramTokenConflicts(context, registry, localEnv);
  const running = [];

  for (const entry of candidates) {
    const containers = await dockerPsByComposeProject(entry.composeProjectName, {
      all: false,
      cwd: context.repoRoot
    });
    if (containers.length > 0) {
      running.push({
        ...entry,
        containers
      });
    }
  }

  return running;
}

async function rerenderIfRunning(context) {
  if (!(await gatewayRunning(context))) return;
  await dockerCompose(context, ["exec", "openclaw-gateway", "node", "/opt/openclaw/render-openclaw-config.mjs"]);
}

async function prepareState(context, options = {}) {
  const configRaw = await readJsonFile(context.paths.configFile, null);
  if (!configRaw) {
    throw new Error(`Missing ${context.paths.configFile}. Run ${PRODUCT_NAME} init first.`);
  }

  const plugin = normalizePluginConfig(configRaw, context.repoRoot, context.detection, options);
  const secrets = await readEnvFile(context.paths.secretsEnvFile);
  const ensuredInstance = await ensureInstanceLocalEnv(context, {}, options);
  const localEnv = {
    OPENCLAW_IMAGE: DEFAULT_OPENCLAW_IMAGE,
    OPENCLAW_AGENT_NPM_PACKAGES: "",
    OPENCLAW_AGENT_INSTALL_COMMAND: "",
    OPENCLAW_TOOLING_INSTALL_COMMAND: "",
    ...secrets,
    ...ensuredInstance.localEnv
  };
  const detectedCodexAuthPath = await detectDefaultCodexAuthPath();
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, {}, options);
  const validationErrors = validateProjectManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Config is invalid: ${validationErrors.join("; ")}`);
  }

  await ensureDir(context.paths.stateDir);
  const runtimeEnv = buildRuntimeEnv(context, plugin, manifest, localEnv, detectedCodexAuthPath);
  await writeTextFile(context.paths.composeFile, renderComposeTemplate({
    includeAuthMount: Boolean(String(runtimeEnv.TARGET_AUTH_PATH ?? "").trim()),
  }));
  await writeEnvFile(context.paths.runtimeEnvFile, runtimeEnv);

  return {
    plugin,
    localEnv,
    manifest,
    runtimeEnv,
    detectedCodexAuthPath,
    instanceRegistry: ensuredInstance.registry
  };
}

function capitalizeSentence(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatAgentSummary(acpDefaultAgent, manifest, localEnv = {}) {
  const agent = String(acpDefaultAgent ?? "").trim();
  if (!agent) return "";
  if (agent !== "codex") return agent;
  const agentLabel = "Codex";
  if (manifest?.security?.authBootstrapMode !== "codex") return `${agentLabel} (external auth)`;
  const apiKey = String(localEnv.OPENAI_API_KEY ?? "").trim();
  if (apiKey) return `${agentLabel} (OpenAI API key)`;
  return `${agentLabel} (OpenAI subscription login)`;
}

function buildPreparedSection(items) {
  return buildStatusSection("Files", "success", items.map((item) => ({
    status: "success",
    text: item
  })));
}

function buildNextStepsSection(items) {
  return buildStatusSection("Next steps", "info", items.map((item) => {
    if (typeof item === "string") {
      return {
        status: "info",
        icon: "›",
        text: item
      };
    }
    return {
      status: item?.status || "info",
      icon: item?.icon || "›",
      text: item?.text || ""
    };
  }));
}

function buildDashboardUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

function summarizeDoctorResults(results) {
  return results.reduce((summary, result) => {
    if (result.ok) {
      summary.ok += 1;
      return summary;
    }
    if (result.level === "info") summary.info += 1;
    else if (result.level === "warning") summary.warn += 1;
    else summary.fail += 1;
    return summary;
  }, { ok: 0, info: 0, warn: 0, fail: 0 });
}

async function promptRequired(prompter, label, fallback = "", options = {}) {
  if (typeof prompter?.input === "function" || typeof prompter?.password === "function") {
    return options.secret
      ? await prompter.password(label, fallback, { required: true })
      : await prompter.input(label, fallback, { required: true });
  }

  while (true) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await prompter.question(`${label}${suffix}: `)).trim() || fallback;
    if (answer) return answer;
    console.log(`${renderStatusMarker("warning")} ${label} is required.`);
  }
}

async function promptOptional(prompter, label, fallback = "", options = {}) {
  if (typeof prompter?.input === "function" || typeof prompter?.password === "function") {
    return options.secret
      ? await prompter.password(label, fallback, { required: false })
      : await prompter.input(label, fallback, { required: false });
  }

  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await prompter.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

export async function promptChoice(prompter, label, choices, fallbackValue) {
  if (typeof prompter?.select === "function") {
    return await prompter.select(label, choices, fallbackValue);
  }

  const defaultIndex = Math.max(choices.findIndex((choice) => choice.value === fallbackValue), 0);
  console.log("");
  console.log(`${renderStatusMarker("info")} ${label}`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label}${index === defaultIndex ? " (default)" : ""}`);
  });

  while (true) {
    const answer = (await prompter.question(`Choose ${label.toLowerCase()} [${defaultIndex + 1}]: `)).trim();
    if (!answer) return choices[defaultIndex].value;

    const numericIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= choices.length) {
      return choices[numericIndex - 1].value;
    }

    const exact = choices.find((choice) => choice.value === answer);
    if (exact) return exact.value;

    console.log(`${renderStatusMarker("warning")} Enter a number between 1 and ${choices.length}, or one of: ${choices.map((choice) => choice.value).join(", ")}.`);
  }
}

export function defaultCodexAuthSource(existingLocalEnv, options, detectedCodexAuthPath = "") {
  if (String(options.targetAuthPath ?? "").trim()) return "auth-folder";
  if (String(options.openaiApiKey ?? "").trim()) return "api-key";

  const existingTargetAuthPath = String(existingLocalEnv.TARGET_AUTH_PATH ?? "").trim() || detectedCodexAuthPath;
  if (existingTargetAuthPath) return "auth-folder";
  if (String(existingLocalEnv.OPENAI_API_KEY ?? "").trim()) return "api-key";
  return "auth-folder";
}

export async function collectInitPromptState(prompter, context, plugin, existingLocalEnv, options, detectedCodexAuthPath = "") {
  const profile = plugin.profile;
  const projectName = plugin.projectName;
  const toolingProfile = plugin.toolingProfile;
  const deploymentProfile = plugin.deploymentProfile;
  const runtimeProfile = plugin.runtimeProfile;
  const queueProfile = plugin.queueProfile;
  const verificationCommands = plugin.verificationCommands;

  const acpDefaultAgent = await promptChoice(prompter, "ACP default agent", ACP_AGENT_CHOICES, plugin.acp.defaultAgent || "codex");
  let openAiApiKey = String(existingLocalEnv.OPENAI_API_KEY ?? "");
  let targetAuthPath = String(existingLocalEnv.TARGET_AUTH_PATH ?? "") || detectedCodexAuthPath;
  let authMode = resolvePreferredAuthMode(plugin.security.authBootstrapMode, acpDefaultAgent);

  if (acpDefaultAgent === "codex") {
    const authSource = await promptChoice(
      prompter,
      "codex auth source",
      CODEX_AUTH_SOURCE_CHOICES,
      defaultCodexAuthSource(existingLocalEnv, options, detectedCodexAuthPath)
    );

    authMode = "codex";
    if (authSource === "auth-folder") {
      openAiApiKey = "";
        if (!targetAuthPath) {
          targetAuthPath = await promptRequired(prompter, "OpenAI subscription login folder");
        }
    } else {
      targetAuthPath = "";
      openAiApiKey = String(existingLocalEnv.OPENAI_API_KEY ?? "");
      if (!openAiApiKey) {
        openAiApiKey = await promptRequired(prompter, "OpenAI API key", "", { secret: true });
      }
    }
  } else {
    authMode = "external";
  }

  const hasTelegramToken = Boolean(existingLocalEnv.TELEGRAM_BOT_TOKEN) && !String(existingLocalEnv.TELEGRAM_BOT_TOKEN).startsWith("replace-with-");
  const telegramBotTokenInput = hasTelegramToken
    ? ""
    : await promptOptional(prompter, "Telegram bot token", "", { secret: true });

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
    verificationCommand: verificationCommands
  });

  const currentAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, []);
  const currentGroupAllowUsers = parseFlexibleArray(existingLocalEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, []);
  return {
    plugin: nextPlugin,
    localEnv: {
      TELEGRAM_BOT_TOKEN: telegramBotTokenInput || (hasTelegramToken ? existingLocalEnv.TELEGRAM_BOT_TOKEN : "replace-with-your-botfather-token"),
      OPENCLAW_TELEGRAM_ALLOW_FROM: JSON.stringify(currentAllowUsers),
      OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: JSON.stringify(currentGroupAllowUsers),
      OPENAI_API_KEY: authMode === "codex" ? openAiApiKey : "",
      TARGET_AUTH_PATH: authMode === "codex" && targetAuthPath ? toDockerPath(path.resolve(targetAuthPath)) : ""
    }
  };
}

async function promptForInit(context, plugin, existingLocalEnv, options, detectedCodexAuthPath = "") {
  if (options.yes || options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { plugin, localEnv: {} };
  }

  return await collectInitPromptState(
    createInteractivePrompter(),
    context,
    plugin,
    existingLocalEnv,
    options,
    detectedCodexAuthPath
  );
}

async function handleInit(context, options) {
  await ensureDir(context.paths.openclawDir);
  const existingConfig = await readJsonFile(context.paths.configFile, null);
  const existingSecrets = await readEnvFile(context.paths.secretsEnvFile);
  const existingLocalEnv = {
    ...existingSecrets,
    ...(existingConfig?.telegram
      ? {
          OPENCLAW_TELEGRAM_ALLOW_FROM: JSON.stringify(existingConfig.telegram.allowFrom ?? []),
          OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM: JSON.stringify(existingConfig.telegram.groupAllowFrom ?? []),
        }
      : {}),
  };
  const detectedCodexAuthPath = await detectDefaultCodexAuthPath();
  const basePlugin = normalizePluginConfig(existingConfig ?? {}, context.repoRoot, context.detection, options);
  const initState = existingConfig && !options.force
    ? { plugin: basePlugin, localEnv: {} }
    : await promptForInit(context, basePlugin, existingLocalEnv, options, detectedCodexAuthPath);
  const plugin = initState.plugin;

  if (!plugin.acp.defaultAgent) {
    throw new Error("ACP default agent is required. Pass --acp-default-agent in non-interactive mode or rerun init interactively.");
  }

  const manifest = buildEffectiveManifest(plugin, context.repoRoot, initState.localEnv, options);
  const validationErrors = validateProjectManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(`Cannot initialize workspace: ${validationErrors.join("; ")}`);
  }

  const shouldWriteConfig = !existingConfig || options.force || JSON.stringify(existingConfig) !== JSON.stringify(plugin);
  const configStatus = path.relative(context.repoRoot, context.paths.configFile);
  if (shouldWriteConfig) {
    await writeJsonFile(context.paths.configFile, plugin);
  }

  if (!(await fileExists(context.paths.instructionsFile)) || options.force) {
    await writeTextFile(context.paths.instructionsFile, defaultInstructionsTemplate(plugin.projectName));
  }

  const secretsToWrite = {
    TELEGRAM_BOT_TOKEN: initState.localEnv.TELEGRAM_BOT_TOKEN ?? existingSecrets.TELEGRAM_BOT_TOKEN ?? "replace-with-your-botfather-token",
    OPENAI_API_KEY: initState.localEnv.OPENAI_API_KEY ?? existingSecrets.OPENAI_API_KEY ?? "",
    TARGET_AUTH_PATH: initState.localEnv.TARGET_AUTH_PATH ?? existingSecrets.TARGET_AUTH_PATH ?? "",
  };
  if (!(await fileExists(context.paths.secretsEnvFile)) || options.force) {
    await writeEnvFile(context.paths.secretsEnvFile, secretsToWrite, SECRETS_ENV_HEADER);
  }

  await ensureGitExcludeEntries(context.repoRoot);
  const state = await runWithSpinner("Preparing workspace state", () => prepareState(context, options), options);
  const registeredConflicts = findRegisteredTelegramTokenConflicts(context, state.instanceRegistry, state.localEnv);

  printCommandReport("success", "Init complete", [
    { label: "Repo", value: context.repoRoot },
    { label: "Gateway", value: buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) },
    { label: "Agent", value: formatAgentSummary(plugin.acp.defaultAgent, state.manifest, state.localEnv) }
  ], [
    buildPreparedSection([
      configStatus,
      path.relative(context.repoRoot, context.paths.secretsEnvFile),
      path.relative(context.repoRoot, context.paths.runtimeEnvFile),
      path.relative(context.repoRoot, context.paths.composeFile)
    ]),
    buildStatusSection("Warnings", "warning", registeredConflicts.length > 0
      ? [`This Telegram bot token is also configured in ${registeredConflicts.length} other registered repo instance(s).`]
      : []),
    buildNextStepsSection([
      `Run '${PRODUCT_NAME} up' to start the OpenClaw gateway for this repo.`
    ])
  ].filter(Boolean), {
    summaryTitle: "Configuration"
  });
}

async function handleConfigValidate(context, options) {
  const pluginRaw = await readJsonFile(context.paths.configFile, null);
  if (!pluginRaw) throw new Error(`Missing ${context.paths.configFile}`);
  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, {}, options);
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
    printCommandReport(errors.length === 0 ? "success" : "error", "Configuration validation", [
      { label: "Plugin profile", value: plugin.profile },
      { label: "Project", value: plugin.projectName },
      { label: "Deployment", value: plugin.deploymentProfile },
      { label: "Validation", value: errors.length === 0 ? "ok" : "failed" }
    ], [
      buildStatusSection("Errors", "error", errors)
    ].filter(Boolean));
  }

  if (errors.length > 0) process.exitCode = 1;
}

async function handleConfigMigrate(context, options) {
  const pluginRaw = await readJsonFile(context.paths.configFile, null);
  if (!pluginRaw) throw new Error(`Missing ${context.paths.configFile}`);
  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  await writeJsonFile(context.paths.configFile, plugin);
  printCommandReport("success", "Configuration migrated", [
    { label: "File", value: path.relative(context.repoRoot, context.paths.configFile) },
    { label: "Version", value: plugin.version }
  ]);
}

async function handleUp(context, options) {
  let state = await runWithSpinner("Preparing runtime state", () => prepareState(context, options), options);
  if (state.manifest.deploymentProfile === "native-dev") {
    printCommandReport("success", "Up complete", [
      { label: "Repo", value: context.repoRoot },
      { label: "Deployment", value: "native-dev" },
      { label: "Manifest", value: path.relative(context.repoRoot, context.paths.runtimeEnvFile) }
    ], [
      buildNextStepsSection([
        `Use ${path.relative(context.repoRoot, context.paths.runtimeEnvFile)} with the official OpenClaw onboarding flow.`
      ])
    ].filter(Boolean));
    return;
  }

  const portState = await detectGatewayPortState(context, state.localEnv);
  if (!portState.ok) {
    throw new Error(`${portState.message} Run \`${PRODUCT_NAME} up --reassign-port\` or \`${PRODUCT_NAME} doctor --fix\`.`);
  }
  const runningTokenConflicts = await findRunningTelegramTokenConflicts(context, state.localEnv);
  if (runningTokenConflicts.length > 0) {
    const details = runningTokenConflicts
      .map((entry) => `${entry.instanceId} (${entry.repoRoot})`)
      .join(", ");
    throw new Error(`Telegram bot token is already in use by another running repo instance: ${details}. Use a separate bot token per repo.`);
  }
  await runWithSpinner("Validating Telegram bot token", () => ensureTelegramBotTokenReady(context, state), options);
  await runWithSpinner("Building local runtime image", () => ensureLocalRuntimeImageBuilt(context), options);
  await runWithSpinner("Starting OpenClaw stack", () => dockerCompose(context, buildComposeUpArgs()), options);
  const dashboardUrl = await runWithSpinner("Resolving dashboard URL", () => resolveDashboardUrl(context), options);
  printCommandReport("success", "Up complete", [
    { label: "Repo", value: context.repoRoot },
    { label: "Dashboard", value: dashboardUrl },
    { label: "Deployment", value: state.manifest.deploymentProfile },
    { label: "Runtime image", value: context.localRuntimeImage }
  ]);
}

async function handleDown(context) {
  await prepareState(context);
  await dockerCompose(context, ["down"]);
  printCommandReport("success", "Down complete", [
    { label: "Instance", value: context.instanceId },
    { label: "Compose", value: context.composeProjectName },
    { label: "Result", value: "OpenClaw gateway stopped" }
  ]);
}

async function handleVerify(context, options) {
  const state = await prepareState(context, options);
  if (!(await gatewayRunning(context))) {
    throw new Error("OpenClaw gateway is not running. Start it with openclaw-repo-agent up first.");
  }
  if (state.manifest.verificationCommands.length === 0) {
    throw new Error(`No verification commands are configured in ${context.paths.configFile}.`);
  }
  const completedCommands = [];
  for (const command of state.manifest.verificationCommands) {
    await dockerCompose(context, ["exec", "openclaw-gateway", "sh", "-lc", command]);
    completedCommands.push(command);
  }
  printCommandReport("success", "Verification complete", [
    { label: "Repo", value: context.repoRoot },
    { label: "Project", value: state.manifest.projectName },
    { label: "Instance", value: context.instanceId },
    { label: "Gateway", value: buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) },
    { label: "Result", value: "Verification commands completed" }
  ], [
    buildStatusSection("Commands", "success", completedCommands)
  ].filter(Boolean));
}

function createPairTargetResult(target, action, approved, requestCode, detail) {
  return {
    target,
    action,
    approved,
    requestCode,
    detail
  };
}

function pairTargetLabel(target) {
  switch (target) {
    case "gateway-device":
      return "Gateway device";
    case "telegram":
      return "Telegram DM";
    case "external-device":
      return "External device";
    default:
      return capitalizeSentence(String(target ?? "").replace(/-/g, " "));
  }
}

function summarizePairTargets(mode, targets = []) {
  const normalizedTargets = targets.filter(Boolean);
  const approvedCount = normalizedTargets.filter((target) => target.approved).length;
  const requestCodes = normalizedTargets.map((target) => target.requestCode).filter(Boolean);

  return {
    mode,
    action: approvedCount === 0
      ? "listed"
      : normalizedTargets.some((target) => target.action === "approved")
        ? `approved ${approvedCount} request${approvedCount === 1 ? "" : "s"}`
        : `auto-approved ${approvedCount} request${approvedCount === 1 ? "" : "s"}`,
    approved: approvedCount > 0,
    requestCode: requestCodes.join(", "),
    detail: approvedCount > 0
      ? `Approved ${approvedCount} pending pairing request${approvedCount === 1 ? "" : "s"}.`
      : "No pending pairing request was approved.",
    targets: normalizedTargets
  };
}

function buildPairDetailsSection(targets = []) {
  return buildStatusSection("Details", "info", targets.map((target) => `${pairTargetLabel(target.target)}: ${target.detail}`));
}

function isUnknownLocalPairRequest(result) {
  const message = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  return /unknown requestid|not found|no pending|invalid request/i.test(message);
}

async function approveLocalDevicePair(context, requestId, options = {}) {
  const approveResult = await openclawGatewayCommand(context, ["devices", "approve", requestId], { capture: true });
  if (approveResult.code !== 0) {
    if (options.allowMissing && isUnknownLocalPairRequest(approveResult)) return null;
    throw new Error(summarizeCommandFailure(
      "openclaw devices approve",
      approveResult,
      `Failed to approve local gateway device pairing request ${requestId}.`
    ));
  }

  return createPairTargetResult(
    "gateway-device",
    "approved",
    true,
    requestId,
    `Approved gateway device pairing request ${requestId}.`
  );
}

async function autoApproveLocalDevicePair(context) {
  const pendingResult = await openclawGatewayCommand(context, ["devices", "list", "--json"], { capture: true });
  if (pendingResult.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw devices list",
      pendingResult,
      "Failed to read gateway device pairing requests."
    ));
  }

  const request = selectLatestPendingDeviceRequest(parseJsonOutput(pendingResult.stdout, null));
  if (!request?.requestId) {
    return createPairTargetResult(
      "gateway-device",
      "listed",
      false,
      "",
      "No pending gateway device pairing request was found."
    );
  }

  const approved = await approveLocalDevicePair(context, request.requestId);
  return {
    ...approved,
    action: "auto-approved"
  };
}

async function approveLocalTelegramPair(context, requestCode, options = {}) {
  const approveResult = await openclawGatewayCommand(context, ["pairing", "approve", "telegram", requestCode], { capture: true });
  if (approveResult.code !== 0) {
    if (options.allowMissing && isUnknownLocalPairRequest(approveResult)) return null;
    throw new Error(summarizeCommandFailure(
      "openclaw pairing approve telegram",
      approveResult,
      `Failed to approve local Telegram pairing request ${requestCode}.`
    ));
  }

  return createPairTargetResult(
    "telegram",
    "approved",
    true,
    requestCode,
    `Approved Telegram pairing request ${requestCode}.`
  );
}

async function autoApproveLocalTelegramPair(context) {
  const pendingResult = await openclawGatewayCommand(context, ["pairing", "list", "telegram", "--json"], { capture: true });
  if (pendingResult.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw pairing list telegram",
      pendingResult,
      "Failed to read Telegram pairing requests."
    ));
  }

  let payload = null;
  try {
    payload = JSON.parse(pendingResult.stdout || "null");
  } catch {
    payload = null;
  }

  const request = selectLatestPendingPairingRequest(payload);
  if (!request?.code) {
    return createPairTargetResult(
      "telegram",
      "listed",
      false,
      "",
      "No pending Telegram pairing request was found."
    );
  }

  const approved = await approveLocalTelegramPair(context, request.code);
  return {
    ...approved,
    action: "auto-approved"
  };
}

async function handleExternalGatewayPair(context, options) {
  const gatewayArgs = buildExternalGatewayAuthArgs(options);
  if (options.approve) {
    await openclawHostCommand(context, ["devices", "approve", options.approve, ...gatewayArgs]);
    return createPairTargetResult(
      "external-device",
      "approved",
      true,
      options.approve,
      `Approved external device pairing request ${options.approve}.`
    );
  }

  const approveLatest = await openclawHostCommand(context, ["devices", "approve", "--latest", ...gatewayArgs], { capture: true });
  if (approveLatest.code === 0) {
    return createPairTargetResult(
      "external-device",
      "auto-approved",
      true,
      "",
      "Approved the latest pending external device pairing request."
    );
  }

  const list = await openclawHostCommand(context, ["devices", "list", ...(options.json ? ["--json"] : []), ...gatewayArgs], { capture: true });
  if (list.code === 0) {
    return createPairTargetResult(
      "external-device",
      "listed",
      false,
      "",
      "No external device pairing request was auto-approved."
    );
  }

  const reason = summarizeCommandFailure(
    "openclaw devices approve --latest",
    approveLatest.code !== 0 ? approveLatest : list,
    "Failed to pair against the external OpenClaw gateway."
  );
  if (/not found|is not recognized|ENOENT/i.test(reason)) {
    throw new Error("Host OpenClaw CLI is required for --gateway-url pairing. Install `openclaw` locally and retry.");
  }
  throw new Error(reason);
}

async function handlePair(context, options) {
  validateExternalGatewayPairOptions(options);
  await prepareState(context, options);
  const localEnv = await readEnvFile(context.paths.secretsEnvFile);
  let pairResult = summarizePairTargets(isExternalGatewayPairMode(options) ? "external" : "local", []);

  if (isExternalGatewayPairMode(options)) {
    pairResult = summarizePairTargets("external", [await handleExternalGatewayPair(context, options)]);
  } else {
    if (!(await gatewayRunning(context))) {
      throw new Error("OpenClaw gateway is not running. Start it with openclaw-repo-agent up first.");
    }

    if (options.approve) {
      const devicePairResult = await approveLocalDevicePair(context, options.approve, { allowMissing: true });
      pairResult = summarizePairTargets("local", [
        devicePairResult || await approveLocalTelegramPair(context, options.approve)
      ]);
    } else {
      pairResult = summarizePairTargets("local", [
        await autoApproveLocalDevicePair(context),
        await autoApproveLocalTelegramPair(context)
      ]);
    }
  }

  if ((options.allowUser?.length ?? 0) === 0
    && (options.groupAllowUser?.length ?? 0) === 0
    && !options.switchDmPolicy
    && !options.switchGroupPolicy) {
    printCommandReport(pairResult.approved ? "success" : "info", "Pairing complete", [
      { label: "Action", value: pairResult.action },
      { label: "Request", value: pairResult.requestCode || "(latest or none)" },
      { label: "Result", value: pairResult.detail }
    ], [
      buildPairDetailsSection(pairResult.targets)
    ].filter(Boolean));
    return;
  }

  const config = await readJsonFile(context.paths.configFile, {});
  const currentAllowFrom = config.telegram?.allowFrom ?? parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_ALLOW_FROM, []);
  const currentGroupAllowFrom = config.telegram?.groupAllowFrom ?? parseFlexibleArray(localEnv.OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM, []);
  const nextAllowFrom = normalizePrincipalArray([...currentAllowFrom, ...(options.allowUser ?? [])]);
  const nextGroupAllowFrom = normalizePrincipalArray([...currentGroupAllowFrom, ...(options.groupAllowUser ?? [])]);
  const nextDmPolicy = options.switchDmPolicy || config.telegram?.dmPolicy || "pairing";
  const nextGroupPolicy = options.switchGroupPolicy || config.telegram?.groupPolicy || "disabled";
  const settingsChanged = JSON.stringify(nextAllowFrom) !== JSON.stringify(currentAllowFrom)
    || JSON.stringify(nextGroupAllowFrom) !== JSON.stringify(currentGroupAllowFrom)
    || nextDmPolicy !== (config.telegram?.dmPolicy || "pairing")
    || nextGroupPolicy !== (config.telegram?.groupPolicy || "disabled");

  const nextConfig = {
    ...config,
    telegram: {
      ...config.telegram,
      allowFrom: nextAllowFrom,
      groupAllowFrom: nextGroupAllowFrom,
      dmPolicy: nextDmPolicy,
      groupPolicy: nextGroupPolicy,
    },
  };
  await writeJsonFile(context.paths.configFile, nextConfig);
  await prepareState(context, options);
  await rerenderIfRunning(context);
  printCommandReport(pairResult.approved || settingsChanged ? "success" : "info", "Pairing settings updated", [
    { label: "Action", value: pairResult.action },
    { label: "Request", value: pairResult.requestCode || "(latest or none)" },
    { label: "Allowlists", value: "updated" },
    { label: "DM policy", value: nextDmPolicy },
    { label: "Group policy", value: nextGroupPolicy }
  ], [
    buildPairDetailsSection(pairResult.targets)
  ].filter(Boolean));
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
  const packageName = process.env.NPM_PACKAGE_NAME || PRODUCT_NAME;
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
    instance: {
      instanceId: context.instanceId,
      composeProjectName: context.composeProjectName,
      legacyComposeProjectName: context.legacyComposeProjectName,
      gatewayPort: state.localEnv.OPENCLAW_GATEWAY_PORT,
      portManaged: shouldManageGatewayPort(state.localEnv),
      localRuntimeImage: context.localRuntimeImage
    },
    manifest: {
      projectName: state.manifest.projectName,
      deploymentProfile: state.manifest.deploymentProfile,
      toolingProfile: state.manifest.toolingProfile,
      runtimeProfile: state.manifest.runtimeProfile,
      queueProfile: state.manifest.queueProfile,
      authMode: state.manifest.security.authBootstrapMode,
      verificationCommands: state.manifest.verificationCommands
    },
    runtime: {
      legacyComposeProjectDetected: false
    }
  };
  const legacyContainers = await detectLegacyComposeProject(context);
  payload.runtime.legacyComposeProjectDetected = legacyContainers.length > 0;

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printCommandReport("success", "Status", [
      { label: "Version", value: PRODUCT_VERSION },
      { label: "Update", value: updateStatus },
      { label: "Repo", value: context.repoRoot },
      { label: "Gateway", value: running ? buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) : "stopped" },
      { label: "Profiles", value: `${state.manifest.deploymentProfile} / ${state.manifest.toolingProfile} / ${state.manifest.runtimeProfile} / ${state.manifest.queueProfile}` },
      { label: "Auth", value: state.manifest.security.authBootstrapMode }
    ], [
      buildStatusSection("Verification", "info", state.manifest.verificationCommands.length > 0
        ? state.manifest.verificationCommands
        : ["No verification commands configured."]),
      buildStatusSection("Warnings", "warning", legacyContainers.length > 0
        ? [`Legacy compose project detected: ${context.legacyComposeProjectName}`]
        : [])
    ].filter(Boolean));
  }
}

function pushCheck(results, key, ok, detail, recovery = "", level = "error") {
  results.push({ key, ok, detail, recovery, level });
}

async function handleDoctor(context, options) {
  let state = await prepareState(context, options);
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

  const localEnv = await readEnvFile(context.paths.secretsEnvFile);
  const telegramToken = String(localEnv.TELEGRAM_BOT_TOKEN ?? "").trim();
  pushCheck(
    results,
    "telegram-token",
    hasConfiguredTelegramBotToken(telegramToken),
    hasConfiguredTelegramBotToken(telegramToken) ? "Telegram bot token is configured." : "Telegram bot token is missing.",
    hasConfiguredTelegramBotToken(telegramToken) ? "" : `Set TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`
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
    authOk ? "" : `Set TARGET_AUTH_PATH to a Codex home with auth.json or provide OPENAI_API_KEY in ${context.paths.secretsEnvFile}.`
  );

  const manifestErrors = validateProjectManifest(state.manifest);
  pushCheck(
    results,
    "manifest",
    manifestErrors.length === 0,
    manifestErrors.length === 0 ? "Manifest rendered successfully." : manifestErrors.join("; "),
    manifestErrors.length === 0 ? "" : "Run `openclaw-repo-agent config validate` and fix the reported fields."
  );

  pushCheck(
    results,
    "runtime-image",
    true,
    `Runtime image is managed locally as ${context.localRuntimeImage}.`,
    "Run `openclaw-repo-agent up` or `openclaw-repo-agent update` to rebuild it."
  );

  let running = await gatewayRunning(context);
  const portStateBeforeFix = await detectGatewayPortState(context, state.localEnv);
  if (!portStateBeforeFix.ok && options.fix && shouldManageGatewayPort(state.localEnv)) {
    state = await prepareState(context, { ...options, reassignPort: true });
  }
  const portState = await detectGatewayPortState(context, state.localEnv);
  pushCheck(
    results,
    "gateway-port",
    portState.ok,
    portState.message,
    portState.ok
      ? ""
      : (shouldManageGatewayPort(state.localEnv)
        ? "Run `openclaw-repo-agent doctor --fix` or `openclaw-repo-agent up --reassign-port`."
        : `Run \`${PRODUCT_NAME} up --reassign-port\` or \`${PRODUCT_NAME} doctor --fix\`.`)
  );

  const legacyContainers = await detectLegacyComposeProject(context);
  pushCheck(
    results,
    "legacy-compose-project",
    legacyContainers.length === 0,
    legacyContainers.length === 0
      ? "No legacy compose project is running."
      : `Legacy compose project ${context.legacyComposeProjectName} is still present.`,
    legacyContainers.length === 0 ? "" : "Run `openclaw-repo-agent update` to clean up the legacy stack.",
    "warning"
  );

  const tokenConflicts = await findRunningTelegramTokenConflicts(context, state.localEnv);
  pushCheck(
    results,
    "telegram-token-uniqueness",
    tokenConflicts.length === 0,
    tokenConflicts.length === 0
      ? "Telegram bot token is unique among running repo instances."
      : `Telegram bot token is also in use by ${tokenConflicts.map((entry) => entry.instanceId).join(", ")}.`,
    tokenConflicts.length === 0 ? "" : "Use a separate TELEGRAM_BOT_TOKEN per repo instance."
  );

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
    const status = await openclawGatewayCommand(context, ["status", "--json"], { capture: true });
    const statusPayload = status.code === 0 ? parseJsonOutput(status.stdout, null) : null;
    pushCheck(
      results,
      "openclaw-status",
      status.code === 0,
      status.code === 0
        ? summarizeOpenClawStatusPayload(statusPayload)
        : (status.stderr.trim() || status.stdout.trim() || "OpenClaw status failed."),
      status.code === 0 ? "" : "Inspect the gateway logs with `docker compose logs -f openclaw-gateway`."
    );

    const channelStatus = await openclawGatewayCommand(context, ["health", "--json"], { capture: true });
    const healthPayload = channelStatus.code === 0 ? parseJsonOutput(channelStatus.stdout, null) : null;
    pushCheck(
      results,
      "pairing",
      channelStatus.code === 0,
      channelStatus.code === 0
        ? summarizeOpenClawHealthPayload(healthPayload)
        : (channelStatus.stderr.trim() || channelStatus.stdout.trim() || "Telegram pairing/channel probe failed."),
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

    const workspaceAccess = await dockerCompose(context, ["exec", "openclaw-gateway", "sh", "-lc", "test -d /workspace"], { capture: true });
    pushCheck(
      results,
      "workspace-mount",
      workspaceAccess.code === 0,
      workspaceAccess.code === 0 ? "Workspace mount is readable." : "Workspace mount is not readable inside the container.",
      workspaceAccess.code === 0 ? "" : "Check TARGET_REPO_PATH in the rendered runtime env."
    );
  }

  const ok = results.every((result) => result.ok || result.level !== "error");
  if (options.json) {
    console.log(JSON.stringify({ ok, results }, null, 2));
  } else {
    const summary = summarizeDoctorResults(results);
    printCommandReport(ok ? "success" : "warning", "Doctor", [
      { label: "Repo", value: context.repoRoot },
      { label: "Result", value: ok ? "ready" : "needs attention" },
      { label: "Checks", value: `${summary.ok} ok, ${summary.info} info, ${summary.warn} warn, ${summary.fail} fail` },
      { label: "Gateway", value: running ? buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) : "stopped" }
    ], [
      buildStatusSection("Checks", "info", results.map((result) => ({
        status: result.ok ? "success" : result.level,
        text: `${result.key}: ${result.detail}${!result.ok && result.recovery ? ` Next: ${result.recovery}` : ""}`
      })))
    ].filter(Boolean));
  }

  if (ok && options.verify) {
    await handleVerify(context, options);
  }
  if (!ok) process.exitCode = 1;
}

async function handleUpdate(context, options) {
  await handleConfigMigrate(context, options);
  let state = await runWithSpinner("Preparing updated state", () => prepareState(context, options), options);
  const legacyContainers = await detectLegacyComposeProject(context);
  if (legacyContainers.length > 0) {
    await dockerCompose({
      ...context,
      composeProjectName: context.legacyComposeProjectName
    }, ["down", "--remove-orphans"]);
  }
  if (await gatewayRunning(context)) {
    await runWithSpinner("Building local runtime image", () => ensureLocalRuntimeImageBuilt(context), options);
    await runWithSpinner("Refreshing running stack", () => dockerCompose(context, buildComposeUpArgs()), options);
  }
  await handleDoctor(context, { ...options, verify: false });
  if (!options.json) {
    printCommandReport("success", "Update complete", [
      { label: "Repo", value: context.repoRoot },
      { label: "Gateway", value: buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) },
      { label: "Runtime image", value: context.localRuntimeImage },
      { label: "Legacy cleanup", value: legacyContainers.length > 0 ? "completed" : "not needed" }
    ], [
      buildStatusSection("Warnings", "warning", [
        legacyContainers.length > 0 ? `Cleaned up legacy compose project ${context.legacyComposeProjectName}.` : ""
      ])
    ].filter(Boolean));
  }
}

async function handleInstancesList(context, options) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const instances = [];

  for (const entry of listInstanceRegistryEntries(registry)) {
    const containers = await dockerPsByComposeProject(entry.composeProjectName, {
      all: true,
      cwd: context.repoRoot
    });
    instances.push({
      ...entry,
      running: containers.some((container) => /^up\b/i.test(container.status)),
      containers
    });
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      registryPath: context.instanceRegistryFile,
      instances
    }, null, 2));
    return;
  }

  if (instances.length === 0) {
    printCommandReport("info", "Instances", [
      { label: "Instance registry", value: context.instanceRegistryFile },
      { label: "Instances", value: 0 }
    ], [
      buildStatusSection("Notes", "info", ["No repo instances are registered on this machine yet."])
    ]);
    return;
  }

  printCommandReport("info", "Instances", [
    { label: "Instance registry", value: context.instanceRegistryFile },
    { label: "Instances", value: instances.length }
  ], instances.map((entry) => ({
    title: entry.instanceId,
    status: entry.running ? "success" : "info",
    rows: [
      { label: "Status", value: entry.running ? "running" : "stopped" },
      { label: "Repo", value: entry.repoRoot },
      { label: "Compose", value: entry.composeProjectName },
      { label: "Port", value: `${entry.gatewayPort || "(unset)"} ${entry.portManaged ? "[managed]" : "[manual]"}` },
      { label: "Containers", value: entry.containers.map((container) => `${container.name} [${container.status}]`) }
    ]
  })));
}

function printHelp() {
  console.log(`${PRODUCT_NAME} ${PRODUCT_VERSION}

Usage:
  ${PRODUCT_NAME} <command> [options]

Commands:
  init             Initialize or refresh .openclaw files in a repository
  up               Start the local OpenClaw stack
  down             Stop the local OpenClaw stack
  pair             Approve local gateway/device and Telegram pairing, or external device pairing
  doctor           Check local prerequisites and gateway health
  verify           Run configured verification commands in the gateway
  status           Show rendered manifest and runtime status
  update           Refresh generated state and restart the stack when needed
  instances list   Show all registered repo instances on this machine
  config validate  Validate the repo plugin and rendered manifest
  config migrate   Rewrite config.json using current defaults

Global options:
  --repo-root <path>
  --product-root <path>
  --json
  --reassign-port
  --help, -h
  --version, -v

Examples:
  ${PRODUCT_NAME} init --repo-root /path/to/repo
  ${PRODUCT_NAME} up --reassign-port
  ${PRODUCT_NAME} status --check-updates
  ${PRODUCT_NAME} doctor --fix --verify
  ${PRODUCT_NAME} pair
  ${PRODUCT_NAME} pair --gateway-url ws://gateway.example/ws --gateway-token <token>
  ${PRODUCT_NAME} instances list
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
  const instance = buildInstanceMetadata(repoRoot);
  const context = {
    repoRoot,
    productRoot,
    repoSlug: instance.repoSlug,
    instanceId: instance.instanceId,
    composeProjectName: instance.composeProjectName,
    legacyComposeProjectName: instance.legacyComposeProjectName,
    localRuntimeImage: instance.localRuntimeImage,
    instanceRegistryFile: resolveInstanceRegistryPath(),
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
  if (command === "instances" && subcommand === "list") return await handleInstancesList(context, parsed.options);
  if (command === "config" && subcommand === "validate") return await handleConfigValidate(context, parsed.options);
  if (command === "config" && subcommand === "migrate") return await handleConfigMigrate(context, parsed.options);

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}
