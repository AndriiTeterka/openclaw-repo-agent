import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultInstructionsTemplate,
  defaultSecretsEnvTemplate,
  renderComposeTemplate,
  renderDockerMcpConfigTemplate
} from "../cli/src/templates.mjs";

test("renderDockerMcpConfigTemplate scopes filesystem access to the repo root", () => {
  const output = renderDockerMcpConfigTemplate("C:/Users/demo/workspace/repo");

  assert.match(output, /filesystem:/);
  assert.match(output, /paths:/);
  assert.match(output, /'C:\/Users\/demo\/workspace\/repo'/);
  assert.match(output, /github-official/);
  assert.match(output, /context7/);
  assert.match(output, /playwright-cli` only/i);
  assert.match(output, /Do not use `npx playwright`/);
  assert.match(output, /\.openclaw\/playwright\/artifacts\//);
  assert.doesNotMatch(output, /# - playwright/);
});

test("defaultSecretsEnvTemplate documents MCP credential sync", () => {
  const output = defaultSecretsEnvTemplate();

  assert.match(output, /\.openclaw\/ is git-ignored by default/);
  assert.match(output, /mirror configured API-style credentials into Docker MCP secrets automatically/);
  assert.match(output, /GITHUB_PERSONAL_ACCESS_TOKEN=/);
  assert.match(output, /TELEGRAM_BOT_TOKEN=/);
  assert.match(output, /OPENAI_API_KEY=/);
  assert.match(output, /TARGET_AUTH_PATH=/);
  assert.doesNotMatch(output, /OPENCLAW_USE_LOCAL_BUILD=/);
});

test("renderComposeTemplate always includes the managed runtime build", () => {
  const output = renderComposeTemplate({});

  assert.doesNotMatch(output, /container_name:/);
  assert.match(output, /x-openclaw-build: &openclaw-build/);
  assert.match(output, /build: \*openclaw-build/);
  assert.match(output, /openclaw\.instance-id: \$\{OPENCLAW_INSTANCE_ID\}/);
  assert.match(output, /openclaw\.compose-project: \$\{OPENCLAW_COMPOSE_PROJECT_NAME\}/);
  assert.match(output, /127\.0\.0\.1:\$\{OPENCLAW_GATEWAY_PORT\}:\$\{OPENCLAW_GATEWAY_PORT\}/);
  assert.match(output, /Keep the host publish loopback-only by default/);
  assert.match(output, /"openclaw",\s*"health",\s*"--timeout",\s*"5000"/);
  assert.doesNotMatch(output, /\$\{TARGET_AUTH_PATH\}:\/agent-auth:ro/);
});

test("default templates mention repo guidance", () => {
  const instructions = defaultInstructionsTemplate("Demo");

  assert.match(instructions, /This workspace is managed by `openclaw-repo-agent`/);
  assert.match(instructions, /playwright-cli` as the only browser automation tool/i);
  assert.match(instructions, /Never use `npx playwright`/);
  assert.match(instructions, /\.openclaw\/playwright\/artifacts\//);
  assert.match(instructions, /avoid parallel tool calls/i);
  assert.match(instructions, /Keep replies concise in Telegram-style channels/);
});

test("renderComposeTemplate includes auth mount when requested", () => {
  const output = renderComposeTemplate({ includeAuthMount: true });

  assert.match(output, /\$\{TARGET_AUTH_PATH\}:\/agent-auth:ro/);
});
