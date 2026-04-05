import os from "node:os";

import {
  deepMerge,
  deriveDefaultAgentName,
  deriveProjectRootName,
  isPlainObject,
  normalizePrincipalArray,
  parseStringArrayEnv,
  resolveBoolean,
  resolveInteger,
  uniqueStrings
} from "./shared.mjs";
import {
  createEmptyStack,
  normalizeStack,
  normalizeToolingProfiles,
  parseStackEnv,
  parseToolingProfilesEnv,
  validateToolingProfiles,
} from "./tooling-stack.mjs";
import {
  buildAllProvidersModelCatalog,
  buildCurrentProviderModelCatalog,
  getLatestCurrentProviderModel,
  resolvePrimaryModelRef,
  resolveDefaultModelProvider
} from "./model-catalog.mjs";
import {
  formatSupportedAcpAgents,
  isSupportedAcpAgent,
  normalizeAcpAgentValue
} from "./supported-acp-agents.mjs";
const SUPPORTED_DEPLOYMENT_PROFILES = ["docker-local", "wsl2", "linux-vps"];
const SUPPORTED_RUNTIME_PROFILES = ["stable-chat", "interactive-steer", "topic-bound-acp", "ci-runner"];

const RUNTIME_PROFILE_PRESETS = {
  "stable-chat": {
    queue: {
      mode: "steer",
      debounceMs: 250,
      cap: 20,
      inboundDebounceMs: 150,
    },
    messages: {
      statusReactions: {
        enabled: true,
      },
    },
    tools: {
      exec: {
        timeoutSec: 600,
      },
    },
    agent: {
      maxConcurrent: 4,
      verboseDefault: "on",
      thinkingDefault: "adaptive",
      blockStreamingDefault: "off",
      blockStreamingBreak: "text_end",
      typingMode: "message",
      typingIntervalSeconds: 12,
      tools: {
        deny: ["process"],
      },
    },
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      groupPolicy: "disabled",
      streamMode: "partial",
      blockStreaming: false,
      replyToMode: "all",
      reactionLevel: "minimal",
      configWrites: false,
      network: {
        autoSelectFamily: true,
      },
      groups: {
        "*": {
          requireMention: true,
        },
      },
      threadBindings: {
        spawnAcpSessions: false,
      },
    },
    acp: {
      defaultAgent: "",
      allowedAgents: [],
      preferredMode: "oneshot",
      maxConcurrentSessions: 4,
      ttlMinutes: 120,
      stream: {
        coalesceIdleMs: 300,
        maxChunkChars: 1200,
      },
    },
    security: {
      authBootstrapMode: "external",
      commandLoggerEnabled: true,
      toolDeny: ["process"],
    },
  },
  "interactive-steer": {
    queue: {
      mode: "steer",
      debounceMs: 0,
      cap: 20,
      inboundDebounceMs: 0,
    },
  },
  "topic-bound-acp": {
    queue: {
      mode: "collect",
      debounceMs: 150,
      cap: 20,
      inboundDebounceMs: 150,
    },
    telegram: {
      groupPolicy: "allowlist",
      threadBindings: {
        spawnAcpSessions: true,
      },
    },
    acp: {
      preferredMode: "oneshot",
    },
  },
  "ci-runner": {
    queue: {
      mode: "collect",
      debounceMs: 500,
      cap: 50,
      inboundDebounceMs: 500,
    },
    messages: {
      statusReactions: {
        enabled: false,
      },
    },
    tools: {
      exec: {
        timeoutSec: 1200,
      },
    },
    agent: {
      blockStreamingDefault: "on",
    },
    telegram: {
      streamMode: "off",
      reactionLevel: "off",
    },
  },
};

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  projectName: "workspace",
  deploymentProfile: "",
  toolingProfiles: [],
  tooling: {
    installScripts: [],
    allowUnsafeCommands: false,
  },
  stack: createEmptyStack(),
  runtimeProfile: "stable-chat",
  queueProfile: "stable-chat",
  agent: {
    id: "workspace",
    name: "",
    maxConcurrent: 4,
    skipBootstrap: true,
    defaultModel: "",
    installScripts: [],
    verboseDefault: "on",
    thinkingDefault: "adaptive",
    blockStreamingDefault: "off",
    blockStreamingBreak: "text_end",
    typingMode: "message",
    typingIntervalSeconds: 12,
    tools: {
      deny: ["process"],
    },
  },
  telegram: {
    dmPolicy: "pairing",
    groupPolicy: "disabled",
    streamMode: "partial",
    blockStreaming: false,
    replyToMode: "all",
    reactionLevel: "minimal",
    configWrites: false,
    groups: {
      "*": {
        requireMention: true,
      },
    },
    threadBindings: {
      spawnAcpSessions: false,
    },
    network: {
      autoSelectFamily: true,
    },
  },
  acp: {
    defaultAgent: "codex",
    allowedAgents: [],
    preferredMode: "oneshot",
    maxConcurrentSessions: 4,
    ttlMinutes: 120,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
  },
  security: {
    authBootstrapMode: "codex",
    commandLoggerEnabled: true,
    toolDeny: ["process"],
  },
});

function nonEmptyString(value, fallback = "") {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function toStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function defaultAgentName(projectName, repoPath) {
  return deriveDefaultAgentName(projectName, repoPath);
}

function resolveProviderPluginId(acpAgent) {
  const normalized = String(acpAgent ?? "").trim().toLowerCase();
  if (normalized === "codex") return "openai";
  if (normalized === "gemini") return "google";
  return "";
}

export function defaultDeploymentProfile(hostPlatform = os.platform()) {
  return hostPlatform === "win32" ? "wsl2" : "docker-local";
}

function defaultProjectName(repoPath) {
  return deriveProjectRootName(repoPath);
}

function getRuntimePreset(name) {
  const runtimeProfile = nonEmptyString(name, "stable-chat");
  return deepMerge(RUNTIME_PROFILE_PRESETS["stable-chat"], RUNTIME_PROFILE_PRESETS[runtimeProfile] ?? {});
}

function normalizeGroups(value, fallback) {
  if (!isPlainObject(value)) return deepMerge(fallback);
  return deepMerge(fallback, value);
}

function resolveRuntimeProfile(rawValue) {
  const profile = nonEmptyString(rawValue, "stable-chat");
  return SUPPORTED_RUNTIME_PROFILES.includes(profile) ? profile : "stable-chat";
}

function resolveQueueProfile(rawValue, runtimeProfile) {
  const profile = nonEmptyString(rawValue, runtimeProfile);
  return SUPPORTED_RUNTIME_PROFILES.includes(profile) ? profile : runtimeProfile;
}

export function normalizeProjectManifest(rawManifest = {}, options = {}) {
  const hostPlatform = nonEmptyString(options.hostPlatform, os.platform());
  const runtimeProfile = resolveRuntimeProfile(rawManifest.runtimeProfile);
  const queueProfile = resolveQueueProfile(rawManifest.queueProfile, runtimeProfile);
  const runtimePreset = getRuntimePreset(runtimeProfile);
  const queuePreset = getRuntimePreset(queueProfile).queue;
  const repoPath = nonEmptyString(rawManifest.repoPath, ".");
  const projectName = nonEmptyString(rawManifest.projectName, defaultProjectName(repoPath));
  const deploymentProfile = nonEmptyString(rawManifest.deploymentProfile, defaultDeploymentProfile(hostPlatform));
  const toolingProfiles = normalizeToolingProfiles(rawManifest.toolingProfiles);
  const stack = normalizeStack(rawManifest.stack);

  const security = deepMerge(runtimePreset.security, isPlainObject(rawManifest.security) ? rawManifest.security : {});
  const tooling = deepMerge(
    {
      installScripts: [],
      allowUnsafeCommands: false
    },
    isPlainObject(rawManifest.tooling) ? rawManifest.tooling : {}
  );
  const agent = deepMerge(runtimePreset.agent, isPlainObject(rawManifest.agent) ? rawManifest.agent : {});
  const telegramInput = isPlainObject(rawManifest.telegram) ? rawManifest.telegram : {};
  const telegram = deepMerge(runtimePreset.telegram, telegramInput);
  const acp = deepMerge(runtimePreset.acp, isPlainObject(rawManifest.acp) ? rawManifest.acp : {});
  const queue = deepMerge(queuePreset, isPlainObject(rawManifest.queue) ? rawManifest.queue : {});
  const messages = deepMerge(runtimePreset.messages, isPlainObject(rawManifest.messages) ? rawManifest.messages : {});
  const tools = deepMerge(runtimePreset.tools, isPlainObject(rawManifest.tools) ? rawManifest.tools : {});

  const allowedAgents = uniqueStrings([
    ...toStringArray(acp.allowedAgents, []).map((value) => normalizeAcpAgentValue(value)),
    ...toStringArray(acp.defaultAgent ? [acp.defaultAgent] : [], []).map((value) => normalizeAcpAgentValue(value)),
  ]);

  telegram.groups = normalizeGroups(telegram.groups, runtimePreset.telegram?.groups ?? {});
  telegram.threadBindings = {
    spawnAcpSessions: resolveBoolean(telegram.threadBindings?.spawnAcpSessions, false),
  };
  telegram.network = {
    autoSelectFamily: resolveBoolean(telegram.network?.autoSelectFamily, true),
  };
  telegram.streamMode = nonEmptyString(telegram.streamMode, "partial");

  agent.id = nonEmptyString(agent.id, "workspace");
  agent.name = nonEmptyString(agent.name, defaultAgentName(projectName, repoPath));
  agent.defaultModel = nonEmptyString(agent.defaultModel, "");
  agent.installScripts = toStringArray(agent.installScripts, []);
  agent.verboseDefault = nonEmptyString(agent.verboseDefault, "on");
  agent.thinkingDefault = nonEmptyString(agent.thinkingDefault, "adaptive");
  agent.blockStreamingDefault = nonEmptyString(agent.blockStreamingDefault, "off");
  agent.blockStreamingBreak = nonEmptyString(agent.blockStreamingBreak, "text_end");
  agent.typingMode = nonEmptyString(agent.typingMode, "message");
  agent.typingIntervalSeconds = resolveInteger(agent.typingIntervalSeconds, 0);
  agent.maxConcurrent = resolveInteger(agent.maxConcurrent, 4);
  agent.skipBootstrap = resolveBoolean(agent.skipBootstrap, true);
  agent.tools = {
    deny: uniqueStrings([
      ...toStringArray(agent.tools?.deny, []),
      ...toStringArray(security.toolDeny, []),
    ]),
  };

  queue.mode = nonEmptyString(queue.mode, "steer");
  queue.debounceMs = resolveInteger(queue.debounceMs, 0);
  queue.cap = resolveInteger(queue.cap, 20);
  queue.inboundDebounceMs = resolveInteger(queue.inboundDebounceMs, 0);

  tools.exec = {
    timeoutSec: resolveInteger(tools.exec?.timeoutSec, 600),
  };

  acp.defaultAgent = normalizeAcpAgentValue(nonEmptyString(acp.defaultAgent, ""));
  acp.allowedAgents = allowedAgents;
  acp.preferredMode = nonEmptyString(acp.preferredMode, "oneshot");
  acp.maxConcurrentSessions = resolveInteger(acp.maxConcurrentSessions, 4);
  acp.ttlMinutes = resolveInteger(acp.ttlMinutes, 120);
  acp.stream = {
    coalesceIdleMs: resolveInteger(acp.stream?.coalesceIdleMs, 300),
    maxChunkChars: resolveInteger(acp.stream?.maxChunkChars, 1200),
  };

  security.authBootstrapMode = nonEmptyString(security.authBootstrapMode, "external");
  security.commandLoggerEnabled = resolveBoolean(security.commandLoggerEnabled, true);
  security.toolDeny = uniqueStrings(toStringArray(security.toolDeny, ["process"]));
  tooling.installScripts = toStringArray(tooling.installScripts, []);
  tooling.allowUnsafeCommands = resolveBoolean(tooling.allowUnsafeCommands, false);

  return {
    projectName,
    repoPath,
    deploymentProfile,
    toolingProfiles,
    tooling,
    stack,
    toolingInstallCommand: nonEmptyString(rawManifest.toolingInstallCommand, ""),
    runtimeProfile,
    queueProfile,
    agent,
    queue,
    telegram,
    acp,
    messages,
    tools,
    security,
  };
}

function pushError(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateProjectManifest(manifest) {
  const errors = [];
  pushError(errors, Boolean(manifest.projectName), "projectName is required");
  pushError(errors, Boolean(manifest.repoPath), "repoPath is required");
  pushError(errors, SUPPORTED_DEPLOYMENT_PROFILES.includes(manifest.deploymentProfile), `deploymentProfile must be one of ${SUPPORTED_DEPLOYMENT_PROFILES.join(", ")}`);
  pushError(errors, Array.isArray(manifest.toolingProfiles), "toolingProfiles must be an array");
  pushError(errors, validateToolingProfiles(manifest.toolingProfiles), "toolingProfiles must contain only supported versioned tooling profiles");
  pushError(errors, Array.isArray(manifest.tooling?.installScripts), "tooling.installScripts must be an array");
  pushError(
    errors,
    Array.isArray(manifest.tooling?.installScripts) && manifest.tooling.installScripts.every((entry) => typeof entry === "string"),
    "tooling.installScripts must contain only strings"
  );
  pushError(errors, typeof manifest.tooling?.allowUnsafeCommands === "boolean", "tooling.allowUnsafeCommands must be a boolean");
  pushError(errors, SUPPORTED_RUNTIME_PROFILES.includes(manifest.runtimeProfile), `runtimeProfile must be one of ${SUPPORTED_RUNTIME_PROFILES.join(", ")}`);
  pushError(errors, SUPPORTED_RUNTIME_PROFILES.includes(manifest.queueProfile), `queueProfile must be one of ${SUPPORTED_RUNTIME_PROFILES.join(", ")}`);
  pushError(errors, Array.isArray(manifest.stack?.languages), "stack.languages must be an array");
  pushError(errors, Array.isArray(manifest.stack?.tools), "stack.tools must be an array");
  pushError(errors, Boolean(manifest.agent?.id), "agent.id is required");
  pushError(errors, Array.isArray(manifest.agent?.installScripts), "agent.installScripts must be an array");
  pushError(errors, Number.isInteger(manifest.agent?.maxConcurrent) && manifest.agent.maxConcurrent > 0, "agent.maxConcurrent must be a positive integer");
  pushError(errors, ["collect", "steer"].includes(manifest.queue?.mode), "queue.mode must be collect or steer");
  pushError(errors, Number.isInteger(manifest.queue?.debounceMs) && manifest.queue.debounceMs >= 0, "queue.debounceMs must be >= 0");
  pushError(errors, Number.isInteger(manifest.queue?.cap) && manifest.queue.cap > 0, "queue.cap must be > 0");
  pushError(errors, ["pairing", "allowlist", "open", "disabled"].includes(manifest.telegram?.dmPolicy), "telegram.dmPolicy must be pairing, allowlist, open, or disabled");
  pushError(errors, ["disabled", "allowlist", "open"].includes(manifest.telegram?.groupPolicy), "telegram.groupPolicy must be disabled, allowlist, or open");
  pushError(errors, ["partial", "block", "off"].includes(manifest.telegram?.streamMode), "telegram.streamMode must be partial, block, or off");
  pushError(errors, ["off", "first", "all"].includes(manifest.telegram?.replyToMode), "telegram.replyToMode must be off, first, or all");
  pushError(errors, ["minimal", "off", "full"].includes(nonEmptyString(manifest.telegram?.reactionLevel, "minimal")), "telegram.reactionLevel must be minimal, off, or full");
  pushError(errors, Boolean(manifest.acp?.defaultAgent), "acp.defaultAgent is required");
  pushError(errors, isSupportedAcpAgent(manifest.acp?.defaultAgent), `acp.defaultAgent must be one of ${formatSupportedAcpAgents()}`);
  pushError(errors, Array.isArray(manifest.acp?.allowedAgents) && manifest.acp.allowedAgents.length > 0, "acp.allowedAgents must contain at least one agent");
  pushError(
    errors,
    Array.isArray(manifest.acp?.allowedAgents) && manifest.acp.allowedAgents.every((agent) => isSupportedAcpAgent(agent)),
    `acp.allowedAgents must contain only supported agents: ${formatSupportedAcpAgents()}`
  );
  pushError(errors, Number.isInteger(manifest.acp?.maxConcurrentSessions) && manifest.acp.maxConcurrentSessions > 0, "acp.maxConcurrentSessions must be > 0");
  pushError(errors, Number.isInteger(manifest.tools?.exec?.timeoutSec) && manifest.tools.exec.timeoutSec > 0, "tools.exec.timeoutSec must be > 0");
  pushError(errors, ["codex", "gemini", "copilot", "external", "none"].includes(normalizeAuthMode(manifest.security?.authBootstrapMode)), "security.authBootstrapMode must be codex, gemini, copilot, external, or none");
  return errors;
}

export function normalizeAuthMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "external";
  if (["external", "none", "codex", "gemini", "copilot"].includes(normalized)) return normalized;
  if (["off", "skip"].includes(normalized)) return "none";
  return normalized;
}

function defaultWorkspacePath() {
  return "/workspace";
}

function defaultControlUiOrigins(gatewayPort) {
  return [`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`];
}

export function buildOpenClawConfig(manifest, env = process.env) {
  const gatewayPort = resolveInteger(env.OPENCLAW_GATEWAY_PORT, 18789);
  const workspace = nonEmptyString(env.OPENCLAW_WORKSPACE, defaultWorkspacePath());
  const repoRoot = nonEmptyString(env.OPENCLAW_REPO_ROOT, workspace);
  const controlUiAllowedOrigins = parseStringArrayEnv(
    env.OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS,
    defaultControlUiOrigins(gatewayPort),
  );
  const pluginId = nonEmptyString(env.OPENCLAW_WORKSPACE_PLUGIN_ID, "workspace-openclaw");
  const pluginPath = nonEmptyString(env.OPENCLAW_WORKSPACE_PLUGIN_PATH, "/opt/openclaw/plugins/workspace-openclaw");
  const authBootstrapMode = nonEmptyString(env.OPENCLAW_BOOTSTRAP_AUTH_MODE, manifest.security.authBootstrapMode);
  const acpDefaultAgent = nonEmptyString(env.OPENCLAW_ACP_DEFAULT_AGENT, manifest.acp.defaultAgent);
  const providerPluginId = resolveProviderPluginId(acpDefaultAgent);
  const fallbackModelProvider = resolveDefaultModelProvider({
    defaultAgent: acpDefaultAgent,
    authMode: authBootstrapMode,
    env
  });

  const agentId = nonEmptyString(env.OPENCLAW_AGENT_ID, manifest.agent.id);
  const agentName = nonEmptyString(env.OPENCLAW_AGENT_NAME, manifest.agent.name);
  const agentDir = nonEmptyString(env.OPENCLAW_AGENT_DIR, manifest.agent.agentDir || `/home/node/.openclaw/agents/${agentId}/agent`);
  const acpAllowedAgents = uniqueStrings([
    acpDefaultAgent,
    ...parseStringArrayEnv(env.OPENCLAW_ACP_ALLOWED_AGENTS, manifest.acp.allowedAgents),
  ]);
  const configuredAgentDefaultModel = nonEmptyString(env.OPENCLAW_AGENT_DEFAULT_MODEL, manifest.agent.defaultModel);
  const agentModelCatalog = acpAllowedAgents.length > 1
    ? buildAllProvidersModelCatalog({
        allowedAgents: acpAllowedAgents,
        defaultAgent: acpDefaultAgent,
        defaultModel: configuredAgentDefaultModel,
        authMode: authBootstrapMode,
        env
      })
    : buildCurrentProviderModelCatalog({
        provider: fallbackModelProvider,
        defaultAgent: acpDefaultAgent,
        defaultModel: configuredAgentDefaultModel,
        authMode: authBootstrapMode,
        env
      });
  const startupSafeCopilotDefaultModel = fallbackModelProvider === "github-copilot"
    && resolveBoolean(env.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES, false)
    ? getLatestCurrentProviderModel(fallbackModelProvider, env)
    : "";
  const agentDefaultModel = resolvePrimaryModelRef({
    provider: fallbackModelProvider,
    defaultAgent: acpDefaultAgent,
    defaultModel: configuredAgentDefaultModel,
    authMode: authBootstrapMode,
    catalog: startupSafeCopilotDefaultModel
      ? { [startupSafeCopilotDefaultModel]: {} }
      : (
          fallbackModelProvider === "github-copilot"
          && resolveBoolean(env.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES, false)
            ? {}
            : agentModelCatalog
        ),
    env,
  });
  const agentVerboseDefault = nonEmptyString(env.OPENCLAW_AGENT_VERBOSE_DEFAULT, manifest.agent.verboseDefault);
  const agentThinkingDefault = nonEmptyString(env.OPENCLAW_AGENT_THINKING_DEFAULT, manifest.agent.thinkingDefault);
  const agentBlockStreamingDefault = nonEmptyString(env.OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT, manifest.agent.blockStreamingDefault);
  const agentBlockStreamingBreak = nonEmptyString(env.OPENCLAW_AGENT_BLOCK_STREAMING_BREAK, manifest.agent.blockStreamingBreak);
  const agentTypingMode = nonEmptyString(env.OPENCLAW_AGENT_TYPING_MODE, manifest.agent.typingMode);
  const agentTypingIntervalSeconds = resolveInteger(env.OPENCLAW_AGENT_TYPING_INTERVAL_SECONDS, manifest.agent.typingIntervalSeconds);
  const agentSkipBootstrap = resolveBoolean(env.OPENCLAW_AGENT_SKIP_BOOTSTRAP, manifest.agent.skipBootstrap);
  const agentsMaxConcurrent = resolveInteger(env.OPENCLAW_AGENTS_MAX_CONCURRENT, manifest.agent.maxConcurrent);
  const agentToolsDeny = parseStringArrayEnv(env.OPENCLAW_AGENT_TOOLS_DENY, manifest.agent.tools.deny);

  const queueMode = nonEmptyString(env.OPENCLAW_QUEUE_MODE, manifest.queue.mode);
  const queueDebounceMs = resolveInteger(env.OPENCLAW_QUEUE_DEBOUNCE_MS, manifest.queue.debounceMs);
  const queueCap = resolveInteger(env.OPENCLAW_QUEUE_CAP, manifest.queue.cap);
  const inboundDebounceMs = resolveInteger(env.OPENCLAW_INBOUND_DEBOUNCE_MS, manifest.queue.inboundDebounceMs);

  const telegramDmPolicy = nonEmptyString(env.OPENCLAW_TELEGRAM_DM_POLICY, manifest.telegram.dmPolicy);
  const telegramGroupPolicy = nonEmptyString(env.OPENCLAW_TELEGRAM_GROUP_POLICY, manifest.telegram.groupPolicy);
  const telegramStreamMode = nonEmptyString(env.OPENCLAW_TELEGRAM_STREAM_MODE, manifest.telegram.streamMode);
  const telegramBlockStreaming = resolveBoolean(env.OPENCLAW_TELEGRAM_BLOCK_STREAMING, manifest.telegram.blockStreaming);
  const telegramReplyToMode = nonEmptyString(env.OPENCLAW_TELEGRAM_REPLY_TO_MODE, manifest.telegram.replyToMode);
  const telegramReactionLevel = nonEmptyString(env.OPENCLAW_TELEGRAM_REACTION_LEVEL, manifest.telegram.reactionLevel);
  const telegramEnabled = resolveBoolean(env.OPENCLAW_TELEGRAM_ENABLED, manifest.telegram.enabled);
  const telegramNetworkAutoSelectFamily = resolveBoolean(
    env.OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY,
    manifest.telegram.network.autoSelectFamily,
  );
  const acpPreferredMode = nonEmptyString(env.OPENCLAW_ACP_PREFERRED_MODE, manifest.acp.preferredMode);
  const acpMaxConcurrentSessions = resolveInteger(env.OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS, manifest.acp.maxConcurrentSessions);
  const acpTtlMinutes = resolveInteger(env.OPENCLAW_ACP_TTL_MINUTES, manifest.acp.ttlMinutes);
  const acpStreamCoalesceIdleMs = resolveInteger(env.OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS, manifest.acp.stream.coalesceIdleMs);
  const acpStreamMaxChunkChars = resolveInteger(env.OPENCLAW_ACP_STREAM_MAX_CHARS, manifest.acp.stream.maxChunkChars);

  const acpxPermissionMode = nonEmptyString(env.OPENCLAW_ACPX_PERMISSION_MODE, "approve-all");
  const acpxNonInteractivePermissions = nonEmptyString(env.OPENCLAW_ACPX_NON_INTERACTIVE_PERMISSIONS, "fail");
  const acpxCommand = nonEmptyString(env.OPENCLAW_ACPX_COMMAND, "");
  const acpxExpectedVersion = nonEmptyString(env.OPENCLAW_ACPX_EXPECTED_VERSION, "");
  const execTimeoutSec = resolveInteger(env.OPENCLAW_EXEC_TIMEOUT_SEC, manifest.tools.exec.timeoutSec);

  const bootstrapFiles = [
    "AGENTS.md",
    "README.md",
    ".openclaw/instructions.md",
  ];

  return {
    config: {
      gateway: {
        mode: "local",
        controlUi: {
          allowedOrigins: controlUiAllowedOrigins,
        },
      },
      agents: {
        defaults: {
          maxConcurrent: agentsMaxConcurrent,
          skipBootstrap: agentSkipBootstrap,
          ...(agentDefaultModel
            ? {
                model: {
                  primary: agentDefaultModel,
                },
                ...(Object.keys(agentModelCatalog).length > 0
                  ? {
                      models: agentModelCatalog,
                    }
                  : {}),
              }
            : {}),
          verboseDefault: agentVerboseDefault,
          ...(agentThinkingDefault ? { thinkingDefault: agentThinkingDefault } : {}),
          blockStreamingDefault: agentBlockStreamingDefault,
          blockStreamingBreak: agentBlockStreamingBreak,
          ...(agentTypingMode ? { typingMode: agentTypingMode } : {}),
          ...(agentTypingIntervalSeconds > 0 ? { typingIntervalSeconds: agentTypingIntervalSeconds } : {}),
        },
        list: [
          {
            id: agentId,
            default: true,
            name: agentName,
            workspace,
            agentDir,
            tools: agentToolsDeny.length > 0 ? { deny: agentToolsDeny } : undefined,
          },
        ],
      },
      bindings: [
        {
          match: {
            channel: "telegram",
          },
          agentId,
        },
      ],
      messages: {
        inbound: {
          debounceMs: inboundDebounceMs,
          byChannel: {
            telegram: inboundDebounceMs,
          },
        },
        queue: {
          mode: queueMode,
          debounceMs: queueDebounceMs,
          cap: queueCap,
          drop: "summarize",
          byChannel: {
            telegram: queueMode,
          },
        },
        ...(manifest.messages.statusReactions ? { statusReactions: manifest.messages.statusReactions } : {}),
      },
      channels: {
        telegram: {
          enabled: telegramEnabled,
          dmPolicy: telegramDmPolicy,
          groupPolicy: telegramGroupPolicy,
          streamMode: telegramStreamMode,
          blockStreaming: telegramBlockStreaming,
          replyToMode: telegramReplyToMode,
          reactionLevel: telegramReactionLevel,
          configWrites: resolveBoolean(env.OPENCLAW_TELEGRAM_CONFIG_WRITES, manifest.telegram.configWrites),
          groups: manifest.telegram.groups,
          network: {
            autoSelectFamily: telegramNetworkAutoSelectFamily,
          },
          ...(manifest.telegram.threadBindings.spawnAcpSessions
            ? {
                threadBindings: {
                  enabled: true,
                  spawnAcpSessions: true,
                },
              }
            : {}),
        },
      },
      tools: {
        exec: {
          timeoutSec: execTimeoutSec,
        },
      },
      hooks: {
        internal: {
          enabled: true,
          entries: {
            "bootstrap-extra-files": {
              enabled: bootstrapFiles.length > 0,
              paths: bootstrapFiles,
            },
            "command-logger": {
              enabled: resolveBoolean(env.OPENCLAW_COMMAND_LOGGER_ENABLED, manifest.security.commandLoggerEnabled),
            },
          },
        },
      },
      acp: {
        enabled: true,
        dispatch: {
          enabled: true,
        },
        backend: "acpx",
        defaultAgent: acpDefaultAgent,
        allowedAgents: acpAllowedAgents,
        maxConcurrentSessions: acpMaxConcurrentSessions,
        stream: {
          coalesceIdleMs: acpStreamCoalesceIdleMs,
          maxChunkChars: acpStreamMaxChunkChars,
        },
        runtime: {
          ttlMinutes: acpTtlMinutes,
        },
      },
      plugins: {
        allow: uniqueStrings(["acpx", "telegram", providerPluginId, pluginId].filter(Boolean)),
        load: {
          paths: [pluginPath],
        },
        entries: {
          acpx: {
            enabled: true,
            config: {
              ...(acpxCommand ? { command: acpxCommand } : {}),
              ...(acpxExpectedVersion ? { expectedVersion: acpxExpectedVersion } : {}),
              permissionMode: acpxPermissionMode,
              nonInteractivePermissions: acpxNonInteractivePermissions,
            },
          },
          telegram: {
            enabled: telegramEnabled,
            config: {},
          },
          ...(providerPluginId
            ? {
                [providerPluginId]: {
                  enabled: true,
                  config: {},
                },
              }
            : {}),
          [pluginId]: {
            enabled: true,
            config: {
              projectName: manifest.projectName,
              repoPath: manifest.repoPath,
              deploymentProfile: manifest.deploymentProfile,
              runtimeProfile: manifest.runtimeProfile,
              queueProfile: manifest.queueProfile,
              workspace,
              repoRoot,
              toolingProfiles: manifest.toolingProfiles,
              stack: manifest.stack,
              agentDefaultModel,
              agentVerboseDefault,
              agentThinkingDefault,
              agentToolsDeny,
              acpAllowedAgents,
              preferredAcpAgent: acpDefaultAgent,
              preferredAcpMode: acpPreferredMode,
              telegramBlockStreaming,
              telegramDmPolicy,
              telegramGroupPolicy,
              telegramStreamMode,
              telegramThreadBindingsEnabled: manifest.telegram.threadBindings.spawnAcpSessions,
              defaultQueueMode: queueMode,
            },
          },
        },
      },
    },
    metadata: {
      bootstrapFiles,
      runtimeProfile: manifest.runtimeProfile,
      queueProfile: manifest.queueProfile,
      deploymentProfile: manifest.deploymentProfile,
      telegramThreadBindingsEnabled: manifest.telegram.threadBindings.spawnAcpSessions,
    },
  };
}

export function buildManifestStatus(manifest, errors = []) {
  return {
    projectName: manifest.projectName,
    repoPath: manifest.repoPath,
    deploymentProfile: manifest.deploymentProfile,
    runtimeProfile: manifest.runtimeProfile,
    queueProfile: manifest.queueProfile,
    toolingProfiles: manifest.toolingProfiles,
    stack: manifest.stack,
    errors,
  };
}

/**
 * Build a manifest structure from environment variables for runtime scripts.
 */
export function buildManifestFromEnv(env = process.env) {
  const gatewayPort = resolveInteger(env.OPENCLAW_GATEWAY_PORT, 18789);
  const repoPath = nonEmptyString(env.OPENCLAW_REPO_ROOT, ".");
  const repoIdentityPath = nonEmptyString(env.OPENCLAW_REPO_ROOT_HOST, repoPath);
  const projectName = nonEmptyString(env.OPENCLAW_PROJECT_NAME, defaultProjectName(repoIdentityPath));
  const runtimeProfile = nonEmptyString(env.OPENCLAW_RUNTIME_PROFILE, "stable-chat");
  const queueProfile = nonEmptyString(env.OPENCLAW_QUEUE_PROFILE, runtimeProfile);
  const deploymentProfile = nonEmptyString(env.OPENCLAW_DEPLOYMENT_PROFILE, defaultDeploymentProfile(env.OPENCLAW_HOST_PLATFORM));
  const toolingProfiles = parseToolingProfilesEnv(env.OPENCLAW_TOOLING_PROFILES);
  const stack = env.OPENCLAW_STACK ? parseStackEnv(env.OPENCLAW_STACK) : createEmptyStack();

  const agent = {
    id: nonEmptyString(env.OPENCLAW_AGENT_ID, "workspace"),
    name: nonEmptyString(env.OPENCLAW_AGENT_NAME, defaultAgentName(projectName, repoIdentityPath)),
    defaultModel: nonEmptyString(env.OPENCLAW_AGENT_DEFAULT_MODEL, ""),
    installScripts: parseStringArrayEnv(env.OPENCLAW_AGENT_INSTALL_SCRIPTS, []),
    verboseDefault: nonEmptyString(env.OPENCLAW_AGENT_VERBOSE_DEFAULT, "on"),
    thinkingDefault: nonEmptyString(env.OPENCLAW_AGENT_THINKING_DEFAULT, "adaptive"),
    blockStreamingDefault: nonEmptyString(env.OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT, "off"),
    blockStreamingBreak: nonEmptyString(env.OPENCLAW_AGENT_BLOCK_STREAMING_BREAK, "text_end"),
    typingMode: nonEmptyString(env.OPENCLAW_AGENT_TYPING_MODE, "message"),
    typingIntervalSeconds: resolveInteger(env.OPENCLAW_AGENT_TYPING_INTERVAL_SECONDS, 12),
    maxConcurrent: resolveInteger(env.OPENCLAW_AGENTS_MAX_CONCURRENT, 4),
    skipBootstrap: resolveBoolean(env.OPENCLAW_AGENT_SKIP_BOOTSTRAP, true),
    tools: {
      deny: parseStringArrayEnv(env.OPENCLAW_AGENT_TOOLS_DENY, ["process"]),
    },
  };

  const queue = {
    mode: nonEmptyString(env.OPENCLAW_QUEUE_MODE, "steer"),
    debounceMs: resolveInteger(env.OPENCLAW_QUEUE_DEBOUNCE_MS, 250),
    cap: resolveInteger(env.OPENCLAW_QUEUE_CAP, 20),
    inboundDebounceMs: resolveInteger(env.OPENCLAW_INBOUND_DEBOUNCE_MS, 150),
  };

  const threadBindingsSpawnAcp = resolveBoolean(env.OPENCLAW_TELEGRAM_THREAD_BINDINGS_SPAWN_ACP, false);
  const telegram = {
    enabled: resolveBoolean(env.OPENCLAW_TELEGRAM_ENABLED, true),
    dmPolicy: nonEmptyString(env.OPENCLAW_TELEGRAM_DM_POLICY, "pairing"),
    groupPolicy: nonEmptyString(env.OPENCLAW_TELEGRAM_GROUP_POLICY, "disabled"),
    streamMode: nonEmptyString(env.OPENCLAW_TELEGRAM_STREAM_MODE, "partial"),
    blockStreaming: resolveBoolean(env.OPENCLAW_TELEGRAM_BLOCK_STREAMING, false),
    replyToMode: nonEmptyString(env.OPENCLAW_TELEGRAM_REPLY_TO_MODE, "all"),
    reactionLevel: nonEmptyString(env.OPENCLAW_TELEGRAM_REACTION_LEVEL, "minimal"),
    configWrites: resolveBoolean(env.OPENCLAW_TELEGRAM_CONFIG_WRITES, false),
    groups: { "*": { requireMention: true } },
    threadBindings: {
      spawnAcpSessions: threadBindingsSpawnAcp,
    },
    network: {
      autoSelectFamily: resolveBoolean(env.OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY, true),
    },
  };

  const acp = {
    defaultAgent: nonEmptyString(env.OPENCLAW_ACP_DEFAULT_AGENT, ""),
    allowedAgents: uniqueStrings([
      nonEmptyString(env.OPENCLAW_ACP_DEFAULT_AGENT, ""),
      ...parseStringArrayEnv(env.OPENCLAW_ACP_ALLOWED_AGENTS, []),
    ].filter(Boolean)),
    preferredMode: nonEmptyString(env.OPENCLAW_ACP_PREFERRED_MODE, "oneshot"),
    maxConcurrentSessions: resolveInteger(env.OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS, 4),
    ttlMinutes: resolveInteger(env.OPENCLAW_ACP_TTL_MINUTES, 120),
    stream: {
      coalesceIdleMs: resolveInteger(env.OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS, 300),
      maxChunkChars: resolveInteger(env.OPENCLAW_ACP_STREAM_MAX_CHARS, 1200),
    },
  };

  const tools = {
    exec: {
      timeoutSec: resolveInteger(env.OPENCLAW_EXEC_TIMEOUT_SEC, 600),
    },
  };

  const security = {
    authBootstrapMode: nonEmptyString(env.OPENCLAW_BOOTSTRAP_AUTH_MODE, "external"),
    commandLoggerEnabled: resolveBoolean(env.OPENCLAW_COMMAND_LOGGER_ENABLED, true),
    toolDeny: ["process"],
  };

  const messages = {
    statusReactions: { enabled: true },
  };

  return normalizeProjectManifest({
    projectName,
    repoPath,
    deploymentProfile,
    toolingProfiles,
    tooling: {
      installScripts: parseStringArrayEnv(env.OPENCLAW_TOOLING_INSTALL_SCRIPTS, []),
      allowUnsafeCommands: resolveBoolean(env.OPENCLAW_TOOLING_ALLOW_UNSAFE_COMMANDS, false)
    },
    stack,
    toolingInstallCommand: nonEmptyString(env.OPENCLAW_TOOLING_INSTALL_COMMAND, ""),
    runtimeProfile,
    queueProfile,
    agent,
    queue,
    telegram,
    acp,
    messages,
    tools,
    security,
  }, { hostPlatform: env.OPENCLAW_HOST_PLATFORM });
}
