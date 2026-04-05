import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusReply,
  buildSystemContext,
} from "../runtime/extensions/workspace-openclaw/index.js";

function createPluginConfig(overrides = {}) {
  return {
    projectName: "workspace",
    workspace: "/workspace",
    repoRoot: "/workspace",
    repoPath: "C:/workspace",
    deploymentProfile: "docker-local",
    runtimeProfile: "stable-chat",
    queueProfile: "stable-chat",
    toolingProfiles: ["node22"],
    stack: {
      languages: ["typescript"],
      tools: ["pnpm"]
    },
    acpAllowedAgents: ["codex", "copilot"],
    preferredAcpAgent: "codex",
    preferredAcpMode: "oneshot",
    agentDefaultModel: "openai-codex/gpt-5.4",
    agentVerboseDefault: "on",
    agentThinkingDefault: "adaptive",
    agentToolsDeny: ["process"],
    telegramBlockStreaming: false,
    telegramDmPolicy: "pairing",
    telegramGroupPolicy: "disabled",
    telegramStreamMode: "partial",
    telegramThreadBindingsEnabled: false,
    defaultQueueMode: "steer",
    ...overrides
  };
}

test("buildSystemContext summarizes the current workspace contract", () => {
  const context = buildSystemContext(createPluginConfig());

  assert.match(context, /Repository workspace: \/workspace/);
  assert.match(context, /Tooling profiles: node22/);
  assert.match(context, /Stack languages: typescript/);
  assert.match(context, /Stack tools: pnpm/);
  assert.match(context, /ACP agents enabled for this workspace: codex, copilot/);
  assert.match(context, /Use ACP runtime via backend "acpx" with agentId "codex"/);
  assert.match(context, /Telegram DM policy: pairing; group policy: disabled; stream mode: partial\./);
  assert.match(context, /During built-in session-start prompts such as `\/new` or `\/reset`/);
  assert.match(context, /The process tool is disabled for this workspace\./);
});

test("buildSystemContext falls back cleanly when ACP agents are not explicitly configured", () => {
  const context = buildSystemContext(createPluginConfig({
    acpAllowedAgents: [],
    preferredAcpAgent: "gemini"
  }));

  assert.match(context, /ACP agents enabled for this workspace: gemini/);
  assert.match(context, /Prefer ACP mode "oneshot"/);
  assert.doesNotMatch(context, /\/models/);
});

test("buildStatusReply summary reports the supported runtime details", () => {
  const reply = buildStatusReply(createPluginConfig(), "summary");

  assert.match(reply, /Deployment profile: docker-local/);
  assert.match(reply, /Runtime profile: stable-chat/);
  assert.match(reply, /Queue profile: stable-chat/);
  assert.match(reply, /ACP default agent: codex/);
  assert.match(reply, /ACP allowed agents: codex, copilot/);
  assert.match(reply, /Telegram block streaming: disabled/);
  assert.match(reply, /Details: `\/repo-status runtime`\./);
  assert.doesNotMatch(reply, /Workspace thinking default:/);
});

test("buildStatusReply runtime detail includes the extended runtime view", () => {
  const reply = buildStatusReply(createPluginConfig({
    telegramThreadBindingsEnabled: true,
    telegramBlockStreaming: true
  }), "runtime");

  assert.match(reply, /Workspace thinking default: adaptive/);
  assert.match(reply, /Workspace: \/workspace/);
  assert.match(reply, /Denied tools: process/);
  assert.match(reply, /Telegram block streaming: enabled/);
  assert.match(reply, /Telegram ACP topic bindings: enabled/);
  assert.match(reply, /Run `\/acp doctor` to verify backend health\./);
});
