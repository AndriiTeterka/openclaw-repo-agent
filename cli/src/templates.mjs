import { DEFAULT_OPENCLAW_IMAGE, DEFAULT_RUNTIME_IMAGE_REPOSITORY, PRODUCT_VERSION } from "./builtin-profiles.mjs";

export function defaultInstructionsTemplate(projectName) {
  return `# Repo Agent Instructions

- This workspace is managed by \`openclaw-repo-agent\`.
- Use the repo's configured ACP default agent when ACP-backed inspection, edits, or verification are needed.
- Keep replies concise in Telegram-style channels and use the configured verification commands after relevant code changes.
- Treat standalone cancellation messages such as \`stop\`, \`cancel\`, or \`dont fix\` as cancellation at the next tool boundary.
- Do not commit local-only OpenClaw state or secrets from \`.openclaw/local.env\`.
- Project name: ${projectName}
`;
}

export function defaultKnowledgeTemplate(projectName) {
  return `# Repo Agent Knowledge

- Project: ${projectName}
- This file is injected into OpenClaw runs as project knowledge.
- Record stable repo facts here: build/test commands, important architecture notes, and operator constraints.
- Keep secrets and machine-specific values out of this file.
`;
}

export function defaultLocalEnvExample(useLocalBuild = false) {
  const stackImage = useLocalBuild
    ? "openclaw-repo-agent-runtime:local"
    : `${DEFAULT_RUNTIME_IMAGE_REPOSITORY}:${PRODUCT_VERSION}-polyglot`;

  return `# Local-only OpenClaw overrides for this repository.
# Copy this file to .openclaw/local.env and fill in the required secrets.

OPENCLAW_STACK_IMAGE=${stackImage}
OPENCLAW_IMAGE=${DEFAULT_OPENCLAW_IMAGE}
OPENCLAW_AGENT_NPM_PACKAGES=
OPENCLAW_AGENT_INSTALL_COMMAND=
OPENCLAW_TOOLING_PROFILE=
OPENCLAW_TOOLING_INSTALL_COMMAND=
OPENCLAW_DEPLOYMENT_PROFILE=
OPENCLAW_RUNTIME_PROFILE=
OPENCLAW_QUEUE_PROFILE=
OPENCLAW_BOOTSTRAP_AUTH_MODE=
OPENCLAW_AGENT_DEFAULT_MODEL=
OPENCLAW_ACP_DEFAULT_AGENT=
OPENCLAW_ACP_ALLOWED_AGENTS=
OPENCLAW_TELEGRAM_DM_POLICY=
OPENCLAW_TELEGRAM_GROUP_POLICY=
OPENCLAW_TELEGRAM_STREAM_MODE=
OPENCLAW_TELEGRAM_BLOCK_STREAMING=
OPENCLAW_TELEGRAM_REPLY_TO_MODE=
OPENCLAW_TELEGRAM_REACTION_LEVEL=
OPENCLAW_TELEGRAM_ALLOW_FROM=[]
OPENCLAW_TELEGRAM_GROUP_ALLOW_FROM=[]
OPENCLAW_TELEGRAM_PROXY=
OPENCLAW_TELEGRAM_AUTO_SELECT_FAMILY=true
OPENCLAW_TOPIC_ACP=
OPENCLAW_USE_LOCAL_BUILD=${useLocalBuild ? "true" : "false"}
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=replace-with-a-long-random-token
OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS=
TELEGRAM_BOT_TOKEN=replace-with-your-botfather-token
# Only needed when auth mode is codex.
OPENAI_API_KEY=
TARGET_AUTH_PATH=
`;
}

export function renderComposeTemplate({ useLocalBuild }) {
  const buildSection = useLocalBuild
    ? `x-openclaw-build: &openclaw-build
  context: \${OPENCLAW_PRODUCT_ROOT}
  dockerfile: runtime/Dockerfile
  args:
    OPENCLAW_IMAGE: \${OPENCLAW_IMAGE}
    OPENCLAW_AGENT_NPM_PACKAGES: \${OPENCLAW_AGENT_NPM_PACKAGES}
    OPENCLAW_AGENT_INSTALL_COMMAND: \${OPENCLAW_AGENT_INSTALL_COMMAND}
    OPENCLAW_TOOLING_PROFILE: \${OPENCLAW_EFFECTIVE_TOOLING_PROFILE}
    OPENCLAW_TOOLING_INSTALL_COMMAND: \${OPENCLAW_TOOLING_INSTALL_COMMAND}

`
    : "";

  const commonBuild = useLocalBuild ? "  build: *openclaw-build\n" : "";

  return `${buildSection}x-openclaw-common: &openclaw-common
${commonBuild}  image: \${OPENCLAW_STACK_IMAGE}
  init: true
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
    OPENCLAW_AUTH_MOUNT: /agent-auth
    OPENCLAW_WORKSPACE: /workspace
    OPENCLAW_REPO_ROOT: /workspace
    OPENCLAW_PROJECT_MANIFEST: /config/project-manifest.json
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
    OPENCLAW_TELEGRAM_STREAMING: \${OPENCLAW_TELEGRAM_STREAMING}
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
    - \${TARGET_AUTH_PATH}:/agent-auth:ro
    - \${TARGET_REPO_PATH}:/workspace:rw
    - \${GENERATED_MANIFEST_PATH}:/config/project-manifest.json:ro
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
    ports:
      - "127.0.0.1:\${OPENCLAW_GATEWAY_PORT}:18789"
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
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
