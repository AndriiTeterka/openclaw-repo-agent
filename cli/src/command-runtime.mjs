import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";

import ora from "ora";

import { withObservedStage } from "../../runtime/observability.mjs";
import {
  deepMerge,
  ensureDir,
  fileExists,
  readJsonFile,
  readTextFile,
  resolveBoolean,
  safeRunCommand,
  uniqueStrings,
  writeJsonFile,
  writeTextFile
} from "../../runtime/shared.mjs";
import {
  extractCopilotCliToken,
  normalizeCopilotCliToken,
  resolveCopilotCliTokenFromSources
} from "../../runtime/copilot-auth-token.mjs";
import {
  defaultDeploymentProfile,
  normalizeAuthMode,
  normalizeProjectManifest,
  validateProjectManifest
} from "../../runtime/manifest-contract.mjs";
import {
  buildCurrentProviderModelCatalog,
} from "../../runtime/model-catalog.mjs";
import {
  SUPPORTED_ACP_AGENTS,
  assertSupportedAcpAgent,
  assertSupportedAcpAgentList
} from "../../runtime/supported-acp-agents.mjs";
import {
  normalizeStack,
  normalizeToolingProfiles,
} from "../../runtime/tooling-stack.mjs";
import {
  detectDefaultAuthPaths,
  detectDefaultCopilotAuthPath,
  resolveBootstrapAgentForMode,
  resolveDetectedAuthPathForAgent,
  resolveEffectiveAllowedAgents,
  resolveStoredAgentAuthPath
} from "./auth/foundations.mjs";
import {
  canBindPort as canBindPortOnHost,
  detectGatewayPortState as inspectGatewayPortState,
  gatewayHealthy as inspectGatewayHealthy,
  gatewayRunning as inspectGatewayRunning,
  shouldAutoHealGatewayPortConflict as shouldAutoHealGatewayPortConflictBase
} from "./gateway/port-state.mjs";
import {
  getAuthBootstrapProviderForMode,
  normalizeAllowedAgents,
  normalizeDefaultAgentModel,
  normalizePluginConfig,
} from "./plugin-config.mjs";
import {
  PRODUCT_NAME,
  PRODUCT_VERSION
} from "./product-metadata.mjs";
import {
  deriveFallbackRuntimeCoreImageTag,
  deriveToolingImageTag,
  extractRuntimeCoreDigest,
  parseDockerImageInspectOutput,
  resolveRuntimeCoreImageRef
} from "./runtime-images.mjs";
import {
  buildDefaultInstanceState,
  fileDigestIfExists,
  readInstanceState,
  writeInstanceState,
  writePathsManifest
} from "./state-store.mjs";
import {
  COPILOT_SUPPORT_HOME_LAYOUT,
  PROVIDER_HOME_LAYOUT
} from "./state-layout.mjs";
import {
  renderComposeTemplate
} from "./templates.mjs";
import {
  summarizeCommandFailure
} from "./ui/report-helpers.mjs";
import {
  parseBooleanString,
  parseFlexibleArray
} from "./utils/parse-utils.mjs";
import {
  toDockerPath,
  toHostPath
} from "./utils/path-utils.mjs";
import {
  allocateGatewayPort,
  buildRegistryEntry,
  fingerprintTelegramBotToken,
  LEGACY_COMPOSE_PORT,
  listInstanceRegistryEntries,
  readInstanceRegistry,
  shouldManageGatewayPort,
  upsertInstanceRegistryEntry
} from "./instance-registry.mjs";

export const SECRETS_ENV_HEADER = "OpenClaw secrets. Keep this file out of git.";
const TOOLING_MANIFEST_SCHEMA_VERSION = 1;
const HOST_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const ACP_AGENT_CHOICES = SUPPORTED_ACP_AGENTS.map((agentId) => ({
  value: agentId,
  label: agentId
}));

function resolveObservedLogger(options = {}, component = "cli.runtime") {
  return options?.eventLogger?.child?.({ component }) || null;
}

function parseHostEnvPassthroughNames(rawValue = "") {
  return uniqueStrings(
    String(rawValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => HOST_ENV_NAME_PATTERN.test(entry))
  );
}

function collectCopilotMcpEnvPassthroughNames(mcpConfig = null) {
  const serverEntries = Object.entries(
    mcpConfig?.mcpServers && typeof mcpConfig.mcpServers === "object" ? mcpConfig.mcpServers : {}
  );
  const detectedNames = [];

  for (const [serverName, serverConfig] of serverEntries) {
    if (!serverConfig || typeof serverConfig !== "object") continue;

    const normalizedName = String(serverName ?? "").trim().toLowerCase();
    const normalizedCommand = String(serverConfig.command ?? "").trim().toLowerCase();
    const normalizedArgs = (Array.isArray(serverConfig.args) ? serverConfig.args : [])
      .map((entry) => String(entry ?? "").trim().toLowerCase())
      .filter(Boolean);
    const isAzureDevOpsMcp = normalizedName === "ado"
      || normalizedCommand.includes("@azure-devops/mcp")
      || normalizedArgs.some((entry) => entry.includes("@azure-devops/mcp"));
    if (isAzureDevOpsMcp) {
      const authIndex = normalizedArgs.findIndex((entry) => entry === "--authentication");
      const authMode = authIndex >= 0 ? normalizedArgs[authIndex + 1] ?? "" : "";
      if (!authMode || authMode === "envvar") detectedNames.push("ADO_MCP_AUTH_TOKEN");
    }

    const envBlock = serverConfig.env;
    if (envBlock && typeof envBlock === "object" && !Array.isArray(envBlock)) {
      for (const [envName, envValue] of Object.entries(envBlock)) {
        if (HOST_ENV_NAME_PATTERN.test(envName)) detectedNames.push(envName);
        if (HOST_ENV_NAME_PATTERN.test(String(envValue ?? "").trim())) {
          detectedNames.push(String(envValue ?? "").trim());
        }
      }
    }
  }

  return uniqueStrings(detectedNames);
}

async function resolveHostEnvPassthroughEntries(context, localEnv = {}) {
  const copilotHome = String(context?.paths?.providerHomes?.copilot ?? "").trim();
  const explicitNames = parseHostEnvPassthroughNames(
    localEnv.OPENCLAW_HOST_ENV_PASSTHROUGH_NAMES ?? process.env.OPENCLAW_HOST_ENV_PASSTHROUGH_NAMES ?? ""
  );

  let detectedNames = [];
  if (copilotHome) {
    const mcpConfigPath = path.join(copilotHome, "mcp-config.json");
    if (await fileExists(mcpConfigPath)) {
      const mcpConfig = await readJsonFile(mcpConfigPath, null).catch(() => null);
      detectedNames = collectCopilotMcpEnvPassthroughNames(mcpConfig);
    }
  }

  const passthroughEntries = {};
  for (const envName of uniqueStrings([...explicitNames, ...detectedNames])) {
    const value = String(process.env?.[envName] ?? "").trim();
    if (!value) continue;
    passthroughEntries[envName] = value;
  }

  return passthroughEntries;
}

function encodePowerShellCommand(script) {
  return Buffer.from(String(script ?? ""), "utf16le").toString("base64");
}

export function buildCopilotCredentialTargets(config = null) {
  const loggedInUsers = Array.isArray(config?.logged_in_users) ? config.logged_in_users : [];
  const rawTargets = [];

  for (const entry of loggedInUsers) {
    const rawHost = String(entry?.host ?? entry?.github_host ?? "https://github.com").trim() || "https://github.com";
    const hostVariants = uniqueStrings([
      rawHost,
      rawHost.replace(/^https?:\/\//i, ""),
    ]);
    const login = String(entry?.login ?? entry?.user ?? entry?.username ?? "").trim();

    for (const host of hostVariants) {
      if (login) rawTargets.push(`copilot-cli/${host}:${login}`);
      rawTargets.push(`copilot-cli/${host}`);
    }
  }

  const targets = uniqueStrings([
    ...rawTargets,
    "copilot-cli/https://github.com",
    "copilot-cli/github.com",
  ]);

  return uniqueStrings([
    ...targets,
    ...targets.map((target) => `LegacyGeneric:target=${target}`),
  ]);
}

async function readWindowsCredentialSecret(target) {
  if (process.platform !== "win32") return "";
  const normalizedTarget = String(target ?? "").trim();
  if (!normalizedTarget) return "";

  const escapedTarget = normalizedTarget.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);
  [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=true)]
  public static extern void CredFree([In] IntPtr cred);
  public static string ReadSecretBase64(string target, UInt32 type) {
    IntPtr credentialPtr;
    if (!CredRead(target, type, 0, out credentialPtr)) return null;
    try {
      var credential = (CREDENTIAL)Marshal.PtrToStructure(credentialPtr, typeof(CREDENTIAL));
      if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return "";
      var secretBytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, secretBytes, 0, (int)credential.CredentialBlobSize);
      return Convert.ToBase64String(secretBytes);
    } finally {
      CredFree(credentialPtr);
    }
  }
}
"@
$secret = [CredReader]::ReadSecretBase64('${escapedTarget}', 1)
if ($null -ne $secret) {
  [Console]::Out.Write($secret)
}
`;
  let result = { code: 1, stdout: "", stderr: "" };
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    result = await new Promise((resolve) => {
      execFile(command, [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodePowerShellCommand(script)
      ], {
        env: process.env,
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }, (error, stdout = "", stderr = "") => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      });
    });
    if (result.code === 0) break;
  }
  if (result.code !== 0) return "";
  const encodedSecret = String(result.stdout ?? "").trim();
  if (!encodedSecret) return "";

  try {
    const secretBytes = Buffer.from(encodedSecret, "base64");
    return extractCopilotCliToken(secretBytes.toString("utf8"))
      || extractCopilotCliToken(secretBytes.toString("utf16le"))
      || extractCopilotCliToken(secretBytes.toString("latin1"));
  } catch {
    return "";
  }
}

async function resolveWindowsCopilotCredentialManagerToken(localEnv = {}, detectedAuthPaths = {}) {
  if (process.platform !== "win32") return "";

  const authRoot = resolveStoredAgentAuthPath("copilot", detectedAuthPaths) || await detectDefaultCopilotAuthPath();
  if (!authRoot) return "";

  const authConfig = await readJsonFile(path.join(toHostPath(authRoot), "config.json"), null).catch(() => null);
  for (const target of buildCopilotCredentialTargets(authConfig)) {
    const token = await readWindowsCredentialSecret(target);
    if (token) return token;
  }

  return "";
}

export async function resolveCopilotRuntimeToken(localEnv = {}, detectedAuthPaths = {}) {
  return await resolveWindowsCopilotCredentialManagerToken(localEnv, detectedAuthPaths);
}

export async function resolveRuntimeCommandEnv(
  localEnv = {},
  detectedAuthPaths = {},
  options = {},
) {
  const baseEnv = options.baseEnv ?? process.env;
  const resolveCopilotToken = options.resolveCopilotToken ?? resolveCopilotRuntimeToken;
  const bridgedCopilotToken = resolveCopilotCliTokenFromSources(
    localEnv.COPILOT_GITHUB_TOKEN,
    localEnv.GH_TOKEN,
    localEnv.GITHUB_TOKEN,
    baseEnv.COPILOT_GITHUB_TOKEN,
    baseEnv.GH_TOKEN,
    baseEnv.GITHUB_TOKEN,
  );
  if (bridgedCopilotToken) {
    return {
      COPILOT_GITHUB_TOKEN: bridgedCopilotToken,
    };
  }

  const resolvedCopilotToken = normalizeCopilotCliToken(
    await resolveCopilotToken(localEnv, detectedAuthPaths),
  );
  return resolvedCopilotToken
    ? {
        COPILOT_GITHUB_TOKEN: resolvedCopilotToken,
      }
    : {};
}

async function updateInstanceRegistry(context, localEnv = {}) {
  return await upsertInstanceRegistryEntry(context.instanceRegistryFile, buildRegistryEntry(context, localEnv));
}

async function readInstanceLocalEnv(context, instanceEnv = {}) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const registryEntries = listInstanceRegistryEntries(registry);
  const existingEntry = registryEntries.find((e) => String(e?.instanceId ?? "") === context.instanceId);

  return {
    registry,
    registryEntries,
    existingEntry,
    localEnv: {
      ...instanceEnv,
      OPENCLAW_INSTANCE_ID: context.instanceId,
      OPENCLAW_GATEWAY_PORT: String(instanceEnv.OPENCLAW_GATEWAY_PORT ?? existingEntry?.gatewayPort ?? LEGACY_COMPOSE_PORT).trim(),
      OPENCLAW_PORT_MANAGED: String(instanceEnv.OPENCLAW_PORT_MANAGED ?? (existingEntry?.portManaged ? "true" : "false")).trim(),
      OPENCLAW_GATEWAY_TOKEN: String(instanceEnv.OPENCLAW_GATEWAY_TOKEN ?? existingEntry?.gatewayToken ?? "").trim(),
      OPENCLAW_GATEWAY_BIND: String(instanceEnv.OPENCLAW_GATEWAY_BIND ?? "lan").trim(),
      OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: String(instanceEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS ?? "").trim(),
    }
  };
}

async function materializeInstanceLocalEnv(context, instanceEnv, options = {}) {
  const initial = await readInstanceLocalEnv(context, instanceEnv);
  const nextLocalEnv = {
    ...initial.localEnv,
    OPENCLAW_INSTANCE_ID: context.instanceId,
    OPENCLAW_GATEWAY_TOKEN: String(initial.localEnv.OPENCLAW_GATEWAY_TOKEN ?? "").trim() || randomToken()
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
      registryEntries: initial.registryEntries,
      excludeInstanceId: context.instanceId
    });
    nextLocalEnv.OPENCLAW_GATEWAY_PORT = String(allocatedPort);
    changes.push(options.reassignPort ? "reassigned gateway port" : "allocated gateway port");
  }
  await updateInstanceRegistry(context, nextLocalEnv);

  return {
    localEnv: nextLocalEnv,
    registry: initial.registry,
    changes
  };
}

function randomToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
function shouldUseSpinner(options = {}) {
  return !options.json && Boolean(process.stdout?.isTTY);
}

export async function runWithSpinner(text, task, options = {}) {
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
export async function runContextCommand(context, command, args, options = {}) {
  const commandRunner = typeof context?.commandRunner === "function"
    ? context.commandRunner
    : safeRunCommand;
  return await commandRunner(command, args, options);
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

export async function writeEnvFile(filePath, values, header = "") {
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

export async function readSecretsFile(context) {
  if (await fileExists(context.paths.secretsEnvFile)) {
    return {
      values: await readEnvFile(context.paths.secretsEnvFile),
      sourcePath: context.paths.secretsEnvFile,
      source: "state-home"
    };
  }
  return {
    values: {},
    sourcePath: context.paths.secretsEnvFile,
    source: "state-home"
  };
}

async function ensureSecretsFile(context, values = {}) {
  await ensureDir(path.dirname(context.paths.secretsEnvFile));
  if (!(await fileExists(context.paths.secretsEnvFile))) {
    await writeEnvFile(context.paths.secretsEnvFile, values, SECRETS_ENV_HEADER);
  }
}

function describeRuntimeCoreSelection(imageRef, digest = "", source = "latest") {
  return {
    runtimeCoreImage: resolveRuntimeCoreImageRef(imageRef),
    runtimeCoreDigest: String(digest ?? "").trim(),
    runtimeCoreSource: String(source ?? "").trim() || "latest"
  };
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

function localOverrideValue(optionsValue, envValue, fallback) {
  if (optionsValue != null && optionsValue !== "") return optionsValue;
  if (envValue != null && envValue !== "") return envValue;
  return fallback;
}

function localOverrideArray(optionsValue, envValue, fallback = []) {
  if (Array.isArray(optionsValue) && optionsValue.length > 0) return normalizeToolingProfiles(optionsValue);
  if (envValue != null && envValue !== "") return normalizeToolingProfiles(parseFlexibleArray(envValue, []));
  return normalizeToolingProfiles(fallback);
}

export function buildEffectiveManifest(plugin, repoRoot, localEnv, options = {}) {
  const discoveryEnv = {
    ...process.env,
    ...localEnv
  };
  if (!String(discoveryEnv.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES ?? "").trim()) {
    discoveryEnv.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES = "1";
  }
  const runtimeProfile = localOverrideValue(options.runtimeProfile, localEnv.OPENCLAW_RUNTIME_PROFILE, plugin.runtimeProfile);
  const queueProfile = localOverrideValue(options.queueProfile, localEnv.OPENCLAW_QUEUE_PROFILE, plugin.queueProfile || runtimeProfile);
  const toolingProfiles = localOverrideArray(options.toolingProfile, localEnv.OPENCLAW_TOOLING_PROFILES, plugin.toolingProfiles);
  const deploymentProfile = localOverrideValue(options.deploymentProfile, localEnv.OPENCLAW_DEPLOYMENT_PROFILE, plugin.deploymentProfile || defaultDeploymentProfile());
  const acpDefaultAgent = assertSupportedAcpAgent(
    localOverrideValue(options.acpDefaultAgent, localEnv.OPENCLAW_ACP_DEFAULT_AGENT, plugin.acp.defaultAgent),
    options.acpDefaultAgent != null && options.acpDefaultAgent !== ""
      ? "--acp-default-agent"
      : (String(localEnv.OPENCLAW_ACP_DEFAULT_AGENT ?? "").trim() ? "OPENCLAW_ACP_DEFAULT_AGENT" : "acp.defaultAgent")
  );
  const authMode = normalizeAuthMode(localOverrideValue(options.authMode, localEnv.OPENCLAW_BOOTSTRAP_AUTH_MODE, plugin.security.authBootstrapMode));
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
    toolingProfiles,
    stack: normalizeStack(plugin.stack),
    runtimeProfile,
    queueProfile,
    agent: {
      defaultModel: normalizeDefaultAgentModel(
        localOverrideValue(options.agentDefaultModel, localEnv.OPENCLAW_AGENT_DEFAULT_MODEL, plugin.agent.defaultModel),
        acpDefaultAgent,
        authMode,
        localEnv,
        discoveryEnv
      )
    },
    telegram: {
      dmPolicy: localOverrideValue(options.dmPolicy, localEnv.OPENCLAW_TELEGRAM_DM_POLICY, plugin.telegram.dmPolicy),
      groupPolicy: localOverrideValue(options.groupPolicy, localEnv.OPENCLAW_TELEGRAM_GROUP_POLICY, plugin.telegram.groupPolicy),
      streamMode: localOverrideValue(options.streamMode, localEnv.OPENCLAW_TELEGRAM_STREAM_MODE, plugin.telegram.streamMode),
      blockStreaming: parseBooleanString(localOverrideValue(null, localEnv.OPENCLAW_TELEGRAM_BLOCK_STREAMING, plugin.telegram.blockStreaming), plugin.telegram.blockStreaming),
      replyToMode: localOverrideValue(options.replyToMode, localEnv.OPENCLAW_TELEGRAM_REPLY_TO_MODE, plugin.telegram.replyToMode),
      reactionLevel: localOverrideValue(null, localEnv.OPENCLAW_TELEGRAM_REACTION_LEVEL, plugin.telegram.reactionLevel),
      network: {
        autoSelectFamily: parseBooleanString(localOverrideValue(options.autoSelectFamily, localEnv.OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY, plugin.telegram.network.autoSelectFamily), true)
      },
      threadBindings: {
        spawnAcpSessions: resolveBoolean(plugin.telegram.threadBindings?.spawnAcpSessions, false)
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

  return normalizeProjectManifest(manifestSeed, {
    hostPlatform: process.platform
  });
}

async function resolveBridgedCopilotRuntimeToken(manifest, localEnv = {}, detectedAuthPaths = {}) {
  const explicitToken = normalizeCopilotCliToken(localEnv.COPILOT_GITHUB_TOKEN);
  if (explicitToken) return explicitToken;

  const wantsCopilot = String(manifest?.acp?.defaultAgent ?? "").trim().toLowerCase() === "copilot"
    || String(manifest?.security?.authBootstrapMode ?? "").trim().toLowerCase() === "copilot";
  if (!wantsCopilot) return "";

  return normalizeCopilotCliToken(await resolveCopilotRuntimeToken(localEnv, detectedAuthPaths));
}


async function syncPersonalBaseline(context, localEnv) {
  const hostOpenClawPath = path.join(os.homedir(), ".openclaw");
  const hostConfigPath = path.join(hostOpenClawPath, "config.json");
  const hostConfig = await readJsonFile(hostConfigPath, null).catch(() => null);
  const baseline = {
    mcp: { servers: {} },
    plugins: { entries: {} },
    agents: { defaults: {} },
  };
  const mirroredEnv = {};
  const sharedSkillsPath = path.join(hostOpenClawPath, "skills");

  if (hostConfig && typeof hostConfig === "object" && !Array.isArray(hostConfig)) {
    const hostPlugins = (hostConfig.plugins && typeof hostConfig.plugins.entries === "object") ? hostConfig.plugins.entries : {};
    for (const [pluginId, pluginConfig] of Object.entries(hostPlugins)) {
      if (!pluginConfig || typeof pluginConfig !== "object") continue;
      baseline.plugins.entries[pluginId] = { enabled: pluginConfig.enabled, config: (pluginConfig.config && typeof pluginConfig.config === "object") ? pluginConfig.config : {} };
    }
    if (hostConfig.agent && typeof hostConfig.agent === "object") {
      baseline.agents.defaults.verboseDefault = hostConfig.agent.verboseDefault;
      baseline.agents.defaults.thinkingDefault = hostConfig.agent.thinkingDefault;
      baseline.agents.defaults.blockStreamingDefault = hostConfig.agent.blockStreamingDefault;
      baseline.agents.defaults.blockStreamingBreak = hostConfig.agent.blockStreamingBreak;
      baseline.agents.defaults.typingMode = hostConfig.agent.typingMode;
      baseline.agents.defaults.typingIntervalSeconds = hostConfig.agent.typingIntervalSeconds;
    }
  }

  const mcpSources = [];
  if (hostConfig?.mcp?.servers && typeof hostConfig.mcp.servers === "object" && !Array.isArray(hostConfig.mcp.servers)) {
    mcpSources.push(hostConfig.mcp.servers);
  }

  const providerHomes = [
    context?.paths?.providerHomes?.codex,
    context?.paths?.providerHomes?.copilot
  ].filter(Boolean);

  for (const pHome of providerHomes) {
    for (const fileName of ["mcp-config.json", "config.json"]) {
      const pConfigPath = path.join(pHome, fileName);
      try {
        if (await fileExists(pConfigPath)) {
          const pConfig = await readJsonFile(pConfigPath, null).catch(() => null);
          if (pConfig && typeof pConfig.mcpServers === "object" && !Array.isArray(pConfig.mcpServers)) {
            mcpSources.push(pConfig.mcpServers);
          }
          if (pConfig?.mcp?.servers && typeof pConfig.mcp.servers === "object" && !Array.isArray(pConfig.mcp.servers)) {
            mcpSources.push(pConfig.mcp.servers);
          }
        }
      } catch (e) {}
    }
  }

  for (const hostServers of mcpSources) {
    for (const [serverId, serverConfig] of Object.entries(hostServers)) {
      if (!serverConfig || typeof serverConfig !== "object") continue;
      const cmd = String(serverConfig.command || "");
      const args = Array.isArray(serverConfig.args) ? serverConfig.args : [];
      const cwd = String(serverConfig.cwd || serverConfig.workingDirectory || "");
      const isWindowsPath = (p) => /^[a-zA-Z]:[\\/]/.test(p);
      const isPortableCmd = ["node", "python", "npx", "uvx"].includes(cmd);
      
      if (!isPortableCmd && isWindowsPath(cmd)) {
        console.log(`Skipped MCP server ${serverId}: Windows path not portable to Docker runtime`);
        continue;
      }
      if (args.some(a => isWindowsPath(a))) {
        console.log(`Skipped MCP server ${serverId}: arguments contain Windows paths`);
        continue;
      }
      if (isWindowsPath(cwd)) {
        console.log(`Skipped MCP server ${serverId}: workingDirectory is a Windows path`);
        continue;
      }
      
      const serverEnv = (serverConfig.env && typeof serverConfig.env === "object") ? serverConfig.env : {};
      let missingEnv = false;
      const requiredEnv = {};
      for (const [k, v] of Object.entries(serverEnv)) {
         if (process.env[k] !== undefined) requiredEnv[k] = process.env[k];
         else if (localEnv[k] !== undefined) requiredEnv[k] = localEnv[k];
         else {
             if (v && typeof v === "string" && !v.startsWith("$")) requiredEnv[k] = v;
             else { 
               console.log(`Skipped MCP server ${serverId}: missing required env ${k}`);
               missingEnv = true; break; 
             }
         }
      }
      if (missingEnv) continue;
      baseline.mcp.servers[serverId] = serverConfig;
      Object.assign(mirroredEnv, requiredEnv);
    }
  }
  let hasSharedSkills = false;
  try { if (await fileExists(sharedSkillsPath)) hasSharedSkills = true; } catch (e) {}
  return { baseline, mirroredEnv, sharedSkillsPath: hasSharedSkills ? sharedSkillsPath : null };
}

async function buildRuntimeEnv(context, plugin, manifest, localEnv, runtimeImages, detectedAuthPaths = {}, providerHomeMounts = null, copilotSupportHomeMounts = null) {
  const gatewayPort = localEnv.OPENCLAW_GATEWAY_PORT || String(LEGACY_COMPOSE_PORT);
  const controlUiOrigins = localEnv.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS
    || JSON.stringify([`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`]);
  const openclawNodeOptions = String(localEnv.OPENCLAW_NODE_OPTIONS ?? process.env.OPENCLAW_NODE_OPTIONS ?? "--max-old-space-size=3072").trim();
  const openclawContainerMemoryLimit = String(localEnv.OPENCLAW_CONTAINER_MEMORY_LIMIT ?? process.env.OPENCLAW_CONTAINER_MEMORY_LIMIT ?? "4g").trim();
  const authProvider = getAuthBootstrapProviderForMode(manifest.security.authBootstrapMode);
  const runtimeProviderHomeMounts = providerHomeMounts ?? await resolveProviderHomeMounts(context);
  const runtimeCopilotSupportHomeMounts = copilotSupportHomeMounts ?? await resolveCopilotSupportHomeMounts(context);
  const hostEnvPassthroughEntries = await resolveHostEnvPassthroughEntries(context, localEnv);
  const hostEnvPassthroughJson = Object.keys(hostEnvPassthroughEntries).length > 0
    ? JSON.stringify(hostEnvPassthroughEntries)
    : "";
  const codexAuthSource = resolveRuntimeAuthSource("codex", detectedAuthPaths);
  const geminiAuthSource = resolveRuntimeAuthSource("gemini", detectedAuthPaths);
  const copilotAuthSource = resolveRuntimeAuthSource("copilot", detectedAuthPaths);
  const copilotRuntimeToken = await resolveBridgedCopilotRuntimeToken(manifest, localEnv, detectedAuthPaths);
  const wantsCopilotModels = manifest.acp.allowedAgents.includes("copilot")
    || manifest.acp.defaultAgent === "copilot"
    || manifest.security.authBootstrapMode === "copilot"
    || String(manifest.agent.defaultModel ?? "").startsWith("github-copilot/");
  const hostDiscoveredCopilotModels = wantsCopilotModels
    ? Object.keys(buildCurrentProviderModelCatalog({
        provider: "github-copilot",
        defaultAgent: manifest.acp.defaultAgent,
        defaultModel: manifest.agent.defaultModel,
        authMode: manifest.security.authBootstrapMode,
        env: {
          ...process.env,
          ...localEnv,
        },
      }))
        .filter((modelRef) => modelRef.startsWith("github-copilot/"))
        .map((modelRef) => modelRef.slice("github-copilot/".length))
    : [];
  const telegramTokenHash = fingerprintTelegramBotToken(localEnv.TELEGRAM_BOT_TOKEN);
  const runtimeRoot = "/workspace/.openclaw/runtime";
  const playwrightRoot = "/workspace/.openclaw/playwright";
  const eventRunId = String(context?.observability?.logger?.runId ?? "").trim();
  const eventCorrelationId = String(context?.observability?.logger?.correlationId ?? "").trim();

  return {
    OPENCLAW_COMPOSE_PROJECT_NAME: context.composeProjectName,
    OPENCLAW_INSTANCE_ID: context.instanceId,
    OPENCLAW_PRODUCT_ROOT: toDockerPath(context.productRoot),
    OPENCLAW_PRODUCT_NAME: PRODUCT_NAME,
    OPENCLAW_PRODUCT_VERSION: PRODUCT_VERSION,
    OPENCLAW_CORE_PROVENANCE: runtimeImages.coreProvenance || "",
    OPENCLAW_STACK_IMAGE: runtimeImages.toolingImage,
    OPENCLAW_RUNTIME_CORE_IMAGE: runtimeImages.runtimeCoreImage,
    OPENCLAW_RUNTIME_CORE_DIGEST: runtimeImages.runtimeCoreDigest || "",
    OPENCLAW_TOOLING_CONTEXT_PATH: toDockerPath(context.paths.toolingContextDir),
    OPENCLAW_TOOLING_MANIFEST_PATH: toDockerPath(context.paths.toolingManifestFile),
    OPENCLAW_AGENT_INSTALL_COMMAND: localEnv.OPENCLAW_AGENT_INSTALL_COMMAND || "",
    OPENCLAW_TOOLING_INSTALL_COMMAND: localEnv.OPENCLAW_TOOLING_INSTALL_COMMAND || "",
    OPENCLAW_EFFECTIVE_TOOLING_PROFILES: manifest.toolingProfiles.join(","),
    OPENCLAW_TOOLING_INSTALL_SCRIPTS: JSON.stringify(Array.isArray(manifest.tooling?.installScripts) ? manifest.tooling.installScripts : []),
    OPENCLAW_AGENT_INSTALL_SCRIPTS: JSON.stringify(Array.isArray(manifest.agent?.installScripts) ? manifest.agent.installScripts : []),
    OPENCLAW_TOOLING_ALLOW_UNSAFE_COMMANDS: String(Boolean(manifest.tooling?.allowUnsafeCommands)),
    OPENCLAW_GATEWAY_PORT: gatewayPort,
    OPENCLAW_GATEWAY_BIND: localEnv.OPENCLAW_GATEWAY_BIND || "lan",
    OPENCLAW_GATEWAY_TOKEN: localEnv.OPENCLAW_GATEWAY_TOKEN || randomToken(),
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: controlUiOrigins,
    OPENCLAW_NODE_OPTIONS: openclawNodeOptions,
    OPENCLAW_CONTAINER_MEMORY_LIMIT: openclawContainerMemoryLimit,
    OPENCLAW_REPO_ROOT_HOST: toDockerPath(context.repoRoot),
    OPENCLAW_WORKSPACE: "/workspace",
    OPENCLAW_REPO_ROOT: "/workspace",
    CODEX_HOME: PROVIDER_HOME_LAYOUT.codex.runtimePath,
    GEMINI_CLI_HOME: PROVIDER_HOME_LAYOUT.gemini.runtimePath,
    COPILOT_HOME: PROVIDER_HOME_LAYOUT.copilot.runtimePath,
    OPENCLAW_CODEX_HOME_MOUNT_PATH: runtimeProviderHomeMounts.codex?.hostMountPath || "",
    OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH: runtimeProviderHomeMounts.gemini?.hostMountPath || "",
    OPENCLAW_COPILOT_HOME_MOUNT_PATH: runtimeProviderHomeMounts.copilot?.hostMountPath || "",
    OPENCLAW_COPILOT_SESSION_STATE_MOUNT_PATH: toDockerPath(context.paths.copilotSessionStateDir),
    OPENCLAW_AGENTS_HOME_MOUNT_PATH: runtimeCopilotSupportHomeMounts.agents?.hostMountPath || "",
    OPENCLAW_CLAUDE_HOME_MOUNT_PATH: runtimeCopilotSupportHomeMounts.claude?.hostMountPath || "",
    OPENCLAW_SHARED_SKILLS_PATH: localEnv.OPENCLAW_SHARED_SKILLS_PATH || "",
    ...hostEnvPassthroughEntries,
    OPENCLAW_HOST_ENV_PASSTHROUGH_JSON: hostEnvPassthroughJson,
    OPENCLAW_TELEGRAM_TOKEN_HASH: telegramTokenHash,
    TELEGRAM_BOT_TOKEN: localEnv.TELEGRAM_BOT_TOKEN || "",
    ...(copilotRuntimeToken ? {
      COPILOT_GITHUB_TOKEN: copilotRuntimeToken
    } : {}),
    OPENCLAW_HOST_PLATFORM: process.platform,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: manifest.security.authBootstrapMode,
    OPENCLAW_AGENT_NAME: manifest.agent.name,
    OPENCLAW_AGENT_DEFAULT_MODEL: manifest.agent.defaultModel || "",
    OPENCLAW_AGENT_VERBOSE_DEFAULT: manifest.agent.verboseDefault,
    OPENCLAW_AGENT_THINKING_DEFAULT: manifest.agent.thinkingDefault,
    OPENCLAW_AGENT_TOOLS_DENY: JSON.stringify(manifest.agent.tools.deny),
    OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT: manifest.agent.blockStreamingDefault,
    OPENCLAW_AGENT_BLOCK_STREAMING_BREAK: manifest.agent.blockStreamingBreak,
    OPENCLAW_AGENT_TYPING_MODE: manifest.agent.typingMode,
    OPENCLAW_AGENT_TYPING_INTERVAL_SECONDS: String(manifest.agent.typingIntervalSeconds),
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
    OPENCLAW_TOOLING_PROFILES: JSON.stringify(manifest.toolingProfiles),
    OPENCLAW_STACK: JSON.stringify(manifest.stack),
    OPENCLAW_TELEGRAM_THREAD_BINDINGS_SPAWN_ACP: String(Boolean(manifest.telegram.threadBindings?.spawnAcpSessions)),
    OPENCLAW_AGENT_AUTH_CLI_BIN: localEnv.OPENCLAW_AGENT_AUTH_CLI_BIN
      || authProvider?.authCliBin
      || "",
    OPENCLAW_CODEX_AUTH_SOURCE: codexAuthSource,
    OPENCLAW_GEMINI_AUTH_SOURCE: geminiAuthSource,
    OPENCLAW_COPILOT_AUTH_SOURCE: copilotAuthSource,
    OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: hostDiscoveredCopilotModels.length > 0
      ? JSON.stringify(hostDiscoveredCopilotModels)
      : "",
    OPENCLAW_PLAYWRIGHT_CONFIG_PATH: `${playwrightRoot}/cli.config.json`,
    OPENCLAW_PLAYWRIGHT_ARTIFACTS_DIR: `${playwrightRoot}/artifacts`,
    OPENCLAW_EVENT_LOG_FILE: `${runtimeRoot}/events.jsonl`,
    OPENCLAW_EVENT_RUN_ID: eventRunId,
    OPENCLAW_EVENT_CORRELATION_ID: eventCorrelationId,
    OPENCLAW_RENDER_STATUS_PATH: `${runtimeRoot}/render-status.json`,
    TARGET_REPO_PATH: toDockerPath(context.repoRoot)
  };
}

function assertRepoRelativeScriptPath(repoRoot, scriptPath, label) {
  const normalized = String(scriptPath ?? "").trim();
  if (!normalized) return "";
  const resolved = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repo root: ${scriptPath}`);
  }
  return {
    sourcePath: resolved,
    repoRelativePath: relative.replace(/\\/g, "/")
  };
}

async function copyRepoScriptToContext(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function resolveScriptEntries(repoRoot, values, label) {
  const normalized = uniqueStrings(Array.isArray(values) ? values : []);
  const entries = [];
  for (const scriptPath of normalized) {
    const resolved = assertRepoRelativeScriptPath(repoRoot, scriptPath, label);
    if (!(await fileExists(resolved.sourcePath))) {
      throw new Error(`${label} does not exist: ${scriptPath}`);
    }
    entries.push({
      ...resolved,
      digest: await fileDigestIfExists(resolved.sourcePath)
    });
  }
  return entries;
}

function resolveRuntimeAuthSource(agentId, detectedAuthPaths = {}) {
  return resolveStoredAgentAuthPath(agentId, detectedAuthPaths) ? "auth-folder" : "";
}

async function resolveProviderHomeMounts(context) {
  const providerHomes = context?.paths?.providerHomes ?? {};
  const entries = await Promise.all(
    Object.entries(PROVIDER_HOME_LAYOUT).map(async ([agentId, definition]) => {
      const hostPath = String(providerHomes[agentId] ?? "").trim();
      const available = Boolean(hostPath) && await fileExists(hostPath);
      return [agentId, {
        available,
        hostMountPath: available ? toDockerPath(hostPath) : "",
        runtimePath: definition.runtimePath
      }];
    })
  );
  return Object.fromEntries(entries);
}

async function resolveCopilotSupportHomeMounts(context) {
  const copilotSupportHomes = context?.paths?.copilotSupportHomes ?? {};
  const entries = await Promise.all(
    Object.entries(COPILOT_SUPPORT_HOME_LAYOUT).map(async ([homeId, definition]) => {
      const hostPath = String(copilotSupportHomes[homeId] ?? "").trim();
      const available = Boolean(hostPath) && await fileExists(hostPath);
      return [homeId, {
        available,
        hostMountPath: available ? toDockerPath(hostPath) : "",
        runtimePath: definition.runtimePath
      }];
    })
  );
  return Object.fromEntries(entries);
}

async function buildToolingManifest(context, manifest, localEnv, runtimeDigest = "") {
  const toolingScripts = await resolveScriptEntries(
    context.repoRoot,
    manifest.tooling?.installScripts ?? [],
    "tooling.installScripts entry"
  );
  const agentScripts = await resolveScriptEntries(
    context.repoRoot,
    manifest.agent?.installScripts ?? [],
    "agent.installScripts entry"
  );
  const unsafeToolingCommand = String(localEnv.OPENCLAW_TOOLING_INSTALL_COMMAND ?? "").trim();
  const unsafeAgentCommand = String(localEnv.OPENCLAW_AGENT_INSTALL_COMMAND ?? "").trim();
  if (!manifest.tooling?.allowUnsafeCommands && (unsafeToolingCommand || unsafeAgentCommand)) {
    throw new Error("Inline tooling install commands require tooling.allowUnsafeCommands=true in .openclaw/config.json.");
  }

  return {
    schemaVersion: TOOLING_MANIFEST_SCHEMA_VERSION,
    runtimeDigest: String(runtimeDigest ?? "").trim(),
    platform: process.platform,
    profiles: [...manifest.toolingProfiles].sort((left, right) => left.localeCompare(right)),
    toolingScripts,
    agentScripts,
    unsafe: {
      enabled: Boolean(manifest.tooling?.allowUnsafeCommands && (unsafeToolingCommand || unsafeAgentCommand)),
      toolingCommand: unsafeToolingCommand,
      agentCommand: unsafeAgentCommand
    }
  };
}

async function renderToolingContext(context, toolingManifest) {
  await fs.rm(context.paths.toolingContextDir, { recursive: true, force: true });
  await ensureDir(context.paths.toolingContextDir);
  await ensureDir(path.join(context.paths.toolingContextDir, "scripts"));
  await fs.cp(
    path.join(context.productRoot, "runtime"),
    path.join(context.paths.toolingContextDir, "runtime"),
    { recursive: true }
  );

  const dockerfileSource = path.join(context.productRoot, "runtime", "Dockerfile.tooling");
  const dockerfileTarget = path.join(context.paths.toolingContextDir, "Dockerfile.tooling");
  await fs.copyFile(dockerfileSource, dockerfileTarget);
  await writeJsonFile(context.paths.toolingManifestFile, toolingManifest);
  await fs.copyFile(
    context.paths.toolingManifestFile,
    path.join(context.paths.toolingContextDir, "tooling.manifest.json")
  );

  for (const entry of [...toolingManifest.toolingScripts, ...toolingManifest.agentScripts]) {
    const targetPath = path.join(context.paths.toolingContextDir, "scripts", entry.repoRelativePath);
    await copyRepoScriptToContext(entry.sourcePath, targetPath);
  }

  await writeTextFile(
    path.join(context.paths.toolingContextDir, ".dockerignore"),
    [
      "*",
      "!Dockerfile.tooling",
      "!tooling.manifest.json",
      "!runtime/",
      "!runtime/**",
      "!scripts/",
      "!scripts/**"
    ].join("\n") + "\n"
  );
}

export async function dockerCommand(context, args, options = {}) {
  const result = await runContextCommand(context, "docker", args, {
    cwd: options.cwd ?? context.repoRoot,
    env: options.env,
    input: options.input,
    timeoutMs: options.timeoutMs
  });
  if (options.capture) return result;
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      `docker ${args.join(" ")}`,
      result,
      `Failed to run docker ${args.join(" ")}.`
    ));
  }
  return result;
}

export async function dockerCompose(context, args, options = {}) {
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
  const result = await runContextCommand(context, "docker", commandArgs, {
    cwd: options.cwd ?? context.repoRoot,
    env: options.env,
    input: options.input,
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

export function buildComposeUpArgs(options = {}) {
  const args = ["up", "-d", "--wait", "--wait-timeout", "300"];
  if (options.forceRecreate) args.push("--force-recreate");
  return args;
}

export function buildComposeBuildArgs() {
  return ["build", "openclaw-gateway"];
}

export function buildRuntimeCoreBuildArgs(runtimeCoreImage) {
  return ["build", "--pull", "--file", "runtime/Dockerfile.core", "--tag", runtimeCoreImage, "."];
}

export function buildRuntimeCoreOverlayBuildArgs(baseRuntimeCoreImage, runtimeCoreImage) {
  return [
    "build",
    "--file",
    "runtime/Dockerfile.core.overlay",
    "--tag",
    runtimeCoreImage,
    "--build-arg",
    `OPENCLAW_RUNTIME_CORE_BASE_IMAGE=${baseRuntimeCoreImage}`,
    "."
  ];
}

function buildToolingImageBuildArgs(toolingContextDir, toolingImage, runtimeCoreImage) {
  return [
    "build",
    "--file",
    "Dockerfile.tooling",
    "--tag",
    toolingImage,
    "--build-arg",
    `OPENCLAW_RUNTIME_CORE_IMAGE=${runtimeCoreImage}`,
    toolingContextDir
  ];
}

async function canBuildRuntimeCoreLocally(context) {
  return await fileExists(path.join(context.productRoot, "runtime", "Dockerfile.core"));
}

async function listFilesRecursive(rootDir, prefix = "") {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const results = [];
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(entryPath, relativePath));
      continue;
    }
    if (entry.isFile()) results.push(relativePath);
  }
  return results;
}

async function computeLocalRuntimeCoreSourceFingerprint(productRoot) {
  const runtimeRoot = path.join(productRoot, "runtime");
  const runtimeFiles = await listFilesRecursive(runtimeRoot);
  if (runtimeFiles.length === 0) return "";

  const hash = crypto.createHash("sha256");
  for (const relativeRuntimePath of runtimeFiles) {
    const normalizedRelativePath = `runtime/${relativeRuntimePath.replace(/\\/g, "/")}`;
    const contents = await fs.readFile(path.join(runtimeRoot, ...relativeRuntimePath.split("/")));
    hash.update(normalizedRelativePath);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function shouldPreferLocalRuntimeCoreBuild(context, localEnv = {}, options = {}) {
  if (String(localEnv.OPENCLAW_RUNTIME_CORE_IMAGE ?? "").trim()) return false;
  if (!(await canBuildRuntimeCoreLocally(context))) return false;
  if (options.preferLocalRuntimeCoreBuild === false) return false;

  const override = String(
    process.env.OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD
      ?? localEnv.OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD
      ?? ""
  ).trim().toLowerCase();
  if (override === "false") return false;
  if (override === "true" || options.preferLocalRuntimeCoreBuild === true) return true;
  return false;
}

async function ensureRuntimeCoreImageBuiltLocally(context, runtimeCoreImage, options = {}) {
  const result = await dockerCommand(context, buildRuntimeCoreBuildArgs(runtimeCoreImage), {
    capture: true,
    cwd: context.productRoot,
    timeoutMs: options.timeoutMs
  });
  if (result.code !== 0) {
    if (await localDockerImageExists(context, runtimeCoreImage)) {
      return result;
    }
    throw new Error(summarizeCommandFailure(
      `docker ${buildRuntimeCoreBuildArgs(runtimeCoreImage).join(" ")}`,
      result,
      `Failed to build local runtime-core image ${runtimeCoreImage}.`
    ));
  }
  return result;
}

async function ensureRuntimeCoreOverlayImageBuiltLocally(context, baseRuntimeCoreImage, runtimeCoreImage, options = {}) {
  const result = await dockerCommand(context, buildRuntimeCoreOverlayBuildArgs(baseRuntimeCoreImage, runtimeCoreImage), {
    capture: true,
    cwd: context.productRoot,
    timeoutMs: options.timeoutMs
  });
  if (result.code !== 0) {
    if (await localDockerImageExists(context, runtimeCoreImage)) {
      return result;
    }
    throw new Error(summarizeCommandFailure(
      `docker ${buildRuntimeCoreOverlayBuildArgs(baseRuntimeCoreImage, runtimeCoreImage).join(" ")}`,
      result,
      `Failed to build local runtime-core overlay image ${runtimeCoreImage}.`
    ));
  }
  return result;
}

async function resolveRuntimeImages(context, resolvedState, options = {}) {
  const { localEnv, manifest, toolingManifest } = resolvedState;
  const requestedRuntimeCoreImage = resolveRuntimeCoreImageRef(localEnv.OPENCLAW_RUNTIME_CORE_IMAGE);
  const runtimeOverlayDigest = await computeLocalRuntimeCoreSourceFingerprint(context.productRoot);
  const toolingInstallCommand = JSON.stringify({
    scripts: (toolingManifest?.toolingScripts ?? []).map((entry) => ({ path: entry.repoRelativePath, digest: entry.digest })),
    unsafe: toolingManifest?.unsafe?.toolingCommand || ""
  });
  const agentInstallCommand = JSON.stringify({
    scripts: (toolingManifest?.agentScripts ?? []).map((entry) => ({ path: entry.repoRelativePath, digest: entry.digest })),
    unsafe: toolingManifest?.unsafe?.agentCommand || ""
  });
  const allowLocalRuntimeCoreBuildFallback = (
    String(process.env.OPENCLAW_ALLOW_LOCAL_RUNTIME_CORE_BUILD ?? localEnv.OPENCLAW_ALLOW_LOCAL_RUNTIME_CORE_BUILD ?? "").trim().toLowerCase() === "true"
      || options.allowLocalRuntimeCoreBuildFallback === true
  )
    && await canBuildRuntimeCoreLocally(context);
  const preferLocalRuntimeCoreBuild = await shouldPreferLocalRuntimeCoreBuild(context, localEnv, options);
  const fallbackRuntimeCoreImage = deriveFallbackRuntimeCoreImageTag({
    runtimeCoreImage: requestedRuntimeCoreImage,
    runtimeCoreDigest: requestedRuntimeCoreImage
  });
  let runtimeCoreImage = requestedRuntimeCoreImage;
  let coreProvenance = String(localEnv.OPENCLAW_RUNTIME_CORE_IMAGE ?? "").trim()
    ? "override"
    : "remote-latest";

  if (preferLocalRuntimeCoreBuild) {
    const localRuntimeCoreFingerprint = await computeLocalRuntimeCoreSourceFingerprint(context.productRoot);
    if (!localRuntimeCoreFingerprint) {
      throw new Error(`Unable to fingerprint runtime-core sources under ${path.join(context.productRoot, "runtime")}.`);
    }
    let localRuntimeCoreSeed = localRuntimeCoreFingerprint;
    let baseRuntimeCoreAvailable = true;
    if (options.pullRuntimeCoreImage) {
      const pullBaseResult = await dockerCommand(context, ["pull", requestedRuntimeCoreImage], {
        capture: true,
        timeoutMs: options.timeoutMs
      });
      if (pullBaseResult.code !== 0) {
        baseRuntimeCoreAvailable = false;
        if (!allowLocalRuntimeCoreBuildFallback) {
          throw new Error(summarizeCommandFailure(
            `docker pull ${requestedRuntimeCoreImage}`,
            pullBaseResult,
            `Failed to pull runtime-core image ${requestedRuntimeCoreImage}.`
          ));
        }
      }
    }

    if (baseRuntimeCoreAvailable) {
      const baseInspectResult = await dockerCommand(context, ["image", "inspect", requestedRuntimeCoreImage], {
        capture: true,
        timeoutMs: options.timeoutMs
      });
      const baseImageInspect = baseInspectResult.code === 0
        ? parseDockerImageInspectOutput(baseInspectResult.stdout)
        : null;
      const baseRuntimeCoreDigest = extractRuntimeCoreDigest(baseImageInspect, requestedRuntimeCoreImage)
        || String(baseImageInspect?.Id ?? "").trim()
        || requestedRuntimeCoreImage;
      localRuntimeCoreSeed = `${baseRuntimeCoreDigest}:${localRuntimeCoreFingerprint}`;
    }

    runtimeCoreImage = deriveFallbackRuntimeCoreImageTag({
      runtimeCoreImage: requestedRuntimeCoreImage,
      runtimeCoreDigest: localRuntimeCoreSeed
    });
    if (options.force || !(await localDockerImageExists(context, runtimeCoreImage))) {
      if (baseRuntimeCoreAvailable) {
        await ensureRuntimeCoreOverlayImageBuiltLocally(context, requestedRuntimeCoreImage, runtimeCoreImage, options);
      } else {
        await ensureRuntimeCoreImageBuiltLocally(context, runtimeCoreImage, options);
      }
    }
    coreProvenance = "local-product-build";
  } else if (options.pullRuntimeCoreImage) {
    const pullResult = await dockerCommand(context, ["pull", requestedRuntimeCoreImage], {
      capture: true,
      timeoutMs: options.timeoutMs
    });
    if (pullResult.code !== 0) {
      if (allowLocalRuntimeCoreBuildFallback) {
        runtimeCoreImage = fallbackRuntimeCoreImage;
        const localImageExists = await localDockerImageExists(context, runtimeCoreImage);
        if (!localImageExists) {
          await ensureRuntimeCoreImageBuiltLocally(context, runtimeCoreImage, options);
        }
        coreProvenance = "maintainer-local-build";
      } else {
        throw new Error(summarizeCommandFailure(
          `docker pull ${requestedRuntimeCoreImage}`,
          pullResult,
          `Failed to pull runtime-core image ${requestedRuntimeCoreImage}.`
        ));
      }
    }
  }

  const inspectResult = await dockerCommand(context, ["image", "inspect", runtimeCoreImage], {
    capture: true,
    timeoutMs: options.timeoutMs
  });
  const imageInspect = inspectResult.code === 0
    ? parseDockerImageInspectOutput(inspectResult.stdout)
    : null;
  const runtimeCoreDigest = extractRuntimeCoreDigest(imageInspect, requestedRuntimeCoreImage)
    || extractRuntimeCoreDigest(imageInspect, runtimeCoreImage);
  if (!imageInspect && options.pullRuntimeCoreImage) {
    throw new Error(summarizeCommandFailure(
      `docker image inspect ${runtimeCoreImage}`,
      inspectResult,
      `Runtime-core image ${runtimeCoreImage} is not available locally after the pull step.`
    ));
  }
  if (!runtimeCoreDigest && options.pullRuntimeCoreImage) {
    throw new Error(`Runtime-core image ${runtimeCoreImage} did not resolve to a digest after pull.`);
  }

  const toolingFingerprintSource = runtimeCoreDigest
    || String(imageInspect?.Id ?? "").trim()
    || requestedRuntimeCoreImage;
  const toolingImage = deriveToolingImageTag({
    runtimeCoreImage,
    runtimeCoreDigest: toolingFingerprintSource,
    runtimeOverlayDigest,
    toolingProfiles: manifest.toolingProfiles,
    toolingInstallCommand,
    agentInstallCommand
  });

  return {
    requestedRuntimeCoreImage,
    runtimeCoreImage,
    runtimeCoreDigest,
    toolingImage,
    coreProvenance
  };
}

async function localDockerImageExists(context, imageRef) {
  const result = await dockerCommand(context, ["image", "inspect", imageRef], { capture: true });
  return result.code === 0;
}

async function ensureToolingImageBuilt(context, state, options = {}) {
  if (!options.force && await localDockerImageExists(context, state.runtimeImages.toolingImage)) {
    return false;
  }
  const args = buildToolingImageBuildArgs(
    context.paths.toolingContextDir,
    state.runtimeImages.toolingImage,
    state.runtimeImages.runtimeCoreImage
  );
  const result = await dockerCommand(context, args, {
    capture: true,
    cwd: context.paths.toolingContextDir,
    timeoutMs: options.timeoutMs
  });
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      `docker ${args.join(" ")}`,
      result,
      `Failed to build tooling image ${state.runtimeImages.toolingImage}.`
    ));
  }
  return true;
}

export async function openclawHostCommand(context, args, options = {}) {
  let result;
  try {
    result = await runContextCommand(context, "openclaw", args, {
      cwd: options.cwd ?? context.repoRoot,
      env: options.env,
      input: options.input,
      timeoutMs: options.timeoutMs
    });
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

export async function openclawGatewayCommand(context, args, options = {}) {
  return await dockerCompose(context, ["exec", "-T", "openclaw-gateway", "openclaw", ...args], options);
}
export async function gatewayRunning(context) {
  return await inspectGatewayRunning(context, { dockerCompose });
}

export async function gatewayHealthy(context) {
  return await inspectGatewayHealthy(context, {
    dockerCompose,
    dockerCommand
  });
}
export async function dockerPsByComposeProject(projectName, options = {}) {
  const args = [
    "ps",
    ...(options.all ? ["-a"] : []),
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--format",
    "{{.Names}}|{{.Status}}"
  ];
  const result = await runContextCommand(options.context ?? {}, "docker", args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    input: options.input,
    timeoutMs: options.timeoutMs
  });
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

export async function detectGatewayPortState(context, localEnv) {
  return await inspectGatewayPortState(context, localEnv, {
    gatewayRunning,
    readInstanceRegistry,
    listInstanceRegistryEntries,
    canBindPort: canBindPortOnHost
  });
}

export function shouldAutoHealGatewayPortConflict(localEnv, portState) {
  return shouldAutoHealGatewayPortConflictBase(localEnv, portState, {
    legacyComposePort: LEGACY_COMPOSE_PORT,
    shouldManageGatewayPort
  });
}

export function findRegisteredTelegramTokenConflicts(context, registry, localEnv) {
  const tokenHash = fingerprintTelegramBotToken(localEnv.TELEGRAM_BOT_TOKEN);
  if (!tokenHash) return [];
  return listInstanceRegistryEntries(registry).filter((entry) =>
    entry.instanceId !== context.instanceId && entry.telegramTokenHash === tokenHash
  );
}

export async function findRunningTelegramTokenConflicts(context, localEnv) {
  const registry = await readInstanceRegistry(context.instanceRegistryFile);
  const candidates = findRegisteredTelegramTokenConflicts(context, registry, localEnv);
  const running = [];

  for (const entry of candidates) {
    const containers = await dockerPsByComposeProject(entry.composeProjectName, {
      all: false,
      cwd: context.repoRoot,
      context
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

export async function resolveState(context, options = {}) {
  const eventLogger = resolveObservedLogger(options);
  return await withObservedStage(eventLogger, "state.resolve", "state.resolve", async () => {
    const configRaw = await readJsonFile(context.paths.configFile, null);
    if (!configRaw) {
      throw new Error(`Missing ${context.paths.configFile}. Run ${PRODUCT_NAME} init first.`);
    }

    const plugin = normalizePluginConfig(configRaw, context.repoRoot, context.detection, options);
    const secretsSource = await readSecretsFile(context);
    const existingState = await readInstanceState(context);
    const instanceSnapshot = await readInstanceLocalEnv(context, {
      OPENCLAW_AGENT_INSTALL_COMMAND: "",
      OPENCLAW_RUNTIME_CORE_IMAGE: "",
      OPENCLAW_CODEX_AUTH_SOURCE: "",
      OPENCLAW_GEMINI_AUTH_SOURCE: "",
      OPENCLAW_COPILOT_AUTH_SOURCE: "",
      OPENCLAW_TOOLING_INSTALL_COMMAND: "",
      ...secretsSource.values
    });
    const localEnv = {
      OPENCLAW_AGENT_INSTALL_COMMAND: "",
      OPENCLAW_RUNTIME_CORE_IMAGE: "",
      OPENCLAW_CODEX_AUTH_SOURCE: "",
      OPENCLAW_GEMINI_AUTH_SOURCE: "",
      OPENCLAW_COPILOT_AUTH_SOURCE: "",
      OPENCLAW_TOOLING_INSTALL_COMMAND: "",
      ...secretsSource.values,
      ...instanceSnapshot.localEnv
    };
    const detectedAuthPaths = await detectDefaultAuthPaths();
    const effectiveAllowedAgents = resolveEffectiveAllowedAgents(configRaw, plugin, localEnv, options, detectedAuthPaths);
    const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnv, {
      ...options,
      acpAllowedAgent: effectiveAllowedAgents,
    });
    const detectedAuthPath = resolveDetectedAuthPathForAgent(
      resolveBootstrapAgentForMode(manifest.security.authBootstrapMode, manifest.acp.defaultAgent),
      detectedAuthPaths
    );

    const validationErrors= validateProjectManifest(manifest);
    if (validationErrors.length > 0) {
      throw new Error(`Config is invalid: ${validationErrors.join("; ")}`);
    }

    const requestedRuntimeCoreImage = resolveRuntimeCoreImageRef(localEnv.OPENCLAW_RUNTIME_CORE_IMAGE);
    const toolingManifest = await buildToolingManifest(
      context,
      manifest,
      localEnv,
      existingState.runtimeCore?.digest || requestedRuntimeCoreImage
    );

    return {
      context,
      plugin,
      localEnv,
      manifest,
      runtimeEnv: null,
      runtimeImages: null,
      toolingManifest,
      instanceState: existingState,
      requestedRuntimeCoreImage,
      detectedAuthPath,
      detectedAuthPaths,
      instanceRegistry: instanceSnapshot.registry,
      secretsSource
    };
  }, {
    data: {
      configFile: context.paths.configFile
    },
    buildSuccessData(state) {
      return {
        projectName: state.manifest.projectName,
        defaultAgent: state.manifest.acp.defaultAgent,
        allowedAgents: state.manifest.acp.allowedAgents,
        toolingProfiles: state.manifest.toolingProfiles,
        detectedAuthAgents: Object.entries(state.detectedAuthPaths ?? {})
          .filter(([, value]) => Boolean(value))
          .map(([agentId]) => agentId)
      };
    }
  });
}

export async function renderState(resolvedState, { targets = ["runtime"], materializedRuntime = null, options = {} } = {}) {
  const context = resolvedState.context;
  const wantsTooling = targets.includes("all") || targets.includes("tooling");
  const wantsRuntime = targets.includes("all") || targets.includes("runtime");
  const eventLogger = resolveObservedLogger(options);

  return await withObservedStage(eventLogger, "state.render", "state.render", async () => {
    await ensureDir(context.paths.openclawDir);
    await ensureDir(context.paths.instanceRoot);
    await ensureDir(context.paths.runtimeDir);
    await ensureDir(context.paths.playwrightArtifactsDir);

    const ensuredInstance = await materializeInstanceLocalEnv(context, resolvedState.localEnv, options);
    const localEnv = {
      ...resolvedState.localEnv,
      ...ensuredInstance.localEnv
    };

    const toolingManifest = await buildToolingManifest(
      context,
      resolvedState.manifest,
      localEnv,
      materializedRuntime?.runtimeCoreDigest
        || resolvedState.instanceState.runtimeCore?.digest
        || resolvedState.requestedRuntimeCoreImage
    );

    if (wantsTooling) {
      await renderToolingContext(context, toolingManifest);
    }

    await writePathsManifest(context);

    let runtimeEnv = resolvedState.runtimeEnv;
    let runtimeCommandEnv = resolvedState.runtimeCommandEnv ?? {};
    if (wantsRuntime && materializedRuntime) {
      const providerHomeMounts = await resolveProviderHomeMounts(context);
      const copilotSupportHomeMounts = await resolveCopilotSupportHomeMounts(context);
      const hostEnvPassthroughEntries = await resolveHostEnvPassthroughEntries(context, localEnv);
      await ensureDir(context.paths.copilotSessionStateDir);
      runtimeCommandEnv = await resolveRuntimeCommandEnv(localEnv, resolvedState.detectedAuthPaths);

      const { baseline, mirroredEnv, sharedSkillsPath } = await syncPersonalBaseline(context, localEnv);
      await writeTextFile(path.join(context.paths.runtimeDir, "host-baseline.json"), JSON.stringify(baseline, null, 2));
      Object.assign(hostEnvPassthroughEntries, mirroredEnv);
      Object.assign(localEnv, mirroredEnv);
      if (sharedSkillsPath) localEnv.OPENCLAW_SHARED_SKILLS_PATH = sharedSkillsPath;

      runtimeEnv = await buildRuntimeEnv(
        context,
        resolvedState.plugin,
        resolvedState.manifest,
        localEnv,
        materializedRuntime,
        resolvedState.detectedAuthPaths,
        providerHomeMounts,
        copilotSupportHomeMounts
      );
      await writeEnvFile(context.paths.runtimeEnvFile, runtimeEnv);
      await writeTextFile(context.paths.composeFile, renderComposeTemplate({
        providerHomeMounts,
        copilotSupportHomeMounts,
        hostEnvPassthroughNames: Object.keys(hostEnvPassthroughEntries),
        sharedSkillsPath
      }));
      await writeTextFile(
        context.paths.playwrightConfigFile,
        `${JSON.stringify({
          browser: {
            browserName: "chromium",
            launchOptions: {
              channel: "chromium"
            }
          },
          outputDir: "/workspace/.openclaw/playwright/artifacts"
        }, null, 2)}\n`
      );
    }

    const statePayload = buildDefaultInstanceState(context, {
      ...resolvedState.instanceState,
      runtimeCore: {
        image: materializedRuntime?.runtimeCoreImage
          || resolvedState.instanceState.runtimeCore?.image
          || resolvedState.requestedRuntimeCoreImage,
        digest: materializedRuntime?.runtimeCoreDigest
          || resolvedState.instanceState.runtimeCore?.digest
          || "",
        source: materializedRuntime?.coreProvenance
          || resolvedState.instanceState.runtimeCore?.source
          || "unresolved"
      },
      toolingFingerprint: materializedRuntime?.toolingImage || resolvedState.instanceState.toolingFingerprint || "",
      lastMaterializedAt: materializedRuntime ? new Date().toISOString() : resolvedState.instanceState.lastMaterializedAt
    });
    await writeInstanceState(context, statePayload);
    await ensureSecretsFile(context, resolvedState.secretsSource.values);

    return {
      ...resolvedState,
      localEnv,
      runtimeEnv,
      runtimeCommandEnv,
      toolingManifest,
      runtimeImages: materializedRuntime || resolvedState.runtimeImages,
      instanceRegistry: ensuredInstance.registry,
      instanceState: statePayload
    };
  }, {
    data: {
      targets,
      runtimeRequested: wantsRuntime,
      toolingRequested: wantsTooling
    },
    buildSuccessData(state) {
      return {
        gatewayPort: state.localEnv.OPENCLAW_GATEWAY_PORT,
        runtimeRendered: Boolean(state.runtimeEnv),
        toolingScripts: state.toolingManifest?.toolingScripts?.length ?? 0,
        agentScripts: state.toolingManifest?.agentScripts?.length ?? 0,
        runtimeCoreImage: state.runtimeImages?.runtimeCoreImage || materializedRuntime?.runtimeCoreImage || ""
      };
    }
  });
}

export async function materializeRuntime(resolvedState, renderedState, options = {}) {
  const eventLogger = resolveObservedLogger(options);
  return await withObservedStage(eventLogger, "runtime.materialize", "runtime.materialize", async () => {
    const stateWithImages = {
      ...resolvedState,
      localEnv: renderedState?.localEnv ?? resolvedState.localEnv,
      toolingManifest: renderedState?.toolingManifest ?? resolvedState.toolingManifest
    };
    const runtimeImages = await resolveRuntimeImages(resolvedState.context, stateWithImages, options);
    const nextState = {
      ...stateWithImages,
      runtimeImages
    };
    await ensureToolingImageBuilt(resolvedState.context, nextState, options);
    return runtimeImages;
  }, {
    data: {
      requestedRuntimeCoreImage: resolvedState.requestedRuntimeCoreImage,
      pullRuntimeCoreImage: Boolean(options.pullRuntimeCoreImage)
    },
    buildSuccessData(runtimeImages) {
      return {
        requestedRuntimeCoreImage: runtimeImages.requestedRuntimeCoreImage,
        runtimeCoreImage: runtimeImages.runtimeCoreImage,
        runtimeCoreDigest: runtimeImages.runtimeCoreDigest,
        toolingImage: runtimeImages.toolingImage,
        coreProvenance: runtimeImages.coreProvenance
      };
    }
  });
}

export async function prepareState(context, options = {}) {
  const resolved = await resolveState(context, options);
  const renderedTooling = await renderState(resolved, {
    targets: ["tooling"],
    options
  });
  if (options.readOnly) {
    return await renderState(renderedTooling, {
      targets: [],
      options
    });
  }
  const runtimeImages = await materializeRuntime(renderedTooling, renderedTooling, options);
  return await renderState(renderedTooling, {
    targets: ["runtime"],
    materializedRuntime: runtimeImages,
    options
  });
}


export async function prepareMaterializedRuntimeState(context, options = {}) {
  const resolved = await resolveState(context, options);
  const renderedTooling = await renderState(resolved, {
    targets: ["tooling"],
    options
  });
  const runtimeImages = await materializeRuntime(renderedTooling, renderedTooling, {
    ...options,
    pullRuntimeCoreImage: true
  });
  return await renderState(renderedTooling, {
    targets: ["runtime"],
    materializedRuntime: runtimeImages,
    options
  });
}

export async function prepareReadOnlyState(context, options = {}) {
  if (!options.refresh) {
    return await resolveState(context, options);
  }
  return await prepareMaterializedRuntimeState(context, options);
}

export function buildCachedMaterializedRuntime(resolvedState) {
  const toolingInstallCommand = JSON.stringify({
    scripts: (resolvedState.toolingManifest?.toolingScripts ?? []).map((entry) => ({ path: entry.repoRelativePath, digest: entry.digest })),
    unsafe: resolvedState.toolingManifest?.unsafe?.toolingCommand || ""
  });
  const agentInstallCommand = JSON.stringify({
    scripts: (resolvedState.toolingManifest?.agentScripts ?? []).map((entry) => ({ path: entry.repoRelativePath, digest: entry.digest })),
    unsafe: resolvedState.toolingManifest?.unsafe?.agentCommand || ""
  });
  const runtimeCoreImage = resolveRuntimeCoreImageRef(
    resolvedState.instanceState.runtimeCore?.image
    || resolvedState.localEnv.OPENCLAW_RUNTIME_CORE_IMAGE
    || resolvedState.requestedRuntimeCoreImage
  );
  const runtimeCoreDigest = String(resolvedState.instanceState.runtimeCore?.digest ?? "").trim();
  return {
    requestedRuntimeCoreImage: runtimeCoreImage,
    runtimeCoreImage,
    runtimeCoreDigest,
    toolingImage: resolvedState.instanceState.toolingFingerprint || deriveToolingImageTag({
      runtimeCoreImage,
      runtimeCoreDigest: runtimeCoreDigest || runtimeCoreImage,
      toolingProfiles: resolvedState.manifest.toolingProfiles,
      toolingInstallCommand,
      agentInstallCommand
    }),
    coreProvenance: resolvedState.instanceState.runtimeCore?.source || "cached"
  };
}

export async function ensureRenderedRuntimeFiles(context, options = {}) {
  const resolved = await resolveState(context, options);
  const renderedTooling = await renderState(resolved, {
    targets: ["tooling"],
    options
  });
  return await renderState(renderedTooling, {
    targets: ["runtime"],
    materializedRuntime: buildCachedMaterializedRuntime(renderedTooling),
    options
  });
}
