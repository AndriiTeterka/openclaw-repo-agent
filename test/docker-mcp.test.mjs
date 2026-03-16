import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDockerMcpSecretPlan,
  buildRepoDockerMcpSecretPrefix,
  DEFAULT_DOCKER_MCP_SERVERS,
  summarizeDockerMcpSecretPlan
} from "../cli/src/docker-mcp.mjs";

test("DEFAULT_DOCKER_MCP_SERVERS includes context7", () => {
  assert.deepEqual(DEFAULT_DOCKER_MCP_SERVERS, ["docker", "fetch", "filesystem", "github-official", "context7"]);
});

test("buildRepoDockerMcpSecretPrefix is stable for a repo path", () => {
  const prefix = buildRepoDockerMcpSecretPrefix("C:/Users/demo/workspace/repo");

  assert.match(prefix, /^openclaw-repo-agent\.repo\.[a-f0-9]{12}$/);
});

test("buildDockerMcpSecretPlan ignores placeholders and tracks present secrets", () => {
  const repoRoot = "C:/Users/demo/workspace/repo";
  const prefix = buildRepoDockerMcpSecretPrefix(repoRoot);
  const plan = buildDockerMcpSecretPlan(repoRoot, {
    TELEGRAM_BOT_TOKEN: "replace-with-your-botfather-token",
    OPENAI_API_KEY: "sk-demo",
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_demo"
  }, [
    { name: `${prefix}.openai_api_key` },
    { name: "github.personal_access_token" }
  ]);
  const summary = summarizeDockerMcpSecretPlan(plan);

  assert.equal(plan.find((entry) => entry.envKey === "TELEGRAM_BOT_TOKEN").configured, false);
  assert.equal(plan.find((entry) => entry.envKey === "OPENAI_API_KEY").present, true);
  assert.equal(plan.find((entry) => entry.envKey === "GITHUB_PERSONAL_ACCESS_TOKEN").present, true);
  assert.equal(summary.configuredCount, 2);
  assert.equal(summary.syncedConfiguredCount, 2);
  assert.deepEqual(summary.missingConfiguredSecrets, []);
});
