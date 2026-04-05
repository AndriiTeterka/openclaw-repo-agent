import { normalizeCopilotCliToken } from "./copilot-auth-token.mjs";

export const COPILOT_TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
export const LEGACY_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

const COPILOT_TOKEN_CACHE_GRACE_MS = 300 * 1000;
const DEFAULT_DIRECT_TOKEN_TTL_MS = 60 * 60 * 1000;

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function isCopilotRuntimeTokenCacheUsable(cache, now = Date.now()) {
  return Number(cache?.expiresAt) - now > COPILOT_TOKEN_CACHE_GRACE_MS;
}

export function deriveCopilotApiBaseUrlFromToken(token) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return null;

  const proxyEndpoint = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim();
  if (!proxyEndpoint) return null;

  const host = proxyEndpoint.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return host ? `https://${host}` : null;
}

export function parseCopilotTokenResponse(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }

  const asRecord = value;
  const token = asRecord.token;
  const rawExpiresAt = asRecord.expires_at ?? asRecord.expiresAt;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }

  let expiresAtMs;
  if (typeof rawExpiresAt === "number" && Number.isFinite(rawExpiresAt)) {
    expiresAtMs = rawExpiresAt < 1e11 ? rawExpiresAt * 1000 : rawExpiresAt;
  } else if (typeof rawExpiresAt === "string" && rawExpiresAt.trim().length > 0) {
    const parsed = Number.parseInt(rawExpiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("Copilot token response has invalid expires_at");
    }
    expiresAtMs = parsed < 1e11 ? parsed * 1000 : parsed;
  } else {
    throw new Error("Copilot token response missing expires_at");
  }

  return {
    token,
    expiresAt: expiresAtMs,
  };
}

function resolveDirectTokenTtlMs(env = process.env) {
  const parsed = Number.parseInt(String(env?.OPENCLAW_COPILOT_DIRECT_TOKEN_TTL_MS ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > COPILOT_TOKEN_CACHE_GRACE_MS) return parsed;
  return DEFAULT_DIRECT_TOKEN_TTL_MS;
}

export async function probeCopilotApiBaseUrl({
  token,
  fetchImpl = globalThis.fetch,
  candidateBaseUrls = [],
} = {}) {
  const normalizedToken = normalizeCopilotCliToken(token);
  if (!normalizedToken || typeof fetchImpl !== "function") return null;

  const candidates = uniqueStrings([
    ...candidateBaseUrls,
    deriveCopilotApiBaseUrlFromToken(normalizedToken),
    DEFAULT_COPILOT_API_BASE_URL,
    LEGACY_COPILOT_API_BASE_URL,
  ]);

  let lastHttpStatus = "";
  for (const baseUrl of candidates) {
    try {
      const response = await fetchImpl(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${normalizedToken}`,
        },
      });

      lastHttpStatus = String(response.status);
      if (response.ok) {
        return {
          baseUrl,
          httpStatus: response.status,
        };
      }
    } catch {
      // Ignore individual probe failures and continue to the next candidate.
    }
  }

  return lastHttpStatus
    ? {
        baseUrl: "",
        httpStatus: Number.parseInt(lastHttpStatus, 10) || 0,
      }
    : null;
}

export async function resolveCopilotRuntimeAuth({
  githubToken = "",
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedToken = normalizeCopilotCliToken(githubToken)
    || normalizeCopilotCliToken(env?.COPILOT_GITHUB_TOKEN ?? "");

  if (!normalizedToken) {
    return {
      ok: false,
      status: "missing",
      httpStatus: "",
      errorMessage: "Missing Copilot runtime token.",
    };
  }

  const directProbe = await probeCopilotApiBaseUrl({
    token: normalizedToken,
    fetchImpl,
  });
  if (directProbe?.baseUrl) {
    return {
      ok: true,
      status: "ok",
      httpStatus: String(directProbe.httpStatus || 200),
      token: normalizedToken,
      expiresAt: Date.now() + resolveDirectTokenTtlMs(env),
      baseUrl: directProbe.baseUrl,
      source: `direct:${directProbe.baseUrl}`,
    };
  }

  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      status: "network_error",
      httpStatus: "",
      errorMessage: "Fetch API is unavailable for Copilot token exchange.",
    };
  }

  try {
    const response = await fetchImpl(COPILOT_TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${normalizedToken}`,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: `http_${response.status}`,
        httpStatus: String(response.status),
        errorMessage: `Copilot token exchange failed: HTTP ${response.status}`,
      };
    }

    const exchanged = parseCopilotTokenResponse(await response.json());
    const exchangedProbe = await probeCopilotApiBaseUrl({
      token: exchanged.token,
      fetchImpl,
      candidateBaseUrls: [deriveCopilotApiBaseUrlFromToken(exchanged.token)],
    });
    return {
      ok: true,
      status: "ok",
      httpStatus: String(response.status),
      token: exchanged.token,
      expiresAt: exchanged.expiresAt,
      baseUrl: exchangedProbe?.baseUrl || deriveCopilotApiBaseUrlFromToken(exchanged.token) || DEFAULT_COPILOT_API_BASE_URL,
      source: `fetched:${COPILOT_TOKEN_EXCHANGE_URL}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: "network_error",
      httpStatus: "",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
