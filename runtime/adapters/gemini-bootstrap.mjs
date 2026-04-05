import fs from "node:fs/promises";
import path from "node:path";

import { fileExists, readJsonFile, writeJsonFile } from "../shared.mjs";
import {
  asObject,
  findFirstStringProperty,
  normalizeGeminiRefreshExpiry,
  normalizePortablePath,
  normalizeTimestamp,
  syncAuthProfile,
} from "./bootstrap-shared.mjs";

const GEMINI_CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
];
const GEMINI_CODE_ASSIST_TIMEOUT_MS = 10_000;
const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GEMINI_OAUTH_CLIENT_ID_ENV = "OPENCLAW_GEMINI_OAUTH_CLIENT_ID";
const GEMINI_OAUTH_CLIENT_SECRET_ENV = "OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET";
const GEMINI_CLI_PACKAGE_ROOT_ENV = "OPENCLAW_GEMINI_CLI_PACKAGE_ROOT";
const GEMINI_OAUTH_CLIENT_ID_PATTERN = /\b\d{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com\b/;
const GEMINI_OAUTH_CLIENT_SECRET_PATTERN = /\bGOCSPX-[A-Za-z0-9_-]+\b/;
const GEMINI_TIER_FREE = "free-tier";
const GEMINI_TIER_LEGACY = "legacy-tier";
const GEMINI_TIER_STANDARD = "standard-tier";
const GEMINI_OAUTH_PERSONAL_AUTH_TYPE = "oauth-personal";
const GEMINI_CLIENT_METADATA = Object.freeze({
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
});

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function resolveGeminiCliBundleRoots(env = process.env) {
  const explicitRoot = String(env?.[GEMINI_CLI_PACKAGE_ROOT_ENV] ?? "").trim();
  const authCliBin = String(env?.OPENCLAW_AGENT_AUTH_CLI_BIN ?? "").trim();
  const authCliRoot = authCliBin
    ? path.resolve(path.dirname(authCliBin), "..", "lib", "node_modules", "@google", "gemini-cli", "bundle")
    : "";

  return uniqueStrings([
    explicitRoot,
    authCliRoot,
    "/usr/local/lib/node_modules/@google/gemini-cli/bundle",
    "/usr/lib/node_modules/@google/gemini-cli/bundle",
  ]);
}

async function listGeminiCliBundleFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
    }
  }

  return files;
}

function extractGeminiOauthClientPair(source = "") {
  const clientId = source.match(GEMINI_OAUTH_CLIENT_ID_PATTERN)?.[0] ?? "";
  const clientSecret = source.match(GEMINI_OAUTH_CLIENT_SECRET_PATTERN)?.[0] ?? "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function discoverGeminiCliOAuthClientPair(env = process.env) {
  for (const rootDir of resolveGeminiCliBundleRoots(env)) {
    const bundleFiles = await listGeminiCliBundleFiles(rootDir);
    if (bundleFiles.length === 0) continue;

    let clientId = "";
    let clientSecret = "";
    for (const filePath of bundleFiles) {
      let source = "";
      try {
        source = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }

      if (!clientId) clientId = source.match(GEMINI_OAUTH_CLIENT_ID_PATTERN)?.[0] ?? "";
      if (!clientSecret) clientSecret = source.match(GEMINI_OAUTH_CLIENT_SECRET_PATTERN)?.[0] ?? "";
      if (clientId && clientSecret) {
        return { clientId, clientSecret, source: filePath };
      }
    }
  }

  return null;
}

async function resolveGeminiOAuthClientPair(authData, env = process.env) {
  const authClientId = findFirstStringProperty(authData, ["client_id", "clientId"]);
  const authClientSecret = findFirstStringProperty(authData, ["client_secret", "clientSecret"]);
  if (authClientId || authClientSecret) {
    if (!authClientId || !authClientSecret) {
      throw new Error("Gemini OAuth credentials are missing client_id or client_secret.");
    }
    return { clientId: authClientId, clientSecret: authClientSecret, source: "auth-data" };
  }

  const envClientId = String(env?.[GEMINI_OAUTH_CLIENT_ID_ENV] ?? "").trim();
  const envClientSecret = String(env?.[GEMINI_OAUTH_CLIENT_SECRET_ENV] ?? "").trim();
  if (envClientId || envClientSecret) {
    if (!envClientId || !envClientSecret) {
      throw new Error(`${GEMINI_OAUTH_CLIENT_ID_ENV} and ${GEMINI_OAUTH_CLIENT_SECRET_ENV} must both be set.`);
    }
    return { clientId: envClientId, clientSecret: envClientSecret, source: "env" };
  }

  const discovered = await discoverGeminiCliOAuthClientPair(env);
  if (discovered) return discovered;

  throw new Error("Gemini OAuth client credentials could not be resolved from mounted auth data or the installed Gemini CLI.");
}

export function resolveGeminiProjectId(projectStore, hostRepoRoot = "") {
  const projects = projectStore?.projects;
  if (!projects || typeof projects !== "object") return "";

  const normalizedRepoRoot = normalizePortablePath(hostRepoRoot);
  const entries = Object.entries(projects)
    .map(([rootPath, projectId]) => ({
      rootPath: normalizePortablePath(rootPath),
      projectId: String(projectId ?? "").trim(),
    }))
    .filter((entry) => entry.rootPath && entry.projectId);

  if (normalizedRepoRoot) {
    const match = entries
      .filter((entry) => normalizedRepoRoot === entry.rootPath || normalizedRepoRoot.startsWith(`${entry.rootPath}/`))
      .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
    if (match?.projectId) return match.projectId;
  }

  const uniqueProjects = [...new Set(entries.map((entry) => entry.projectId))];
  return uniqueProjects.length === 1 ? uniqueProjects[0] : "";
}

function extractGeminiErrorMessage(payload, fallback = "") {
  const jsonMessage = String(payload?.error?.message ?? "").trim();
  if (jsonMessage) return jsonMessage;
  return String(fallback ?? "").trim();
}

function isVpcScAffectedGeminiUser(payload) {
  if (!payload || typeof payload !== "object") return false;
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (entry) => typeof entry === "object" && entry && entry.reason === "SECURITY_POLICY_VIOLATED",
  );
}

function getDefaultGeminiTier(allowedTiers) {
  if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) {
    return { id: GEMINI_TIER_LEGACY };
  }
  return allowedTiers.find((tier) => tier?.isDefault) ?? { id: GEMINI_TIER_LEGACY };
}

function isGeminiProjectRequirementError(error) {
  return /requires\s+GOOGLE_CLOUD_PROJECT|requires setting the GOOGLE_CLOUD_PROJECT/i.test(
    String(error instanceof Error ? error.message : error ?? "").trim(),
  );
}

async function fetchJsonWithTimeout(url, init = {}, timeoutMs = GEMINI_CODE_ASSIST_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is unavailable in the runtime bootstrap environment.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { response, text, json };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms calling ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pollGeminiOperation(endpoint, operationName, headers, fetchImpl = globalThis.fetch) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { response, json, text } = await fetchJsonWithTimeout(
      `${endpoint}/v1internal/${operationName}`,
      { headers },
      GEMINI_CODE_ASSIST_TIMEOUT_MS,
      fetchImpl,
    );
    if (!response.ok) {
      const errorMessage = extractGeminiErrorMessage(json, text);
      throw new Error(
        `Failed to poll Cloud Code Assist operation: ${response.status} ${response.statusText}${errorMessage ? `: ${errorMessage}` : ""}`,
      );
    }
    if (json?.done) {
      return json;
    }
  }

  throw new Error("Cloud Code Assist project provisioning timed out.");
}

export async function discoverGeminiCliProjectId(accessToken, configuredProjectId = "", fetchImpl = globalThis.fetch) {
  const normalizedAccessToken = String(accessToken ?? "").trim();
  const projectOverride = String(configuredProjectId ?? "").trim();
  if (!normalizedAccessToken) {
    throw new Error("Missing Gemini OAuth access token.");
  }

  const metadata = { ...GEMINI_CLIENT_METADATA };
  const headers = {
    Authorization: `Bearer ${normalizedAccessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": `gl-node/${process.versions.node}`,
    "Client-Metadata": JSON.stringify(metadata),
  };
  const loadBody = {
    ...(projectOverride ? { cloudaicompanionProject: projectOverride } : {}),
    metadata: {
      ...metadata,
      ...(projectOverride ? { duetProject: projectOverride } : {}),
    },
  };

  let activeEndpoint = GEMINI_CODE_ASSIST_ENDPOINTS[0];
  let loadData = {};
  let loadError = null;

  for (const endpoint of GEMINI_CODE_ASSIST_ENDPOINTS) {
    try {
      const { response, json, text } = await fetchJsonWithTimeout(
        `${endpoint}/v1internal:loadCodeAssist`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(loadBody),
        },
        GEMINI_CODE_ASSIST_TIMEOUT_MS,
        fetchImpl,
      );

      if (!response.ok) {
        if (isVpcScAffectedGeminiUser(json)) {
          loadData = { currentTier: { id: GEMINI_TIER_STANDARD } };
          activeEndpoint = endpoint;
          loadError = null;
          break;
        }

        const errorMessage = extractGeminiErrorMessage(json, text);
        loadError = new Error(
          `loadCodeAssist failed: ${response.status} ${response.statusText}${errorMessage ? `: ${errorMessage}` : ""}`,
        );
        continue;
      }

      loadData = json && typeof json === "object" ? json : {};
      activeEndpoint = endpoint;
      loadError = null;
      break;
    } catch (error) {
      loadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const hasLoadData = Boolean(loadData?.currentTier)
    || Boolean(loadData?.cloudaicompanionProject)
    || Boolean(loadData?.allowedTiers?.length);
  if (!hasLoadData) {
    throw loadError ?? new Error("Could not discover a Gemini Cloud Code Assist project.");
  }

  const currentProject = loadData?.cloudaicompanionProject;
  if (loadData?.currentTier) {
    if (typeof currentProject === "string" && currentProject) {
      return currentProject;
    }
    if (typeof currentProject === "object" && currentProject?.id) {
      return currentProject.id;
    }
    if (projectOverride) {
      return projectOverride;
    }
    throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
  }

  const tierId = getDefaultGeminiTier(loadData?.allowedTiers)?.id || GEMINI_TIER_FREE;
  if (tierId !== GEMINI_TIER_FREE && !projectOverride) {
    throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
  }

  const onboardBody = {
    tierId,
    metadata: {
      ...metadata,
    },
  };
  if (tierId !== GEMINI_TIER_FREE && projectOverride) {
    onboardBody.cloudaicompanionProject = projectOverride;
    onboardBody.metadata.duetProject = projectOverride;
  }

  const { response: onboardResponse, json: onboardJson, text: onboardText } = await fetchJsonWithTimeout(
    `${activeEndpoint}/v1internal:onboardUser`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(onboardBody),
    },
    GEMINI_CODE_ASSIST_TIMEOUT_MS,
    fetchImpl,
  );
  if (!onboardResponse.ok) {
    const errorMessage = extractGeminiErrorMessage(onboardJson, onboardText);
    throw new Error(
      `onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}${errorMessage ? `: ${errorMessage}` : ""}`,
    );
  }

  let operation = onboardJson && typeof onboardJson === "object" ? onboardJson : {};
  if (!operation.done && operation.name) {
    operation = await pollGeminiOperation(activeEndpoint, operation.name, headers, fetchImpl);
  }

  const provisionedProjectId = operation?.response?.cloudaicompanionProject?.id;
  if (provisionedProjectId) {
    return provisionedProjectId;
  }
  if (projectOverride) {
    return projectOverride;
  }

  throw new Error("Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.");
}

export async function resolveGeminiBootstrapProjectId(accessToken, configuredProjectId = "", fetchImpl = globalThis.fetch) {
  try {
    return await discoverGeminiCliProjectId(accessToken, "", fetchImpl);
  } catch (error) {
    const fallbackProjectId = String(configuredProjectId ?? "").trim();
    if (!fallbackProjectId || !isGeminiProjectRequirementError(error)) {
      throw error;
    }
    return await discoverGeminiCliProjectId(accessToken, fallbackProjectId, fetchImpl);
  }
}

export async function refreshGeminiCliOAuthData(authData, fetchImpl = globalThis.fetch, env = process.env) {
  const refresh = String(authData?.refresh_token ?? authData?.refresh ?? "").trim();
  if (!refresh) {
    throw new Error("Gemini OAuth credentials are missing refresh token.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is unavailable in the runtime bootstrap environment.");
  }
  const { clientId, clientSecret } = await resolveGeminiOAuthClientPair(authData, env);

  const response = await fetchImpl(GEMINI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini OAuth refresh failed: ${errorText || response.statusText}`);
  }

  const payload = await response.json();
  const access = String(payload?.access_token ?? "").trim();
  const nextRefresh = String(payload?.refresh_token ?? refresh).trim();
  const expires = normalizeGeminiRefreshExpiry(payload?.expires_in);
  if (!access || !nextRefresh || !Number.isFinite(expires) || expires <= 0) {
    throw new Error("Gemini OAuth refresh returned incomplete credentials.");
  }

  return {
    access,
    refresh: nextRefresh,
    expires,
    authData: {
      ...authData,
      access_token: access,
      refresh_token: nextRefresh,
      expiry_date: expires,
      access,
      refresh: nextRefresh,
      expires,
    },
  };
}

export async function ensureGeminiCliSettings(settingsPath, existingSettings = {}) {
  const current = asObject(existingSettings);
  const currentSecurity = asObject(current.security);
  const currentAuth = asObject(currentSecurity.auth);
  const nextSettings = {
    ...current,
    selectedAuthType: GEMINI_OAUTH_PERSONAL_AUTH_TYPE,
    security: {
      ...currentSecurity,
      auth: {
        ...currentAuth,
        selectedType: GEMINI_OAUTH_PERSONAL_AUTH_TYPE,
      },
    },
  };

  await writeJsonFile(settingsPath, nextSettings);
  await fs.chmod(settingsPath, 0o600);
}

async function readGeminiAccountMetadata(accountsPath) {
  if (!accountsPath || !(await fileExists(accountsPath))) {
    return { email: "", projectId: "" };
  }

  const accountData = await readJsonFile(accountsPath, null);
  return {
    email: findFirstStringProperty(accountData, ["email", "emailAddress"]),
    projectId: findFirstStringProperty(accountData, ["projectId", "project_id"]),
  };
}

async function readGeminiProjectMetadata(projectsPath, hostRepoRoot = "") {
  if (!projectsPath || !(await fileExists(projectsPath))) {
    return { projectId: "" };
  }

  const projectData = await readJsonFile(projectsPath, null);
  return {
    projectId: resolveGeminiProjectId(projectData, hostRepoRoot),
  };
}

export async function syncGeminiCliAuthProfiles(
  oauthCredsPath,
  accountsPath,
  projectsPath,
  hostRepoRoot,
  agentDirs,
  env = process.env,
  fetchImpl = globalThis.fetch,
) {
  const authData = await readJsonFile(oauthCredsPath, null);
  const sourceAccess = String(authData?.access_token ?? authData?.access ?? "").trim();
  const sourceRefresh = String(authData?.refresh_token ?? authData?.refresh ?? "").trim();
  const sourceExpires = normalizeTimestamp(authData?.expiry_date ?? authData?.expires);
  if (!sourceAccess || !sourceRefresh || !Number.isFinite(sourceExpires) || sourceExpires <= 0) {
    return { synced: false, reason: "Gemini OAuth credentials are missing access, refresh, or expiry fields." };
  }

  let refreshedAuth;
  try {
    refreshedAuth = await refreshGeminiCliOAuthData(authData, fetchImpl, env);
  } catch (error) {
    return {
      synced: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const { access, refresh, expires, authData: refreshedAuthData } = refreshedAuth;

  const accountMetadata = await readGeminiAccountMetadata(accountsPath);
  const projectMetadata = await readGeminiProjectMetadata(projectsPath, hostRepoRoot);
  const email = String(env.GOOGLE_ACCOUNT_EMAIL ?? accountMetadata.email ?? "").trim();
  const explicitProjectId = String(env.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT_ID ?? "").trim();
  const configuredProjectId = String(projectMetadata.projectId ?? accountMetadata.projectId ?? "").trim();
  let projectId = explicitProjectId;

  if (!projectId) {
    try {
      projectId = await resolveGeminiBootstrapProjectId(access, configuredProjectId, fetchImpl);
    } catch (error) {
      return {
        synced: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!projectId) {
    return {
      synced: false,
      reason: "OpenClaw could not resolve a valid Cloud Code Assist project for the Gemini OAuth token.",
    };
  }

  const credential = {
    type: "oauth",
    provider: "google-gemini-cli",
    access,
    refresh,
    expires,
    ...(email ? { email } : {}),
    ...(projectId
      ? {
          projectId,
          credentialExtra: { projectId },
        }
      : {}),
  };

  await syncAuthProfile(agentDirs, "google-gemini-cli:default", credential);
  return {
    synced: true,
    projectId,
    refreshedAuthData,
  };
}
