import { DEFAULT_OPENCLAW_IMAGE } from "./builtin-profiles.mjs";

export function defaultInstructionsTemplate(projectName) {
  return `# Repo Agent Instructions

- This workspace is managed by \`openclaw-repo-agent\`.
- Use the repo's configured ACP default agent when ACP-backed inspection, edits, or verification are needed.
- Use \`playwright-cli\` as the only browser automation tool in this workspace.
- Never use \`npx playwright\`; route browser automation through \`playwright-cli\` only.
- Save screenshots and other Playwright artifacts under \`.openclaw/playwright/artifacts/\`; do not create root-level folders such as \`tmp-playwright/\`.
- In Telegram or ACP runs, avoid parallel tool calls unless there is a clear need; prefer one short command at a time so command output does not stall.
- Keep replies concise in Telegram-style channels and use the configured verification commands after relevant code changes.
- Treat standalone cancellation messages such as \`stop\`, \`cancel\`, or \`dont fix\` as cancellation at the next tool boundary.
- \`.openclaw/\` is git-ignored by default; do not commit local-only OpenClaw state or secrets unless you intentionally unignore selected files.
- Project name: ${projectName}
`;
}

export function defaultSecretsEnvTemplate() {
  return `# OpenClaw secrets for this repository.
# .openclaw/ is git-ignored by default.
# TARGET_AUTH_PATH is a local host path to Codex auth (e.g. ~/.codex), not a keychain secret.

# Required for Telegram pairing and runtime startup.
TELEGRAM_BOT_TOKEN=replace-with-your-botfather-token
# Only needed when auth mode is codex.
OPENAI_API_KEY=
TARGET_AUTH_PATH=
`;
}

export function renderComposeTemplate(options = {}) {
  const authVolume = options.includeAuthMount ? "    - ${TARGET_AUTH_PATH}:/agent-auth:ro\n" : "";
  const buildSection = `x-openclaw-build: &openclaw-build
  context: \${OPENCLAW_PRODUCT_ROOT}
  dockerfile: runtime/Dockerfile
  args:
    OPENCLAW_IMAGE: \${OPENCLAW_IMAGE}
    OPENCLAW_AGENT_NPM_PACKAGES: \${OPENCLAW_AGENT_NPM_PACKAGES}
    OPENCLAW_AGENT_INSTALL_COMMAND: \${OPENCLAW_AGENT_INSTALL_COMMAND}
    OPENCLAW_TOOLING_PROFILE: \${OPENCLAW_EFFECTIVE_TOOLING_PROFILE}
    OPENCLAW_TOOLING_INSTALL_COMMAND: \${OPENCLAW_TOOLING_INSTALL_COMMAND}

`;

  const commonBuild = "  build: *openclaw-build\n";

  return `${buildSection}x-openclaw-common: &openclaw-common
${commonBuild}  image: \${OPENCLAW_STACK_IMAGE}
  init: true
  labels:
    openclaw.product: \${OPENCLAW_PRODUCT_NAME}
    openclaw.product-version: \${OPENCLAW_PRODUCT_VERSION}
    openclaw.instance-id: \${OPENCLAW_INSTANCE_ID}
    openclaw.repo-root: \${OPENCLAW_REPO_ROOT_HOST}
    openclaw.compose-project: \${OPENCLAW_COMPOSE_PROJECT_NAME}
    openclaw.telegram-token-hash: \${OPENCLAW_TELEGRAM_TOKEN_HASH}
  environment:
    HOME: /home/node
    TERM: xterm-256color
    GRADLE_USER_HOME: /home/node/.gradle-openclaw
    OPENCLAW_GATEWAY_PORT: \${OPENCLAW_GATEWAY_PORT}
    OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}
    OPENCLAW_GATEWAY_BIND: \${OPENCLAW_GATEWAY_BIND}
    OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS: \${OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS}
    TELEGRAM_BOT_TOKEN: \${TELEGRAM_BOT_TOKEN}
    OPENAI_API_KEY: \${OPENAI_API_KEY}
    OPENCLAW_WORKSPACE: /workspace
    OPENCLAW_REPO_ROOT: /workspace
    OPENCLAW_RENDER_STATUS_PATH: /home/node/.openclaw/runtime/render-status.json
    OPENCLAW_HOST_PLATFORM: \${OPENCLAW_HOST_PLATFORM}
    OPENCLAW_TOOLING_PROFILE: \${OPENCLAW_EFFECTIVE_TOOLING_PROFILE}
    OPENCLAW_BOOTSTRAP_AUTH_MODE: \${OPENCLAW_BOOTSTRAP_AUTH_MODE}
    OPENCLAW_AGENT_DEFAULT_MODEL: \${OPENCLAW_AGENT_DEFAULT_MODEL}
    OPENCLAW_AGENT_VERBOSE_DEFAULT: \${OPENCLAW_AGENT_VERBOSE_DEFAULT}
    OPENCLAW_AGENT_TOOLS_DENY: \${OPENCLAW_AGENT_TOOLS_DENY}
    OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT: \${OPENCLAW_AGENT_BLOCK_STREAMING_DEFAULT}
    OPENCLAW_AGENT_BLOCK_STREAMING_BREAK: \${OPENCLAW_AGENT_BLOCK_STREAMING_BREAK}
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
    OPENCLAW_TELEGRAM_PROXY: \${OPENCLAW_TELEGRAM_PROXY}
    OPENCLAW_TELEGRAM_CONFIG_WRITES: \${OPENCLAW_TELEGRAM_CONFIG_WRITES}
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
    OPENCLAW_REPO_PLUGIN_PATH: /opt/openclaw/plugins/workspace-openclaw
    OPENCLAW_AGENT_AUTH_CLI_BIN: /usr/local/bin/codex
    OPENCLAW_CODEX_CLI_BIN: /usr/local/bin/codex
    GIT_CONFIG_COUNT: "1"
    GIT_CONFIG_KEY_0: safe.directory
    GIT_CONFIG_VALUE_0: /workspace
  volumes:
    - openclaw-home:/home/node
${authVolume}    - \${TARGET_REPO_PATH}:/workspace:rw
  tmpfs:
    - /tmp
    - /var/tmp
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
          "openclaw",
          "health",
          "--timeout",
          "5000"
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
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
