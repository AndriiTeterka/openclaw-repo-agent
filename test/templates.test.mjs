import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultInstructionsTemplate,
  defaultSecretsEnvTemplate,
  renderComposeTemplate
} from "../cli/src/templates.mjs";

test("defaultSecretsEnvTemplate keeps only repo bootstrap secrets", () => {
  const output = defaultSecretsEnvTemplate();
  const keys = output
    .split(/\r?\n/g)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split("=", 1)[0]);

  assert.match(output, /\.openclaw\/ is git-ignored by default/);
  assert.match(output, /mounted from the host at runtime/);
  assert.match(output, /TELEGRAM_BOT_TOKEN=/);
  assert.deepEqual(keys, [
    "TELEGRAM_BOT_TOKEN"
  ]);
  assert.doesNotMatch(output, /OPENAI_API_KEY=|GEMINI_API_KEY=|COPILOT_GITHUB_TOKEN=|GITHUB_TOKEN=/);
  assert.doesNotMatch(output, /OPENCLAW_USE_LOCAL_BUILD=/);
});

test("renderComposeTemplate always includes the managed runtime image and repo-local runtime surface", () => {
  const output = renderComposeTemplate({});

  assert.doesNotMatch(output, /container_name:/);
  assert.match(output, /image: \$\{OPENCLAW_STACK_IMAGE\}/);
  assert.match(output, /read_only: true/);
  assert.match(output, /OPENCLAW_RUNTIME_CORE_DIGEST: \$\{OPENCLAW_RUNTIME_CORE_DIGEST\}/);
  assert.match(output, /NODE_OPTIONS: \$\{OPENCLAW_NODE_OPTIONS\}/);
  assert.match(output, /CODEX_HOME: \$\{CODEX_HOME\}/);
  assert.match(output, /GEMINI_CLI_HOME: \$\{GEMINI_CLI_HOME\}/);
  assert.match(output, /COPILOT_HOME: \$\{COPILOT_HOME\}/);
  assert.match(output, /COPILOT_GITHUB_TOKEN: \$\{COPILOT_GITHUB_TOKEN:-\}/);
  assert.match(output, /OPENCLAW_HOST_ENV_PASSTHROUGH_JSON: \$\{OPENCLAW_HOST_ENV_PASSTHROUGH_JSON\}/);
  assert.match(output, /OPENCLAW_CODEX_AUTH_SOURCE: \$\{OPENCLAW_CODEX_AUTH_SOURCE\}/);
  assert.match(output, /OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: \$\{OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS\}/);
  assert.match(output, /\$\{TARGET_REPO_PATH\}:\/workspace:rw/);
  assert.match(output, /\$\{OPENCLAW_COPILOT_SESSION_STATE_MOUNT_PATH\}:\/home\/node\/\.copilot\/session-state:rw/);
  assert.match(output, /OPENCLAW_RENDER_STATUS_PATH: \$\{OPENCLAW_RENDER_STATUS_PATH\}/);
  assert.match(output, /openclaw\.instance-id: \$\{OPENCLAW_INSTANCE_ID\}/);
  assert.match(output, /openclaw\.compose-project: \$\{OPENCLAW_COMPOSE_PROJECT_NAME\}/);
  assert.match(output, /127\.0\.0\.1:\$\{OPENCLAW_GATEWAY_PORT\}:\$\{OPENCLAW_GATEWAY_PORT\}/);
  assert.match(output, /OPENCLAW_AGENT_NAME: \$\{OPENCLAW_AGENT_NAME\}/);
  assert.match(output, /Keep the host publish loopback-only by default/);
  assert.match(output, /"node",\s*"-e",\s*"const net = require\('node:net'\);/);
  assert.match(output, /interval: 15s/);
  assert.match(output, /timeout: 10s/);
  assert.match(output, /retries: 20/);
  assert.match(output, /start_period: 60s/);
  assert.match(output, /mem_limit: \$\{OPENCLAW_CONTAINER_MEMORY_LIMIT\}/);
  assert.match(output, /volumes:\s*\n  openclaw-home:/);
  assert.doesNotMatch(output, /OPENCLAW_IMAGE:/);
  assert.doesNotMatch(output, /OPENCLAW_AGENT_NPM_PACKAGES:/);
  assert.doesNotMatch(output, /OPENCLAW_TELEGRAM_PROXY/);
  assert.doesNotMatch(output, /OPENCLAW_CODEX_AUTH_PATH|OPENCLAW_GEMINI_AUTH_PATH|OPENCLAW_COPILOT_AUTH_PATH/);
  assert.doesNotMatch(output, /OPENCLAW_AUTH_MIRRORS/);
  assert.doesNotMatch(output, /OPENAI_API_KEY|GEMINI_API_KEY/);
  assert.doesNotMatch(output, /(^|[^A-Z_])GITHUB_TOKEN([^A-Z_]|$)/);
  assert.doesNotMatch(output, /\$\{TARGET_AUTH_PATH\}:\/agent-auth:ro/);
});

test("default templates mention repo guidance", () => {
  const instructions = defaultInstructionsTemplate("Demo");

  assert.match(instructions, /This workspace is managed by `openclaw-repo-agent`/);
  assert.match(instructions, /playwright-cli` only/i);
  assert.match(instructions, /Do not use `npx playwright`/);
  assert.match(instructions, /\.openclaw\/playwright\/artifacts\//);
  assert.match(instructions, /avoid parallel tool calls/i);
  assert.match(instructions, /Keep replies concise in Telegram-style channels/);
});

test("renderComposeTemplate includes direct provider-home mounts when requested", () => {
  const output = renderComposeTemplate({
    providerHomeMounts: {
      codex: true,
      gemini: true,
      copilot: true
    },
    copilotSupportHomeMounts: {
      agents: true,
      claude: false
    },
    hostEnvPassthroughNames: ["ADO_MCP_AUTH_TOKEN"]
  });

  assert.match(output, /\$\{OPENCLAW_CODEX_HOME_MOUNT_PATH\}:\$\{CODEX_HOME\}:ro/);
  assert.match(output, /\$\{OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH\}:\$\{GEMINI_CLI_HOME\}:ro/);
  assert.match(output, /\$\{OPENCLAW_COPILOT_HOME_MOUNT_PATH\}:\$\{COPILOT_HOME\}:ro/);
  assert.match(output, /\$\{OPENCLAW_AGENTS_HOME_MOUNT_PATH\}:\/home\/node\/\.agents:ro/);
  assert.match(output, /ADO_MCP_AUTH_TOKEN: \$\{ADO_MCP_AUTH_TOKEN:-\}/);
  assert.match(output, /OPENCLAW_AGENT_AUTH_CLI_BIN: \$\{OPENCLAW_AGENT_AUTH_CLI_BIN\}/);
  assert.doesNotMatch(output, /\$\{OPENCLAW_CLAUDE_HOME_MOUNT_PATH\}:\/home\/node\/\.claude:ro/);
  assert.doesNotMatch(output, /OPENCLAW_AUTH_MIRRORS/);
});
