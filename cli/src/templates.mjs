import { TEMPLATE_WORKSPACE_GUIDANCE_LINES } from "../../runtime/workspace-guidance.mjs";

import { PROVIDER_HOME_LAYOUT } from "./state-layout.mjs";

export function defaultInstructionsTemplate(projectName) {
  const guidanceLines = TEMPLATE_WORKSPACE_GUIDANCE_LINES.map((line) => `- ${line}`);
  return `# Repo Agent Instructions

- This workspace is managed by \`openclaw-repo-agent\`.
- Use the repo's configured ACP default agent when ACP-backed inspection, edits, or verification are needed.
${guidanceLines.join("\n")}
- \`.openclaw/\` is git-ignored by default; do not commit local-only OpenClaw state or secrets unless you intentionally unignore selected files.
- Project name: ${projectName}
`;
}

export function defaultSecretsEnvTemplate() {
  return `# OpenClaw secrets for this repository.
# .openclaw/ is git-ignored by default.
# Provider subscription homes are mounted from the host at runtime for auth, settings, and MCP config.

# Required for Telegram pairing and runtime startup.
TELEGRAM_BOT_TOKEN=replace-with-your-botfather-token
`;
}

function hasProviderHomeMount(providerHomeMounts = {}, agentId) {
  const mount = providerHomeMounts?.[agentId];
  if (!mount) return false;
  if (typeof mount === "object") return Boolean(mount.available);
  return Boolean(mount);
}

function hasMount(mounts = {}, mountId) {
  const mount = mounts?.[mountId];
  if (!mount) return false;
  if (typeof mount === "object") return Boolean(mount.available);
  return Boolean(mount);
}

export function renderComposeTemplate(options = {}) {
  const providerHomeVolumes = Object.entries(PROVIDER_HOME_LAYOUT)
    .filter(([agentId]) => hasProviderHomeMount(options.providerHomeMounts, agentId))
    .map(([, definition]) => `    - \${${definition.mountPathEnvKey}}:\${${definition.envKey}}:ro`);
  const supportHomeVolumes = [
    ["agents", "OPENCLAW_AGENTS_HOME_MOUNT_PATH", "/home/node/.agents"],
    ["claude", "OPENCLAW_CLAUDE_HOME_MOUNT_PATH", "/home/node/.claude"]
  ]
    .filter(([homeId]) => hasMount(options.copilotSupportHomeMounts, homeId))
    .map(([, mountPathEnvKey, runtimePath]) => `    - \${${mountPathEnvKey}}:${runtimePath}:ro`);
  const volumeLines = [
    "    - openclaw-home:/home/node",
    "    - ${OPENCLAW_COPILOT_SESSION_STATE_MOUNT_PATH}:/home/node/.copilot/session-state:rw",
    ...providerHomeVolumes,
    ...supportHomeVolumes,
    "    - ${TARGET_REPO_PATH}:/workspace:rw"
  ].join("\n");
  const hostEnvPassthroughLines = (Array.isArray(options.hostEnvPassthroughNames) ? options.hostEnvPassthroughNames : [])
    .map((envName) => String(envName ?? "").trim())
    .filter(Boolean)
    .map((envName) => `    ${envName}: \${${envName}:-}`)
    .join("\n");
  return `x-openclaw-common: &openclaw-common
  image: \${OPENCLAW_STACK_IMAGE}
  init: true
  read_only: true
  labels:
    openclaw.product: \${OPENCLAW_PRODUCT_NAME}
    openclaw.product-version: \${OPENCLAW_PRODUCT_VERSION}
    openclaw.instance-id: \${OPENCLAW_INSTANCE_ID}
    openclaw.repo-root: \${OPENCLAW_REPO_ROOT_HOST}
    openclaw.compose-project: \${OPENCLAW_COMPOSE_PROJECT_NAME}
    openclaw.telegram-token-hash: \${OPENCLAW_TELEGRAM_TOKEN_HASH}
  environment:
    HOME: /home/node
    CODEX_HOME: \${CODEX_HOME}
    GEMINI_CLI_HOME: \${GEMINI_CLI_HOME}
    COPILOT_HOME: \${COPILOT_HOME}
    TERM: xterm-256color
    GRADLE_USER_HOME: /home/node/.gradle-openclaw
    NODE_OPTIONS: \${OPENCLAW_NODE_OPTIONS}
    OPENCLAW_GATEWAY_PORT: \${OPENCLAW_GATEWAY_PORT}
    OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
    OPENCLAW_GATEWAY_BIND: \${OPENCLAW_GATEWAY_BIND}
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: \${OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS}
    OPENCLAW_RUNTIME_CORE_DIGEST: \${OPENCLAW_RUNTIME_CORE_DIGEST}
    OPENCLAW_CORE_PROVENANCE: \${OPENCLAW_CORE_PROVENANCE}
    TELEGRAM_BOT_TOKEN: \${TELEGRAM_BOT_TOKEN}
    COPILOT_GITHUB_TOKEN: \${COPILOT_GITHUB_TOKEN:-}
    OPENCLAW_WORKSPACE: /workspace
    OPENCLAW_REPO_ROOT: /workspace
    OPENCLAW_REPO_ROOT_HOST: \${OPENCLAW_REPO_ROOT_HOST}
    OPENCLAW_RENDER_STATUS_PATH: \${OPENCLAW_RENDER_STATUS_PATH}
    OPENCLAW_PLAYWRIGHT_CONFIG_PATH: \${OPENCLAW_PLAYWRIGHT_CONFIG_PATH}
    OPENCLAW_PLAYWRIGHT_ARTIFACTS_DIR: \${OPENCLAW_PLAYWRIGHT_ARTIFACTS_DIR}
    OPENCLAW_HOST_PLATFORM: \${OPENCLAW_HOST_PLATFORM}
    OPENCLAW_PROJECT_NAME: \${OPENCLAW_PROJECT_NAME}
    OPENCLAW_TOOLING_PROFILES: \${OPENCLAW_TOOLING_PROFILES}
    OPENCLAW_STACK: \${OPENCLAW_STACK}
    OPENCLAW_RUNTIME_PROFILE: \${OPENCLAW_RUNTIME_PROFILE}
    OPENCLAW_QUEUE_PROFILE: \${OPENCLAW_QUEUE_PROFILE}
    OPENCLAW_DEPLOYMENT_PROFILE: \${OPENCLAW_DEPLOYMENT_PROFILE}
    OPENCLAW_BOOTSTRAP_AUTH_MODE: \${OPENCLAW_BOOTSTRAP_AUTH_MODE}
    OPENCLAW_CODEX_AUTH_SOURCE: \${OPENCLAW_CODEX_AUTH_SOURCE}
    OPENCLAW_GEMINI_AUTH_SOURCE: \${OPENCLAW_GEMINI_AUTH_SOURCE}
    OPENCLAW_COPILOT_AUTH_SOURCE: \${OPENCLAW_COPILOT_AUTH_SOURCE}
    OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: \${OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS}
    OPENCLAW_HOST_ENV_PASSTHROUGH_JSON: \${OPENCLAW_HOST_ENV_PASSTHROUGH_JSON}
${hostEnvPassthroughLines ? `${hostEnvPassthroughLines}\n` : ""}    OPENCLAW_AGENT_NAME: \${OPENCLAW_AGENT_NAME}
    OPENCLAW_AGENT_DEFAULT_MODEL: \${OPENCLAW_AGENT_DEFAULT_MODEL}
    OPENCLAW_AGENT_VERBOSE_DEFAULT: \${OPENCLAW_AGENT_VERBOSE_DEFAULT}
    OPENCLAW_AGENT_THINKING_DEFAULT: \${OPENCLAW_AGENT_THINKING_DEFAULT}
    OPENCLAW_AGENT_TOOLS_DENY: \${OPENCLAW_AGENT_TOOLS_DENY}
    OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT: \${OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT}
    OPENCLAW_AGENT_BLOCK_STREAMING_BREAK: \${OPENCLAW_AGENT_BLOCK_STREAMING_BREAK}
    OPENCLAW_AGENT_TYPING_MODE: \${OPENCLAW_AGENT_TYPING_MODE}
    OPENCLAW_AGENT_TYPING_INTERVAL_SECONDS: \${OPENCLAW_AGENT_TYPING_INTERVAL_SECONDS}
    OPENCLAW_QUEUE_MODE: \${OPENCLAW_QUEUE_MODE}
    OPENCLAW_QUEUE_DEBOUNCE_MS: \${OPENCLAW_QUEUE_DEBOUNCE_MS}
    OPENCLAW_QUEUE_CAP: \${OPENCLAW_QUEUE_CAP}
    OPENCLAW_INBOUND_DEBOUNCE_MS: \${OPENCLAW_INBOUND_DEBOUNCE_MS}
    OPENCLAW_AGENTS_MAX_CONCURRENT: \${OPENCLAW_AGENTS_MAX_CONCURRENT}
    OPENCLAW_EXEC_TIMEOUT_SEC: \${OPENCLAW_EXEC_TIMEOUT_SEC}
    OPENCLAW_TELEGRAM_ENABLED: \${OPENCLAW_TELEGRAM_ENABLED}
    OPENCLAW_TELEGRAM_DM_POLICY: \${OPENCLAW_TELEGRAM_DM_POLICY}
    OPENCLAW_TELEGRAM_GROUP_POLICY: \${OPENCLAW_TELEGRAM_GROUP_POLICY}
    OPENCLAW_TELEGRAM_STREAM_MODE: \${OPENCLAW_TELEGRAM_STREAM_MODE}
    OPENCLAW_TELEGRAM_BLOCK_STREAMING: \${OPENCLAW_TELEGRAM_BLOCK_STREAMING}
    OPENCLAW_TELEGRAM_REPLY_TO_MODE: \${OPENCLAW_TELEGRAM_REPLY_TO_MODE}
    OPENCLAW_TELEGRAM_REACTION_LEVEL: \${OPENCLAW_TELEGRAM_REACTION_LEVEL}
    OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY: \${OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY}
    OPENCLAW_TELEGRAM_CONFIG_WRITES: \${OPENCLAW_TELEGRAM_CONFIG_WRITES}
    OPENCLAW_TELEGRAM_THREAD_BINDINGS_SPAWN_ACP: \${OPENCLAW_TELEGRAM_THREAD_BINDINGS_SPAWN_ACP}
    OPENCLAW_ACP_DEFAULT_AGENT: \${OPENCLAW_ACP_DEFAULT_AGENT}
    OPENCLAW_ACP_ALLOWED_AGENTS: \${OPENCLAW_ACP_ALLOWED_AGENTS}
    OPENCLAW_ACP_PREFERRED_MODE: \${OPENCLAW_ACP_PREFERRED_MODE}
    OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS: \${OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS}
    OPENCLAW_ACP_TTL_MINUTES: \${OPENCLAW_ACP_TTL_MINUTES}
    OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS: \${OPENCLAW_ACP_STREAM_COALESCE_IDLE_MS}
    OPENCLAW_ACP_STREAM_MAX_CHARS: \${OPENCLAW_ACP_STREAM_MAX_CHARS}
    OPENCLAW_ACPX_PERMISSION_MODE: \${OPENCLAW_ACPX_PERMISSION_MODE}
    OPENCLAW_ACPX_NON_INTERACTIVE_PERMISSIONS: \${OPENCLAW_ACPX_NON_INTERACTIVE_PERMISSIONS}
    OPENCLAW_COMMAND_LOGGER_ENABLED: \${OPENCLAW_COMMAND_LOGGER_ENABLED}
    OPENCLAW_WORKSPACE_PLUGIN_PATH: /opt/openclaw/plugins/workspace-openclaw
    OPENCLAW_AGENT_AUTH_CLI_BIN: \${OPENCLAW_AGENT_AUTH_CLI_BIN}
    GIT_CONFIG_COUNT: "1"
    GIT_CONFIG_KEY_0: safe.directory
    GIT_CONFIG_VALUE_0: /workspace
  volumes:
${volumeLines}
  tmpfs:
    - /tmp
    - /var/tmp
  pids_limit: 256
  mem_limit: \${OPENCLAW_CONTAINER_MEMORY_LIMIT}
  cpus: 2.0
  cap_drop:
    - ALL
  security_opt:
    - no-new-privileges:true

services:
  openclaw-gateway:
    <<: *openclaw-common
    restart: unless-stopped
    # Keep the host publish loopback-only by default. OPENCLAW_GATEWAY_BIND remains "lan"
    # inside the container so Docker bridge traffic can still reach the gateway process.
    ports:
      - "127.0.0.1:\${OPENCLAW_GATEWAY_PORT}:\${OPENCLAW_GATEWAY_PORT}"
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "const net = require('node:net'); const port = Number(process.env.OPENCLAW_GATEWAY_PORT || 0); if (!Number.isInteger(port) || port <= 0) process.exit(1); const socket = net.connect({ host: '127.0.0.1', port }); const fail = () => { socket.destroy(); process.exit(1); }; socket.setTimeout(5000, fail); socket.on('connect', () => { socket.end(); process.exit(0); }); socket.on('error', fail);"
        ]
      interval: 15s
      timeout: 10s
      retries: 20
      start_period: 60s
    command:
      [
        "openclaw",
        "gateway",
        "--bind",
        "\${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "\${OPENCLAW_GATEWAY_PORT}"
      ]

  openclaw-cli:
    <<: *openclaw-common
    profiles: ["cli"]
    network_mode: "service:openclaw-gateway"
    depends_on:
      - openclaw-gateway
    stdin_open: true
    tty: true
    command: ["openclaw"]

volumes:
  openclaw-home:
`;
}
