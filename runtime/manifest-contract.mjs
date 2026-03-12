import os from "node:os";

import { deepMerge, parseStringArrayEnv, resolveBoolean, resolveInteger } from "./shared.mjs";
export const SUPPORTED_DEPLOYMENT_PROFILES = ["docker-local", "wsl2", "linux-vps", "native-dev"];
export const SUPPORTED_TOOLING_PROFILES = ["none", "java17", "node20", "python311", "go122", "polyglot"];
export const SUPPORTED_RUNTIME_PROFILES = ["stable-chat", "interactive-steer", "topic-bound-acp", "ci-runner"];

const RUNTIME_PROFILE_PRESETS = {
  "stable-chat": {
    queue: {
      mode: "collect",
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
      verboseDefault: "off",
      blockStreamingDefault: "off",
      blockStreamingBreak: "text_end",
      typingMode: "never",
      typingIntervalSeconds: 12,
      tools: {
        deny: ["process"],
      },
    },
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      streamMode: "partial",
      blockStreaming: false,
      replyToMode: "first",
      reactionLevel: "minimal",
      proxy: "",
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, fallback = "") {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

function toStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeTelegramPrincipal(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "*") return raw;
  if (/^tg:/i.test(raw) || /^telegram:/i.test(raw) || raw.startsWith("@")) return raw;
  if (/^-?\d+$/.test(raw)) return `tg:${raw}`;
  return raw;
}

function normalizePrincipalArray(value) {
  return uniqueStrings(toStringArray(value).map((entry) => normalizeTelegramPrincipal(entry)));
}

function defaultAgentName(projectName) {
  const normalizedProjectName = String(projectName ?? "").trim();
  return normalizedProjectName ? `${normalizedProjectName} Workspace` : "Workspace";
}

function defaultDeploymentProfile(hostPlatform = os.platform()) {
  return hostPlatform === "win32" ? "wsl2" : "docker-local";
}

function defaultProjectName(repoPath) {
  const normalized = String(repoPath ?? "").trim();
  if (!normalized) return "workspace";
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || "workspace";
}

function getRuntimePreset(name) {
  const runtimeProfile = nonEmptyString(name, "stable-chat");
  return deepMerge(RUNTIME_PROFILE_PRESETS["stable-chat"], RUNTIME_PROFILE_PRESETS[runtimeProfile] ?? {});
}

function normalizeGroups(value, fallback) {
  if (!isObject(value)) return deepMerge(fallback);
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
  const toolingProfile = nonEmptyString(rawManifest.toolingProfile, "none");
  const knowledgeFiles = uniqueStrings(toStringArray(rawManifest.knowledgeFiles, []));
  const instructionFiles = uniqueStrings([
    ...toStringArray(rawManifest.instructionFiles, ["AGENTS.md"]),
    ...knowledgeFiles,
  ]);
  const verificationCommands = uniqueStrings(toStringArray(rawManifest.verificationCommands, []));

  const security = deepMerge(runtimePreset.security, isObject(rawManifest.security) ? rawManifest.security : {});
  const agent = deepMerge(runtimePreset.agent, isObject(rawManifest.agent) ? rawManifest.agent : {});
  const telegramInput = isObject(rawManifest.telegram) ? rawManifest.telegram : {};
  const telegram = deepMerge(runtimePreset.telegram, telegramInput);
  const acp = deepMerge(runtimePreset.acp, isObject(rawManifest.acp) ? rawManifest.acp : {});
  const queue = deepMerge(queuePreset, isObject(rawManifest.queue) ? rawManifest.queue : {});
  const messages = deepMerge(runtimePreset.messages, isObject(rawManifest.messages) ? rawManifest.messages : {});
  const tools = deepMerge(runtimePreset.tools, isObject(rawManifest.tools) ? rawManifest.tools : {});

  const allowedAgents = uniqueStrings([
    ...toStringArray(acp.allowedAgents, []),
    ...toStringArray(acp.defaultAgent ? [acp.defaultAgent] : [], []),
  ]);

  telegram.allowFrom = normalizePrincipalArray(telegram.allowFrom);
  telegram.groupAllowFrom = normalizePrincipalArray(telegram.groupAllowFrom);
  telegram.proxy = nonEmptyString(telegram.proxy, "");
  telegram.groups = normalizeGroups(telegram.groups, runtimePreset.telegram?.groups ?? {});
  telegram.threadBindings = {
    spawnAcpSessions: resolveBoolean(telegram.threadBindings?.spawnAcpSessions, false),
  };
  telegram.network = {
    autoSelectFamily: resolveBoolean(telegram.network?.autoSelectFamily, true),
  };
  telegram.streamMode = nonEmptyString(telegram.streamMode ?? telegram.streaming, "partial");
  delete telegram.streaming;

  agent.id = nonEmptyString(agent.id, "workspace");
  agent.name = nonEmptyString(agent.name, defaultAgentName(projectName));
  agent.defaultModel = nonEmptyString(agent.defaultModel, "");
  agent.verboseDefault = nonEmptyString(agent.verboseDefault, "off");
  agent.blockStreamingDefault = nonEmptyString(agent.blockStreamingDefault, "off");
  agent.blockStreamingBreak = nonEmptyString(agent.blockStreamingBreak, "text_end");
  agent.typingMode = nonEmptyString(agent.typingMode, "");
  agent.typingIntervalSeconds = resolveInteger(agent.typingIntervalSeconds, 0);
  agent.maxConcurrent = resolveInteger(agent.maxConcurrent, 4);
  agent.skipBootstrap = resolveBoolean(agent.skipBootstrap, true);
  agent.tools = {
    deny: uniqueStrings([
      ...toStringArray(agent.tools?.deny, []),
      ...toStringArray(security.toolDeny, []),
    ]),
  };

  queue.mode = nonEmptyString(queue.mode, "collect");
  queue.debounceMs = resolveInteger(queue.debounceMs, 0);
  queue.cap = resolveInteger(queue.cap, 20);
  queue.inboundDebounceMs = resolveInteger(queue.inboundDebounceMs, 0);

  tools.exec = {
    timeoutSec: resolveInteger(tools.exec?.timeoutSec, 600),
  };

  acp.defaultAgent = nonEmptyString(acp.defaultAgent, "");
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

  return {
    version: resolveInteger(rawManifest.version, 1),
    projectName,
    repoPath,
    deploymentProfile,
    toolingProfile,
    toolingInstallCommand: nonEmptyString(rawManifest.toolingInstallCommand, ""),
    runtimeProfile,
    queueProfile,
    instructionFiles,
    knowledgeFiles,
    verificationCommands,
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
  pushError(errors, Number(manifest.version) === 1, "version must be 1");
  pushError(errors, Boolean(manifest.projectName), "projectName is required");
  pushError(errors, Boolean(manifest.repoPath), "repoPath is required");
  pushError(errors, SUPPORTED_DEPLOYMENT_PROFILES.includes(manifest.deploymentProfile), `deploymentProfile must be one of ${SUPPORTED_DEPLOYMENT_PROFILES.join(", ")}`);
  pushError(errors, SUPPORTED_TOOLING_PROFILES.includes(manifest.toolingProfile), `toolingProfile must be one of ${SUPPORTED_TOOLING_PROFILES.join(", ")}`);
  pushError(errors, SUPPORTED_RUNTIME_PROFILES.includes(manifest.runtimeProfile), `runtimeProfile must be one of ${SUPPORTED_RUNTIME_PROFILES.join(", ")}`);
  pushError(errors, SUPPORTED_RUNTIME_PROFILES.includes(manifest.queueProfile), `queueProfile must be one of ${SUPPORTED_RUNTIME_PROFILES.join(", ")}`);
  pushError(errors, Array.isArray(manifest.instructionFiles), "instructionFiles must be an array");
  pushError(errors, Array.isArray(manifest.verificationCommands), "verificationCommands must be an array");
  pushError(errors, Array.isArray(manifest.knowledgeFiles), "knowledgeFiles must be an array");
  pushError(errors, Boolean(manifest.agent?.id), "agent.id is required");
  pushError(errors, Number.isInteger(manifest.agent?.maxConcurrent) && manifest.agent.maxConcurrent > 0, "agent.maxConcurrent must be a positive integer");
  pushError(errors, ["collect", "steer"].includes(manifest.queue?.mode), "queue.mode must be collect or steer");
  pushError(errors, Number.isInteger(manifest.queue?.debounceMs) && manifest.queue.debounceMs >= 0, "queue.debounceMs must be >= 0");
  pushError(errors, Number.isInteger(manifest.queue?.cap) && manifest.queue.cap > 0, "queue.cap must be > 0");
  pushError(errors, ["pairing", "allowlist", "open", "disabled"].includes(manifest.telegram?.dmPolicy), "telegram.dmPolicy must be pairing, allowlist, open, or disabled");
  pushError(errors, ["disabled", "allowlist", "open"].includes(manifest.telegram?.groupPolicy), "telegram.groupPolicy must be disabled, allowlist, or open");
  pushError(errors, ["partial", "block", "off"].includes(manifest.telegram?.streamMode), "telegram.streamMode must be partial, block, or off");
  pushError(errors, ["first", "latest"].includes(manifest.telegram?.replyToMode), "telegram.replyToMode must be first or latest");
  pushError(errors, ["minimal", "off", "full"].includes(nonEmptyString(manifest.telegram?.reactionLevel, "minimal")), "telegram.reactionLevel must be minimal, off, or full");
  pushError(errors, Boolean(manifest.acp?.defaultAgent), "acp.defaultAgent is required");
  pushError(errors, Array.isArray(manifest.acp?.allowedAgents) && manifest.acp.allowedAgents.length > 0, "acp.allowedAgents must contain at least one agent");
  pushError(errors, Number.isInteger(manifest.acp?.maxConcurrentSessions) && manifest.acp.maxConcurrentSessions > 0, "acp.maxConcurrentSessions must be > 0");
  pushError(errors, Number.isInteger(manifest.tools?.exec?.timeoutSec) && manifest.tools.exec.timeoutSec > 0, "tools.exec.timeoutSec must be > 0");
  pushError(errors, ["codex", "external", "none"].includes(normalizeAuthMode(manifest.security?.authBootstrapMode)), "security.authBootstrapMode must be codex, external, or none");
  return errors;
}

export function normalizeAuthMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "external";
  if (["external", "none", "codex"].includes(normalized)) return normalized;
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
  const pluginId = nonEmptyString(env.OPENCLAW_WORKSPACE_PLUGIN_ID ?? env.OPENCLAW_REPO_PLUGIN_ID, "workspace-openclaw");
  const pluginPath = nonEmptyString(
    env.OPENCLAW_WORKSPACE_PLUGIN_PATH ?? env.OPENCLAW_REPO_PLUGIN_PATH,
    "/opt/openclaw/plugins/workspace-openclaw",
  );

  const agentId = nonEmptyString(env.OPENCLAW_AGENT_ID, manifest.agent.id);
  const agentName = nonEmptyString(env.OPENCLAW_AGENT_NAME, manifest.agent.name);
  const agentDir = nonEmptyString(env.OPENCLAW_AGENT_DIR, manifest.agent.agentDir || `/home/node/.openclaw/agents/${agentId}/agent`);
  const agentDefaultModel = nonEmptyString(env.OPENCLAW_AGENT_DEFAULT_MODEL, manifest.agent.defaultModel);
  const agentVerboseDefault = nonEmptyString(env.OPENCLAW_AGENT_VERBOSE_DEFAULT, manifest.agent.verboseDefault);
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
  const telegramStreamMode = nonEmptyString(
    env.OPENCLAW_TELEGRAM_STREAM_MODE,
    nonEmptyString(env.OPENCLAW_TELEGRAM_STREAMING, manifest.telegram.streamMode),
  );
  const telegramBlockStreaming = resolveBoolean(env.OPENCLAW_TELEGRAM_BLOCK_STREAMING, manifest.telegram.blockStreaming);
  const telegramReplyToMode = nonEmptyString(env.OPENCLAW_TELEGRAM_REPLY_TO_MODE, manifest.telegram.replyToMode);
  const telegramReactionLevel = nonEmptyString(env.OPENCLAW_TELEGRAM_REACTION_LEVEL, manifest.telegram.reactionLevel);
  const telegramEnabled = resolveBoolean(env.OPENCLAW_TELEGRAM_ENABLED, manifest.telegram.enabled);
  const telegramNetworkAutoSelectFamily = resolveBoolean(
    env.OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY,
    manifest.telegram.network.autoSelectFamily,
  );
  const telegramProxy = nonEmptyString(env.OPENCLAW_TELEGRAM_PROXY, manifest.telegram.proxy);

  const acpDefaultAgent = nonEmptyString(env.OPENCLAW_ACP_DEFAULT_AGENT, manifest.acp.defaultAgent);
  const acpAllowedAgents = uniqueStrings([
    acpDefaultAgent,
    ...parseStringArrayEnv(env.OPENCLAW_ACP_ALLOWED_AGENTS, manifest.acp.allowedAgents),
  ]);
  const acpPreferredMode = nonEmptyString(env.OPENCLAW_ACP_PREFERRED_MODE, manifest.acp.preferredMode);
  const acpMaxConcurrentSessions = resolveInteger(env.OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS, manifest.acp.maxConcurrentSessions);
  const acpTtlMinutes = resolveInteger(env.OPENCLAW_ACP_TTL_MINUTES, manifest.acp.ttlMinutes);
  const acpStreamCoalesceIdleMs = resolveInteger(env.OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS, manifest.acp.stream.coalesceIdleMs);
  const acpStreamMaxChunkChars = resolveInteger(env.OPENCLAW_ACP_STREAM_MAX_CHARS, manifest.acp.stream.maxChunkChars);

  const acpxPermissionMode = nonEmptyString(env.OPENCLAW_ACPX_PERMISSION_MODE, "approve-all");
  const acpxNonInteractivePermissions = nonEmptyString(env.OPENCLAW_ACPX_NON_INTERACTIVE_PERMISSIONS, "fail");
  const execTimeoutSec = resolveInteger(env.OPENCLAW_EXEC_TIMEOUT_SEC, manifest.tools.exec.timeoutSec);

  const bootstrapFiles = uniqueStrings([
    ...manifest.instructionFiles,
    ...manifest.knowledgeFiles,
  ]);

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
                models: {
                  [agentDefaultModel]: {},
                },
              }
            : {}),
          verboseDefault: agentVerboseDefault,
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
          ...(manifest.telegram.allowFrom.length > 0 ? { allowFrom: manifest.telegram.allowFrom } : {}),
          groupPolicy: telegramGroupPolicy,
          ...(manifest.telegram.groupAllowFrom.length > 0 ? { groupAllowFrom: manifest.telegram.groupAllowFrom } : {}),
          streamMode: telegramStreamMode,
          blockStreaming: telegramBlockStreaming,
          replyToMode: telegramReplyToMode,
          reactionLevel: telegramReactionLevel,
          configWrites: resolveBoolean(env.OPENCLAW_TELEGRAM_CONFIG_WRITES, manifest.telegram.configWrites),
          groups: manifest.telegram.groups,
          network: {
            autoSelectFamily: telegramNetworkAutoSelectFamily,
          },
          ...(telegramProxy ? { proxy: telegramProxy } : {}),
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
        allow: ["acpx", pluginId],
        load: {
          paths: [pluginPath],
        },
        entries: {
          acpx: {
            enabled: true,
            config: {
              permissionMode: acpxPermissionMode,
              nonInteractivePermissions: acpxNonInteractivePermissions,
            },
          },
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
              toolingProfile: manifest.toolingProfile,
              instructionFiles: manifest.instructionFiles,
              knowledgeFiles: manifest.knowledgeFiles,
              verificationCommands: manifest.verificationCommands,
              agentDefaultModel,
              agentVerboseDefault,
              agentToolsDeny,
              acpAllowedAgents,
              preferredAcpAgent: acpDefaultAgent,
              preferredAcpMode: acpPreferredMode,
              telegramBlockStreaming,
              telegramDmPolicy,
              telegramGroupPolicy,
              telegramAllowFrom: manifest.telegram.allowFrom,
              telegramGroupAllowFrom: manifest.telegram.groupAllowFrom,
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
    manifestVersion: manifest.version,
    projectName: manifest.projectName,
    repoPath: manifest.repoPath,
    deploymentProfile: manifest.deploymentProfile,
    runtimeProfile: manifest.runtimeProfile,
    queueProfile: manifest.queueProfile,
    toolingProfile: manifest.toolingProfile,
    errors,
  };
}
