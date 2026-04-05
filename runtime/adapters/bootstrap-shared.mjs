import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "../shared.mjs";

export function isMissingBinary(stderr = "") {
  const message = String(stderr ?? "").trim();
  if (!message) return false;

  return /\bspawn(?:\s+\S+)*\s+ENOENT\b/i.test(message)
    || /\bENOENT\b[\s\S]*\bspawn\b/i.test(message)
    || /\bcommand not found\b/i.test(message)
    || /\bis not recognized as an internal or external command\b/i.test(message);
}

export function extractJwtPayload(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return null;

  try {
    const [, payload] = raw.split(".");
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const parsed = Date.parse(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export function normalizeGeminiRefreshExpiry(expiresInSeconds, now = Date.now()) {
  const expiresIn = Number(expiresInSeconds);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return Number.NaN;
  return now + expiresIn * 1000 - 5 * 60 * 1000;
}

export function findFirstStringProperty(value, keys, visited = new Set()) {
  if (!value || typeof value !== "object") return "";
  if (visited.has(value)) return "";
  visited.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstStringProperty(entry, keys, visited);
      if (found) return found;
    }
    return "";
  }

  for (const key of keys) {
    const candidate = String(value?.[key] ?? "").trim();
    if (candidate) return candidate;
  }

  for (const entry of Object.values(value)) {
    const found = findFirstStringProperty(entry, keys, visited);
    if (found) return found;
  }

  return "";
}

export function normalizePortablePath(value) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function resolveMainAgentDir(homeDir) {
  return path.join(homeDir, ".openclaw", "agents", "main", "agent");
}

function resolveWorkspaceAgentDir(homeDir) {
  return path.join(homeDir, ".openclaw", "agents", "workspace", "agent");
}

export async function resolveBootstrapAgentDirs(homeDir, configuredAgentDir = "") {
  const normalizedConfiguredAgentDir = String(configuredAgentDir ?? "").trim();
  const agentRoot = path.join(homeDir, ".openclaw", "agents");
  const discoveredDirs = [];

  try {
    const entries = await fs.readdir(agentRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      discoveredDirs.push(path.join(agentRoot, entry.name, "agent"));
    }
  } catch {
    // Ignore missing agent roots during first-time bootstrap.
  }

  return [...new Set([
    resolveMainAgentDir(homeDir),
    resolveWorkspaceAgentDir(homeDir),
    normalizedConfiguredAgentDir,
    ...discoveredDirs,
  ].filter(Boolean))];
}

function normalizeAuthProfileStore(store) {
  if (!store || typeof store !== "object") {
    return {
      version: 1,
      profiles: {},
      lastGood: {},
      usageStats: {},
    };
  }

  const profiles = store.profiles && typeof store.profiles === "object" ? store.profiles : {};
  const lastGood = store.lastGood && typeof store.lastGood === "object" ? store.lastGood : {};
  const usageStats = store.usageStats && typeof store.usageStats === "object" ? store.usageStats : {};
  return {
    ...store,
    version: Number.isFinite(Number(store.version)) ? Number(store.version) : 1,
    profiles,
    lastGood,
    usageStats,
  };
}

async function upsertAuthProfileStore(agentDir, profileId, credential) {
  const storePath = path.join(agentDir, "auth-profiles.json");
  const store = normalizeAuthProfileStore(await readJsonFile(storePath, null));

  store.profiles[profileId] = credential;
  await writeJsonFile(storePath, store);
  await fs.chmod(storePath, 0o600);
}

async function removeAuthProfileStore(agentDir, profileId, providerId = "") {
  const storePath = path.join(agentDir, "auth-profiles.json");
  const store = normalizeAuthProfileStore(await readJsonFile(storePath, null));
  if (!store.profiles[profileId] && (!providerId || !store.lastGood[providerId]) && !store.usageStats[profileId]) return;

  delete store.profiles[profileId];
  if (providerId && store.lastGood[providerId] === profileId) delete store.lastGood[providerId];
  delete store.usageStats[profileId];

  await writeJsonFile(storePath, store);
  await fs.chmod(storePath, 0o600);
}

export async function syncAuthProfile(agentDirs, profileId, credential) {
  for (const agentDir of agentDirs) {
    await ensureDir(agentDir);
    await upsertAuthProfileStore(agentDir, profileId, credential);
  }
}

export async function removeAuthProfile(agentDirs, profileId, providerId = "") {
  for (const agentDir of agentDirs) {
    await ensureDir(agentDir);
    await removeAuthProfileStore(agentDir, profileId, providerId);
  }
}

export async function copyMountedAuthFile(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) return false;
  if (await fileExists(targetPath)) return false;
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  await fs.chmod(targetPath, 0o600);
  return true;
}

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function readJsonFileOrFallback(filePath, fallback = {}) {
  try {
    return await readJsonFile(filePath, fallback);
  } catch {
    return fallback;
  }
}
