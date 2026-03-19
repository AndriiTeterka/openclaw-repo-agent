const PLUGIN_ID = "workspace-openclaw";

function listOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter(Boolean);
}

function buildSystemContext(config) {
  const verificationCommands = listOfStrings(config.verificationCommands);
  const acpAllowedAgents = listOfStrings(config.acpAllowedAgents);
  const preferredAcpAgent = String(config.preferredAcpAgent ?? "").trim();
  const preferredAcpMode = String(config.preferredAcpMode ?? "").trim() || "oneshot";
  const agentDefaultModel = String(config.agentDefaultModel ?? "").trim() || "not set";
  const agentVerboseDefault = String(config.agentVerboseDefault ?? "").trim() || "on";
  const agentThinkingDefault = String(config.agentThinkingDefault ?? "").trim() || "adaptive";
  const agentToolsDeny = new Set(listOfStrings(config.agentToolsDeny));
  const workspace = String(config.workspace ?? "").trim() || "/workspace";
  const repoRoot = String(config.repoRoot ?? "").trim() || workspace;
  const repoPath = String(config.repoPath ?? "").trim();
  const toolingProfile = String(config.toolingProfile ?? "").trim();
  const runtimeProfile = String(config.runtimeProfile ?? "").trim() || "stable-chat";
  const queueProfile = String(config.queueProfile ?? "").trim() || runtimeProfile;
  const deploymentProfile = String(config.deploymentProfile ?? "").trim() || "docker-local";
  const queueMode = String(config.defaultQueueMode ?? "").trim() || "steer";
  const telegramBlockStreaming = Boolean(config.telegramBlockStreaming);
  const telegramDmPolicy = String(config.telegramDmPolicy ?? "").trim() || "pairing";
  const telegramGroupPolicy = String(config.telegramGroupPolicy ?? "").trim() || "disabled";
  const telegramStreamMode = String(config.telegramStreamMode ?? "").trim() || "partial";
  const telegramAllowFrom = listOfStrings(config.telegramAllowFrom);
  const telegramGroupAllowFrom = listOfStrings(config.telegramGroupAllowFrom);
  const telegramThreadBindingsEnabled = Boolean(config.telegramThreadBindingsEnabled);
  const enabledAcpAgents = acpAllowedAgents.length > 0
    ? acpAllowedAgents
    : preferredAcpAgent
      ? [preferredAcpAgent]
      : [];

  const lines = [
    `Repository workspace: ${workspace}`,
    `Repository root: ${repoRoot}`,
    repoPath ? `Host repo path: ${repoPath}` : "",
    toolingProfile ? `Tooling profile: ${toolingProfile}` : "",
    `Deployment profile: ${deploymentProfile}`,
    `Runtime profile: ${runtimeProfile}`,
    `Queue profile: ${queueProfile}`,
    `Workspace agent default model: ${agentDefaultModel}`,
    `Workspace verbose default: ${agentVerboseDefault}`,
    `Workspace thinking default: ${agentThinkingDefault}`,
    `ACP agents enabled for this workspace: ${enabledAcpAgents.length > 0 ? enabledAcpAgents.join(", ") : "not set"}`,
    `Use ACP runtime via backend "acpx" with agentId "${preferredAcpAgent || "not set"}" for repository inspection, edits, and verification.`,
    `Prefer ACP mode "${preferredAcpMode}" unless the user explicitly asks for a different ACP mode.`,
    `Default inbound queue mode for this workspace is "${queueMode}".`,
    "For browser automation in this workspace, use `playwright-cli` only. Do not use `npx playwright`.",
    "Save screenshots and other Playwright artifacts under `.openclaw/playwright/artifacts/`. Do not create root-level folders such as `tmp-playwright/`.",
    "In Telegram or ACP runs, avoid parallel tool calls unless they are clearly necessary; prefer one short command at a time so tool output does not stall.",
    `Telegram DM policy: ${telegramDmPolicy}; group policy: ${telegramGroupPolicy}; stream mode: ${telegramStreamMode}.`,
    telegramAllowFrom.length > 0 ? `Telegram DM allowlist entries: ${telegramAllowFrom.join(", ")}` : "",
    telegramGroupAllowFrom.length > 0 ? `Telegram group allowlist entries: ${telegramGroupAllowFrom.join(", ")}` : "",
    "If a newer Telegram message is a fresh standalone cancellation such as \"stop\", \"cancel\", or \"dont fix\", treat it as cancellation and avoid any further edits or verification after the next tool boundary.",
    "If a cancellation arrives after edits or verification already finished, do not claim that nothing changed. State that the prior run already completed, summarize what changed, and offer to revert it if the user wants.",
    agentToolsDeny.has("process")
      ? "The process tool is disabled for this workspace. Keep Read and Exec activity visible, but do not attempt background-process polling."
      : "",
    "When a verification step may take more than a few seconds, send a brief commentary update before waiting on it.",
    telegramBlockStreaming
      ? "Telegram block streaming is enabled; early assistant updates should be delivered as separate Telegram messages."
      : "Telegram block streaming is disabled; Telegram uses preview edits until the final reply.",
    telegramThreadBindingsEnabled
      ? "Telegram topic thread bindings are enabled for this workspace; topic traffic may spawn ACP sessions."
      : "Telegram ACP thread bindings are disabled by default; use oneshot ACP turns or explicit /acp commands instead of assuming thread-bound ACP sessions.",
  ];

  if (verificationCommands.length > 0) {
    lines.push("Run these verification commands after code changes when relevant:");
    for (const command of verificationCommands) lines.push(`- ${command}`);
  }

  return lines.filter(Boolean).join("\n");
}

function buildStatusReply(config, detail) {
  const verificationCommands = listOfStrings(config.verificationCommands);
  const acpAllowedAgents = listOfStrings(config.acpAllowedAgents);
  const preferredAcpAgent = String(config.preferredAcpAgent ?? "").trim();
  const preferredAcpMode = String(config.preferredAcpMode ?? "").trim() || "oneshot";
  const agentDefaultModel = String(config.agentDefaultModel ?? "").trim() || "not set";
  const agentVerboseDefault = String(config.agentVerboseDefault ?? "").trim() || "on";
  const agentThinkingDefault = String(config.agentThinkingDefault ?? "").trim() || "adaptive";
  const agentToolsDeny = new Set(listOfStrings(config.agentToolsDeny));
  const projectName = String(config.projectName ?? "").trim() || "workspace";
  const workspace = String(config.workspace ?? "").trim() || "/workspace";
  const repoRoot = String(config.repoRoot ?? "").trim() || workspace;
  const repoPath = String(config.repoPath ?? "").trim();
  const toolingProfile = String(config.toolingProfile ?? "").trim() || "none";
  const runtimeProfile = String(config.runtimeProfile ?? "").trim() || "stable-chat";
  const queueProfile = String(config.queueProfile ?? "").trim() || runtimeProfile;
  const deploymentProfile = String(config.deploymentProfile ?? "").trim() || "docker-local";
  const queueMode = String(config.defaultQueueMode ?? "").trim() || "steer";
  const telegramBlockStreaming = Boolean(config.telegramBlockStreaming);
  const telegramDmPolicy = String(config.telegramDmPolicy ?? "").trim() || "pairing";
  const telegramGroupPolicy = String(config.telegramGroupPolicy ?? "").trim() || "disabled";
  const telegramStreamMode = String(config.telegramStreamMode ?? "").trim() || "partial";
  const telegramThreadBindingsEnabled = Boolean(config.telegramThreadBindingsEnabled);
  const enabledAcpAgents = acpAllowedAgents.length > 0
    ? acpAllowedAgents
    : preferredAcpAgent
      ? [preferredAcpAgent]
      : [];

  const detailMode = String(detail ?? "summary").trim() || "summary";
  if (detailMode === "verification") {
    return verificationCommands.length > 0
      ? `Verification commands:\n${verificationCommands.map((command) => `- ${command}`).join("\n")}`
      : "No verification commands are configured for this workspace.";
  }

  if (detailMode === "runtime") {
    return [
      `Deployment profile: ${deploymentProfile}`,
      `Runtime profile: ${runtimeProfile}`,
      `Queue profile: ${queueProfile}`,
      `ACP default agent: ${preferredAcpAgent || "not set"}`,
      `ACP allowed agents: ${enabledAcpAgents.length > 0 ? enabledAcpAgents.join(", ") : "not set"}`,
      `Preferred ACP mode: ${preferredAcpMode}`,
      `Workspace agent default model: ${agentDefaultModel}`,
      `Workspace verbose default: ${agentVerboseDefault}`,
      `Workspace thinking default: ${agentThinkingDefault}`,
      `Denied tools: ${agentToolsDeny.size > 0 ? Array.from(agentToolsDeny).join(", ") : "none"}`,
      `Workspace: ${workspace}`,
      `Repo root: ${repoRoot}`,
      repoPath ? `Host repo path: ${repoPath}` : "",
      `Tooling profile: ${toolingProfile}`,
      `Default queue mode: ${queueMode}`,
      `Telegram DM policy: ${telegramDmPolicy}`,
      `Telegram group policy: ${telegramGroupPolicy}`,
      `Telegram stream mode: ${telegramStreamMode}`,
      `Telegram block streaming: ${telegramBlockStreaming ? "enabled" : "disabled"}`,
      `Telegram ACP topic bindings: ${telegramThreadBindingsEnabled ? "enabled" : "disabled"}`,
      "Run `/acp doctor` to verify backend health.",
    ].filter(Boolean).join("\n");
  }

  return [
    `Project: ${projectName}`,
    `Workspace: ${workspace}`,
    `Repo root: ${repoRoot}`,
    repoPath ? `Host repo path: ${repoPath}` : "",
    `Deployment profile: ${deploymentProfile}`,
    `Tooling profile: ${toolingProfile}`,
    `Runtime profile: ${runtimeProfile}`,
    `Queue profile: ${queueProfile}`,
    `ACP default agent: ${preferredAcpAgent || "not set"}`,
    `ACP allowed agents: ${enabledAcpAgents.length > 0 ? enabledAcpAgents.join(", ") : "not set"}`,
    `Preferred ACP mode: ${preferredAcpMode}`,
    `Workspace agent default model: ${agentDefaultModel}`,
    `Workspace verbose default: ${agentVerboseDefault}`,
    `Denied tools: ${agentToolsDeny.size > 0 ? Array.from(agentToolsDeny).join(", ") : "none"}`,
    `Default queue mode: ${queueMode}`,
    `Telegram DM policy: ${telegramDmPolicy}`,
    `Telegram group policy: ${telegramGroupPolicy}`,
    `Telegram stream mode: ${telegramStreamMode}`,
    `Telegram block streaming: ${telegramBlockStreaming ? "enabled" : "disabled"}`,
    `Telegram ACP topic bindings: ${telegramThreadBindingsEnabled ? "enabled" : "disabled"}`,
    `Verification commands: ${verificationCommands.length}`,
    "Details: `/repo-status verification` or `/repo-status runtime`.",
  ].filter(Boolean).join("\n");
}

const plugin = {
  id: PLUGIN_ID,
  name: "Workspace OpenClaw",
  description: "Workspace-specific OpenClaw guidance and status commands for Telegram and ACP flows.",
  register(api) {
    api.on("before_prompt_build", async () => {
      const context = buildSystemContext(api.pluginConfig ?? {});
      if (!context) return {};
      return {
        prependSystemContext: context,
      };
    });

    api.registerCommand({
      name: "repo-status",
      description: "Show repository-specific OpenClaw, Telegram, and ACP defaults for this workspace.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const detail = String(ctx.args ?? "").trim() || "summary";
        return {
          text: buildStatusReply(api.pluginConfig ?? {}, detail),
        };
      },
    });
  },
};

export default plugin;
