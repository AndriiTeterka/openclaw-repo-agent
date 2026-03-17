import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultInstructionsTemplate,
  defaultKnowledgeTemplate,
  defaultLocalEnvExample,
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
  assert.match(output, /Playwright CLI directly/);
  assert.match(output, /Do not use `npx playwright`/);
  assert.doesNotMatch(output, /# - playwright/);
});

test("defaultLocalEnvExample documents MCP credential sync", () => {
  const output = defaultLocalEnvExample(false);

  assert.match(output, /\.openclaw\/ is git-ignored by default/);
  assert.match(output, /mirror configured API-style credentials into Docker MCP secrets automatically/);
  assert.match(output, /OPENCLAW_GATEWAY_BIND stays "lan" in Docker bridge mode/);
  assert.match(output, /GITHUB_PERSONAL_ACCESS_TOKEN=/);
  assert.match(output, /OPENCLAW_INSTANCE_ID=/);
  assert.match(output, /OPENCLAW_PORT_MANAGED=true/);
});

test("renderComposeTemplate uses labels instead of a custom container name", () => {
  const output = renderComposeTemplate({ useLocalBuild: false });

  assert.doesNotMatch(output, /container_name:/);
  assert.match(output, /openclaw\.instance-id: \$\{OPENCLAW_INSTANCE_ID\}/);
  assert.match(output, /openclaw\.compose-project: \$\{OPENCLAW_COMPOSE_PROJECT_NAME\}/);
  assert.match(output, /127\.0\.0\.1:\$\{OPENCLAW_GATEWAY_PORT\}:\$\{OPENCLAW_GATEWAY_PORT\}/);
  assert.match(output, /Keep the host publish loopback-only by default/);
  assert.match(output, /"openclaw",\s*"health",\s*"--timeout",\s*"5000"/);
});

test("default templates mention repo guidance", () => {
  const instructions = defaultInstructionsTemplate("Demo");
  const knowledge = defaultKnowledgeTemplate("Demo");

  assert.match(instructions, /This workspace is managed by `openclaw-repo-agent`/);
  assert.match(instructions, /Use Playwright CLI directly for browser automation/);
  assert.match(instructions, /Never use `npx playwright`/);
  assert.match(instructions, /Keep replies concise in Telegram-style channels/);
  assert.match(knowledge, /Record stable repo facts here/);
});
