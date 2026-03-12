export const PRODUCT_NAME = "openclaw-repo-agent";
export const PRODUCT_VERSION = "0.1.2";
export const DEFAULT_RUNTIME_IMAGE_REPOSITORY = "ghcr.io/andriiteterka/openclaw-repo-agent-runtime";
export const DEFAULT_OPENCLAW_IMAGE = "ghcr.io/openclaw/openclaw:latest";
export const DEFAULT_NPM_PACKAGE_NAME = PRODUCT_NAME;

const STABLE_TELEGRAM_DEFAULTS = {
  dmPolicy: "pairing",
  groupPolicy: "disabled",
  streamMode: "partial",
  blockStreaming: false,
  replyToMode: "first",
  reactionLevel: "minimal",
  configWrites: false,
  groups: {
    "*": {
      requireMention: true
    }
  },
  threadBindings: {
    spawnAcpSessions: false
  }
};

const STABLE_ACP_DEFAULTS = {
  defaultAgent: "",
  allowedAgents: [],
  preferredMode: "oneshot",
  maxConcurrentSessions: 4,
  ttlMinutes: 120,
  stream: {
    coalesceIdleMs: 300,
    maxChunkChars: 1200
  }
};

const STABLE_AGENT_DEFAULTS = {
  id: "workspace",
  name: "Workspace",
  maxConcurrent: 4,
  skipBootstrap: true,
  defaultModel: "",
  verboseDefault: "off",
  blockStreamingDefault: "off",
  blockStreamingBreak: "text_end",
  typingMode: "never",
  typingIntervalSeconds: 12,
  tools: {
    deny: ["process"]
  }
};

const STABLE_SECURITY_DEFAULTS = {
  authBootstrapMode: "external",
  commandLoggerEnabled: true,
  toolDeny: ["process"]
};

function baseProfile(overrides = {}) {
  return {
    version: 1,
    profile: "custom",
    projectName: "workspace",
    deploymentProfile: "",
    toolingProfile: "none",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    instructionFiles: [".openclaw/instructions.md"],
    knowledgeFiles: [".openclaw/knowledge.md"],
    verificationCommands: [],
    agent: { ...STABLE_AGENT_DEFAULTS },
    telegram: { ...STABLE_TELEGRAM_DEFAULTS },
    acp: { ...STABLE_ACP_DEFAULTS },
    security: { ...STABLE_SECURITY_DEFAULTS },
    ...overrides
  };
}

export const BUILTIN_PROFILES = {
  custom: baseProfile()
};

export function listBuiltinProfileNames() {
  return Object.keys(BUILTIN_PROFILES);
}
