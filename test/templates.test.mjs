import assert from "node:assert/strict";
import test from "node:test";

import { defaultLocalEnvExample, renderComposeTemplate, renderDockerMcpConfigTemplate } from "../cli/src/templates.mjs";

test("renderDockerMcpConfigTemplate scopes filesystem access to the repo root", () => {
  const output = renderDockerMcpConfigTemplate("C:/Users/demo/workspace/repo");

  assert.match(output, /filesystem:/);
  assert.match(output, /paths:/);
  assert.match(output, /'C:\/Users\/demo\/workspace\/repo'/);
  assert.match(output, /github-official/);
  assert.match(output, /playwright/);
  assert.match(output, /context7/);
});

test("defaultLocalEnvExample documents MCP credential sync", () => {
  const output = defaultLocalEnvExample(false);

  assert.match(output, /\.openclaw\/ is git-ignored by default/);
  assert.match(output, /mirror configured API-style credentials into Docker MCP secrets automatically/);
  assert.match(output, /GITHUB_PERSONAL_ACCESS_TOKEN=/);
  assert.match(output, /OPENCLAW_INSTANCE_ID=/);
  assert.match(output, /OPENCLAW_PORT_MANAGED=true/);
});

test("renderComposeTemplate uses labels instead of a custom container name", () => {
  const output = renderComposeTemplate({ useLocalBuild: false });

  assert.doesNotMatch(output, /container_name:/);
  assert.match(output, /openclaw\.instance-id: \$\{OPENCLAW_INSTANCE_ID\}/);
  assert.match(output, /openclaw\.compose-project: \$\{OPENCLAW_COMPOSE_PROJECT_NAME\}/);
});
