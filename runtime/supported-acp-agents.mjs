const SUPPORTED_ACP_AGENTS = ["codex", "claude", "gemini"];

export function normalizeAcpAgentValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isSupportedAcpAgent(value) {
  return SUPPORTED_ACP_AGENTS.includes(normalizeAcpAgentValue(value));
}

export function formatSupportedAcpAgents() {
  return SUPPORTED_ACP_AGENTS.join(", ");
}

export function assertSupportedAcpAgent(value, label = "ACP agent") {
  const normalized = normalizeAcpAgentValue(value);
  if (!normalized) return "";
  if (!isSupportedAcpAgent(normalized)) {
    throw new Error(`Unsupported ${label}: ${value}. Supported agents: ${formatSupportedAcpAgents()}.`);
  }
  return normalized;
}

export function assertSupportedAcpAgentList(values, label = "ACP agents") {
  return values.map((value, index) => assertSupportedAcpAgent(value, `${label}[${index}]`));
}
