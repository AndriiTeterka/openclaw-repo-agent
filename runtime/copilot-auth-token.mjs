const COPILOT_TOKEN_KEYS = Object.freeze([
  "token",
  "access_token",
  "accessToken",
  "oauth_token",
  "oauthToken",
  "github_token",
  "githubToken",
  "secret",
  "value"
]);

function isLikelyCopilotCliToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  if (/^ghp_/i.test(normalized)) return false;
  if (/^github_pat_[A-Za-z0-9_]+$/i.test(normalized)) return true;
  if (/^gh[ours]_[A-Za-z0-9_]+$/i.test(normalized)) return true;
  return !/\s/.test(normalized)
    && normalized.length >= 20
    && !/[{}[\],]/.test(normalized);
}

export function normalizeCopilotCliToken(value) {
  const normalized = String(value ?? "").trim();
  return isLikelyCopilotCliToken(normalized) ? normalized : "";
}

function extractTokenFromObject(value, visited = new Set()) {
  if (!value || typeof value !== "object") return "";
  if (visited.has(value)) return "";
  visited.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const token = extractCopilotCliToken(entry, visited);
      if (token) return token;
    }
    return "";
  }

  for (const key of COPILOT_TOKEN_KEYS) {
    const token = normalizeCopilotCliToken(value?.[key]);
    if (token) return token;
  }

  for (const entry of Object.values(value)) {
    const token = extractCopilotCliToken(entry, visited);
    if (token) return token;
  }

  return "";
}

export function extractCopilotCliToken(value, visited = new Set()) {
  if (typeof value === "string") {
    const direct = normalizeCopilotCliToken(value);
    if (direct) return direct;

    const inline = String(value).match(/github_pat_[A-Za-z0-9_]+|gh[ours]_[A-Za-z0-9_]+/i);
    if (inline?.[0]) return normalizeCopilotCliToken(inline[0]);

    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "";
    try {
      return extractTokenFromObject(JSON.parse(trimmed), visited);
    } catch {
      return "";
    }
  }

  return extractTokenFromObject(value, visited);
}

export function resolveCopilotCliTokenFromSources(...values) {
  for (const value of values) {
    const token = extractCopilotCliToken(value);
    if (token) return token;
  }
  return "";
}
