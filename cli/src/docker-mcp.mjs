import crypto from "node:crypto";
import path from "node:path";

export const DEFAULT_DOCKER_MCP_SERVERS = ["docker", "fetch", "filesystem", "github-official", "playwright", "context7"];
export const DOCKER_MCP_REQUIRED_RECOVERY = "Run `openclaw-repo-agent mcp setup` to reactivate the repo config and `openclaw-repo-agent mcp connect` to reconnect Codex.";

function sanitizeSecretSegment(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSecretEntryNames(secretEntries = []) {
  return new Set(secretEntries.map((entry) => {
    if (typeof entry === "string") return entry;
    return String(entry?.name ?? "").trim();
  }).filter(Boolean));
}

export function buildRepoDockerMcpSecretPrefix(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const repoSegment = sanitizeSecretSegment(path.basename(resolvedRoot)) || "repo";
  const hash = crypto.createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 12);
  return `openclaw-repo-agent.${repoSegment}.${hash}`;
}

export function hashDockerMcpSecretValue(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function isConfiguredDockerMcpSecretValue(value, placeholderPrefixes = []) {
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return false;
  return !placeholderPrefixes.some((prefix) => normalizedValue.startsWith(prefix));
}

export function buildDockerMcpSecretSpecs(repoRoot) {
  const prefix = buildRepoDockerMcpSecretPrefix(repoRoot);
  return [
    {
      envKey: "TELEGRAM_BOT_TOKEN",
      secretName: `${prefix}.telegram_bot_token`,
      label: "Telegram bot token",
      placeholderPrefixes: ["replace-with-"]
    },
    {
      envKey: "OPENAI_API_KEY",
      secretName: `${prefix}.openai_api_key`,
      label: "OpenAI API key",
      placeholderPrefixes: []
    },
    {
      envKey: "GITHUB_PERSONAL_ACCESS_TOKEN",
      secretName: "github.personal_access_token",
      label: "GitHub personal access token",
      placeholderPrefixes: []
    }
  ];
}

export function buildDockerMcpSecretPlan(repoRoot, localEnv = {}, secretEntries = []) {
  const presentSecretNames = normalizeSecretEntryNames(secretEntries);
  return buildDockerMcpSecretSpecs(repoRoot).map((spec) => {
    const rawValue = String(localEnv?.[spec.envKey] ?? "").trim();
    const configured = isConfiguredDockerMcpSecretValue(rawValue, spec.placeholderPrefixes);
    return {
      ...spec,
      configured,
      present: presentSecretNames.has(spec.secretName),
      desiredHash: configured ? hashDockerMcpSecretValue(rawValue) : ""
    };
  });
}

export function summarizeDockerMcpSecretPlan(plan = []) {
  const configured = plan.filter((entry) => entry.configured);
  const synced = configured.filter((entry) => entry.present);
  return {
    configuredCount: configured.length,
    syncedConfiguredCount: synced.length,
    missingConfiguredSecrets: configured.filter((entry) => !entry.present).map((entry) => entry.secretName),
    managedSecretNames: plan.filter((entry) => entry.present).map((entry) => entry.secretName),
    configuredSecretNames: configured.map((entry) => entry.secretName)
  };
}
