import { WORKSPACE_AUTOMATION_GUIDANCE_LINES } from "../../workspace-guidance.mjs";

const PLUGIN_ID = "workspace-openclaw";

function listOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function renderList(label, values) {
  const normalized = listOfStrings(values);
  return `${label}: ${normalized.length > 0 ? normalized.join(", ") : "none"}`;
}

function buildToolingSummary(config) {
  const lines = [];
  const toolingProfiles = listOfStrings(config.toolingProfiles);
  const languages = listOfStrings(config.stack?.languages);
  const tools = listOfStrings(config.stack?.tools);

  if (toolingProfiles.length > 0) lines.push(renderList("Tooling profiles", toolingProfiles));
  if (languages.length > 0) lines.push(renderList("Stack languages", languages));
  if (tools.length > 0) lines.push(renderList("Stack tools", tools));
  return lines;
}

function resolveEnabledAgents(config) {
  const acpAllowedAgents = listOfStrings(config.acpAllowedAgents);
  const preferredAcpAgent = String(config.preferredAcpAgent ?? "").trim();
  return acpAllowedAgents.length > 0
    ? acpAllowedAgents
    : (preferredAcpAgent ? [preferredAcpAgent] : []);
}

export function buildSystemContext(config) {
  const preferredAcpAgent = String(config.preferredAcpAgent ?? "").trim();
  const preferredAcpMode = String(config.preferredAcpMode ?? "").trim() || "oneshot";
  const agentDefaultModel = String(config.agentDefaultModel ?? "").trim() || "not set";
  const agentVerboseDefault = String(config.agentVerboseDefault ?? "").trim() || "on";
  const agentThinkingDefault = String(config.agentThinkingDefault ?? "").trim() || "adaptive";
  const agentToolsDeny = new Set(listOfStrings(config.agentToolsDeny));
  const workspace = String(config.workspace ?? "").trim() || "/workspace";
  const repoRoot = String(config.repoRoot ?? "").trim() || workspace;
  const repoPath = String(config.repoPath ?? "").trim();
  const runtimeProfile = String(config.runtimeProfile ?? "").trim() || "stable-chat";
  const queueProfile = String(config.queueProfile ?? "").trim() || runtimeProfile;
  const deploymentProfile = String(config.deploymentProfile ?? "").trim() || "docker-local";
  const queueMode = String(config.defaultQueueMode ?? "").trim() || "steer";
  const telegramBlockStreaming = Boolean(config.telegramBlockStreaming);
  const telegramDmPolicy = String(config.telegramDmPolicy ?? "").trim() || "pairing";
  const telegramGroupPolicy = String(config.telegramGroupPolicy ?? "").trim() || "disabled";
  const telegramStreamMode = String(config.telegramStreamMode ?? "").trim() || "partial";
  const telegramThreadBindingsEnabled = Boolean(config.telegramThreadBindingsEnabled);
  const enabledAcpAgents = resolveEnabledAgents(config);

  const lines = [
    `Repository workspace: ${workspace}`,
    `Repository root: ${repoRoot}`,
    repoPath ? `Host repo path: ${repoPath}` : "",
    `Deployment profile: ${deploymentProfile}`,
    `Runtime profile: ${runtimeProfile}`,
    `Queue profile: ${queueProfile}`,
    ...buildToolingSummary(config),
    `Workspace agent default model: ${agentDefaultModel}`,
    `Workspace verbose default: ${agentVerboseDefault}`,
    `Workspace thinking default: ${agentThinkingDefault}`,
    `ACP agents enabled for this workspace: ${enabledAcpAgents.length > 0 ? enabledAcpAgents.join(", ") : "not set"}`,
    `Use ACP runtime via backend "acpx" with agentId "${preferredAcpAgent || "not set"}" for repository inspection, edits, and verification.`,
    `Prefer ACP mode "${preferredAcpMode}" unless the user explicitly asks for a different ACP mode.`,
    `Default inbound queue mode for this workspace is "${queueMode}".`,
    ...WORKSPACE_AUTOMATION_GUIDANCE_LINES,
    "During built-in session-start prompts such as `/new` or `/reset`, do not search the workspace or read skills just to confirm missing bootstrap files. If AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, or BOOTSTRAP.md are absent, accept that and greet the user immediately in 1-3 sentences.",
    `Telegram DM policy: ${telegramDmPolicy}; group policy: ${telegramGroupPolicy}; stream mode: ${telegramStreamMode}.`,
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

  return lines.filter(Boolean).join("\n");
}

export function buildStatusReply(config, detail) {
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
  const runtimeProfile = String(config.runtimeProfile ?? "").trim() || "stable-chat";
  const queueProfile = String(config.queueProfile ?? "").trim() || runtimeProfile;
  const deploymentProfile = String(config.deploymentProfile ?? "").trim() || "docker-local";
  const queueMode = String(config.defaultQueueMode ?? "").trim() || "steer";
  const telegramBlockStreaming = Boolean(config.telegramBlockStreaming);
  const telegramDmPolicy = String(config.telegramDmPolicy ?? "").trim() || "pairing";
  const telegramGroupPolicy = String(config.telegramGroupPolicy ?? "").trim() || "disabled";
  const telegramStreamMode = String(config.telegramStreamMode ?? "").trim() || "partial";
  const telegramThreadBindingsEnabled = Boolean(config.telegramThreadBindingsEnabled);
  const enabledAcpAgents = resolveEnabledAgents(config);
  const toolingSummary = buildToolingSummary(config);

  const detailMode = String(detail ?? "summary").trim() || "summary";
  const lines = [
    `Deployment profile: ${deploymentProfile}`,
    `Runtime profile: ${runtimeProfile}`,
    `Queue profile: ${queueProfile}`,
    ...toolingSummary,
    `ACP default agent: ${preferredAcpAgent || "not set"}`,
    `ACP allowed agents: ${enabledAcpAgents.length > 0 ? enabledAcpAgents.join(", ") : "not set"}`,
    `Preferred ACP mode: ${preferredAcpMode}`,
    `Workspace agent default model: ${agentDefaultModel}`,
    `Workspace verbose default: ${agentVerboseDefault}`,
    ...(detailMode === "runtime" ? [`Workspace thinking default: ${agentThinkingDefault}`] : []),
    `Denied tools: ${agentToolsDeny.size > 0 ? Array.from(agentToolsDeny).join(", ") : "none"}`,
    detailMode === "runtime" ? `Workspace: ${workspace}` : `Project: ${projectName}`,
    `Repo root: ${repoRoot}`,
    repoPath ? `Host repo path: ${repoPath}` : "",
    `Default queue mode: ${queueMode}`,
    `Telegram DM policy: ${telegramDmPolicy}`,
    `Telegram group policy: ${telegramGroupPolicy}`,
    `Telegram stream mode: ${telegramStreamMode}`,
    `Telegram block streaming: ${telegramBlockStreaming ? "enabled" : "disabled"}`,
    `Telegram ACP topic bindings: ${telegramThreadBindingsEnabled ? "enabled" : "disabled"}`,
    detailMode === "runtime" ? "Run `/acp doctor` to verify backend health." : "Details: `/repo-status runtime`.",
  ];

  return lines.filter(Boolean).join("\n");
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
