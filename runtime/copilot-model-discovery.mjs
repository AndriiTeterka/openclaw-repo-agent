#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeCopilotCliToken } from "./copilot-auth-token.mjs";
import {
  discoverCopilotCliListedModelIds,
  resolveCopilotCliArgs,
  resolveCopilotCliCommand,
  resolveCopilotConfigPath,
  resolveCopilotHome,
} from "./copilot-installation.mjs";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  resolveCopilotRuntimeAuth,
} from "./copilot-runtime-auth.mjs";
import { sortedUniqueModelIds, uniqueStrings } from "./adapters/model-discovery-shared.mjs";
import {
  filterSupportedCopilotModelIds,
  normalizeCopilotModelId,
} from "./adapters/copilot-model-id-utils.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_DIRECT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROBE_CONCURRENCY = 2;
const DEFAULT_PROBE_PROMPT = "Say ok.";
const COPILOT_HOST = "https://github.com";
const COPILOT_INTEGRATION_ID = "openclaw-repo-agent";
const COPILOT_SESSION_ID_PREFIX = "openclaw-model-discovery";

function parseBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseIntegerEnv(value, fallback) {
  const numeric = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizePolicyState(model) {
  return String(model?.policy?.state ?? "").trim().toLowerCase();
}

function isSelectableModel(model) {
  const modelId = String(model?.id ?? "").trim();
  if (!modelId) return false;

  const policyState = normalizePolicyState(model);
  return policyState !== "disabled" && policyState !== "unconfigured";
}

function normalizeCopilotApiUrl(value = "") {
  const normalized = String(value ?? "").trim().replace(/\/+$/, "");
  return normalized || DEFAULT_COPILOT_API_BASE_URL;
}

function fileSignature(candidatePath = "") {
  const normalized = String(candidatePath ?? "").trim();
  if (!normalized) return "";
  try {
    const stats = fs.statSync(normalized);
    return `${normalized}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return normalized;
  }
}

function collectCopilotHomeSdkPaths(copilotHome = "") {
  const normalizedHome = String(copilotHome ?? "").trim();
  if (!normalizedHome) return [];

  const universalRoot = path.join(normalizedHome, "pkg", "universal");
  try {
    return fs.readdirSync(universalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(universalRoot, entry.name, "sdk", "index.js"))
      .filter((candidatePath) => fs.existsSync(candidatePath));
  } catch {
    return [];
  }
}

function candidateSdkPaths(explicitSdkPath = "", env = process.env) {
  return uniqueStrings([
    explicitSdkPath,
    ...collectCopilotHomeSdkPaths(resolveCopilotHome(env)),
  ]).filter((candidatePath) => fs.existsSync(candidatePath));
}

function discoverConfiguredModelIds(env = process.env) {
  const configPath = resolveCopilotConfigPath(env);
  if (!configPath || !fs.existsSync(configPath)) return [];

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return filterSupportedCopilotModelIds([
      String(config?.model ?? "").trim(),
      String(config?.chat_model ?? "").trim(),
      String(config?.default_model ?? "").trim(),
    ]);
  } catch {
    return [];
  }
}

function resolveMountedGithubToken(env = process.env) {
  return normalizeCopilotCliToken(
    String(env?.COPILOT_GITHUB_TOKEN ?? env?.GH_TOKEN ?? env?.GITHUB_TOKEN ?? "").trim()
  );
}

function resolveCopilotApiAuthFromEnv(env = process.env) {
  const token = normalizeCopilotCliToken(String(env?.GITHUB_COPILOT_API_TOKEN ?? "").trim());
  if (!token) return null;

  return {
    token,
    baseUrl: normalizeCopilotApiUrl(env?.COPILOT_API_URL ?? env?.OPENCLAW_COPILOT_RUNTIME_BASE_URL),
  };
}

async function resolveCopilotDiscoveryAuth(env = process.env) {
  const directAuth = resolveCopilotApiAuthFromEnv(env);
  if (directAuth) return directAuth;

  const githubToken = resolveMountedGithubToken(env);
  if (!githubToken) return null;

  const resolved = await resolveCopilotRuntimeAuth({
    githubToken,
    env,
  });
  if (!resolved?.ok || !resolved?.token) return null;

  const token = normalizeCopilotCliToken(resolved.token);
  if (!token) return null;

  return {
    token,
    baseUrl: normalizeCopilotApiUrl(resolved.baseUrl),
  };
}

function extractLiveCopilotModelId(model) {
  if (typeof model === "string") return normalizeCopilotModelId(model);
  if (!model || typeof model !== "object") return "";
  if (!isSelectableModel(model)) return "";
  return normalizeCopilotModelId(model?.id);
}

function normalizeLiveCopilotModelIds(models = []) {
  return uniqueStrings(
    (Array.isArray(models) ? models : [])
      .map((model) => extractLiveCopilotModelId(model))
      .filter(Boolean)
  );
}

async function withTemporaryEnv(overrides = {}, callback) {
  const previousValues = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined,
    );
    if (value == null || value === "") {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
  }
}

function createSilentRunnerLogger() {
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function resolveCopilotSdkAuthInfo() {
  return {
    type: "copilot-api-token",
    host: COPILOT_HOST,
  };
}

async function discoverSdkCopilotModelIds(sdkPaths = [], auth = null) {
  if (!auth?.token) return [];

  const authInfo = resolveCopilotSdkAuthInfo();
  const copilotApiUrl = normalizeCopilotApiUrl(auth.baseUrl);
  for (const candidatePath of uniqueStrings(sdkPaths)) {
    const normalizedPath = String(candidatePath ?? "").trim();
    if (!normalizedPath) continue;

    try {
      const sdkModule = await import(pathToFileURL(normalizedPath).href);
      const retrieveAvailableModels = typeof sdkModule?.retrieveAvailableModels === "function"
        ? sdkModule.retrieveAvailableModels
        : null;
      const getAvailableModels = typeof sdkModule?.getAvailableModels === "function"
        ? sdkModule.getAvailableModels
        : null;
      if (!retrieveAvailableModels && !getAvailableModels) continue;

      const liveModels = await withTemporaryEnv({
        GITHUB_COPILOT_API_TOKEN: auth.token,
        COPILOT_API_URL: copilotApiUrl,
      }, async () => {
        if (typeof sdkModule?.clearCachedModels === "function") {
          sdkModule.clearCachedModels();
        }

        if (retrieveAvailableModels) {
          const result = await retrieveAvailableModels(
            authInfo,
            copilotApiUrl,
            COPILOT_INTEGRATION_ID,
            `${COPILOT_SESSION_ID_PREFIX}-${process.pid}`,
            createSilentRunnerLogger(),
          );
          return normalizeLiveCopilotModelIds(result?.models);
        }

        return normalizeLiveCopilotModelIds(await getAvailableModels(authInfo));
      });
      if (liveModels.length > 0) return liveModels;
    } catch {
      continue;
    }
  }

  return [];
}

async function discoverDirectCopilotModelIds(auth = null, env = process.env) {
  if (!auth?.token || typeof fetch !== "function") return [];

  const timeoutMs = parseIntegerEnv(
    env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_DIRECT_TIMEOUT_MS,
    DEFAULT_DIRECT_DISCOVERY_TIMEOUT_MS,
  );
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  timeout?.unref?.();

  try {
    const response = await fetch(`${normalizeCopilotApiUrl(auth.baseUrl)}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) return [];

    const payload = await response.json();
    const liveModels = Array.isArray(payload?.data)
      ? payload.data
      : (Array.isArray(payload?.models) ? payload.models : []);
    return normalizeLiveCopilotModelIds(liveModels);
  } catch {
    return [];
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveDiscoveryCachePath(cacheKey, env = process.env) {
  const cacheDir = String(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_CACHE_DIR ?? "").trim()
    || path.join(os.tmpdir(), "openclaw-copilot-model-discovery");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    return "";
  }
  return path.join(cacheDir, `${cacheKey}.json`);
}

function readCachedDiscovery(cacheKey, ttlMs, env = process.env) {
  if (parseBooleanEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_CACHE, false)) return null;

  const cachePath = resolveDiscoveryCachePath(cacheKey, env);
  if (!cachePath || !fs.existsSync(cachePath)) return null;

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const createdAt = Number(cached?.createdAt ?? 0);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > ttlMs) return null;
    const models = Array.isArray(cached?.models) ? cached.models : [];
    return filterSupportedCopilotModelIds(models);
  } catch {
    return null;
  }
}

function writeCachedDiscovery(cacheKey, models, env = process.env) {
  if (parseBooleanEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_CACHE, false)) return;

  const cachePath = resolveDiscoveryCachePath(cacheKey, env);
  if (!cachePath) return;

  try {
    fs.writeFileSync(cachePath, JSON.stringify({
      createdAt: Date.now(),
      models: uniqueStrings(models),
    }));
  } catch {
    // ignore cache write failures
  }
}

function buildDiscoveryCacheKey({ command, commandArgs, sdkPaths, candidates, env = process.env } = {}) {
  const configPath = resolveCopilotConfigPath(env);
  const tokenFingerprint = normalizeCopilotCliToken(
    env?.GITHUB_COPILOT_API_TOKEN?.trim(),
  ) || resolveMountedGithubToken(env) || "";
  const maxResults = parseIntegerEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_MAX_RESULTS, 0);
  const payload = JSON.stringify({
    command,
    commandArgs,
    sdkPaths: sdkPaths.map((candidatePath) => fileSignature(candidatePath)),
    configPath: fileSignature(configPath),
    candidates: uniqueStrings(candidates),
    maxResults,
    copilotApiUrl: normalizeCopilotApiUrl(env?.COPILOT_API_URL ?? env?.OPENCLAW_COPILOT_RUNTIME_BASE_URL),
    tokenHash: tokenFingerprint ? createHash("sha1").update(tokenFingerprint).digest("hex") : "",
  });
  return createHash("sha1").update(payload).digest("hex");
}

function runCommand(command, args = [], { env = process.env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout = "", stderr = "") => {
      resolve({
        ok: !error,
        error,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

function isCommandMissing(result) {
  const combined = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}\n${result?.error?.message ?? ""}`.trim();
  return /ENOENT|not found|is not recognized/i.test(combined);
}

async function isCopilotCliAvailable(command, commandArgs, env = process.env) {
  const result = await runCommand(command, [...commandArgs, "--help"], { env, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
  return !isCommandMissing(result);
}

async function probeCopilotModel(modelId, { command, commandArgs, env = process.env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const prompt = String(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_PROBE_PROMPT ?? DEFAULT_PROBE_PROMPT).trim() || DEFAULT_PROBE_PROMPT;
  const result = await runCommand(command, [
    ...commandArgs,
    "-p",
    prompt,
    "--allow-all",
    "--model",
    modelId,
    "-s",
  ], { env, timeoutMs });

  return result.ok;
}

async function discoverRunnableCopilotModelIds({ sdkPaths = [], candidates = [], env = process.env } = {}) {
  const command = resolveCopilotCliCommand(env);
  if (!command) return null;

  const commandArgs = resolveCopilotCliArgs(env);
  if (!(await isCopilotCliAvailable(command, commandArgs, env))) return null;

  const maxResults = parseIntegerEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_MAX_RESULTS, 0);
  const preferDefaultOnly = parseBooleanEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_DEFAULT_ONLY, false);
  const supportedCandidates = filterSupportedCopilotModelIds(candidates);
  const filteredCandidates = preferDefaultOnly
    ? supportedCandidates
    : sortedUniqueModelIds(supportedCandidates);
  if (filteredCandidates.length === 0) return [];
  const ttlMs = parseIntegerEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  const cacheKey = buildDiscoveryCacheKey({ command, commandArgs, sdkPaths, candidates: filteredCandidates, env });
  const cached = readCachedDiscovery(cacheKey, ttlMs, env);
  if (cached) return maxResults > 0 ? cached.slice(0, maxResults) : cached;
  if (parseBooleanEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES, false)) {
    return maxResults > 0 ? filteredCandidates.slice(0, maxResults) : filteredCandidates;
  }

  const availableModels = [];
  const targetResultCount = maxResults > 0 ? maxResults : filteredCandidates.length;
  const concurrency = Math.max(
    1,
    Math.min(
      parseIntegerEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_PROBE_CONCURRENCY, DEFAULT_PROBE_CONCURRENCY),
      targetResultCount,
      filteredCandidates.length,
    ),
  );
  const timeoutMs = parseIntegerEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
  let currentIndex = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (availableModels.length >= targetResultCount) return;
      const candidateIndex = currentIndex;
      currentIndex += 1;
      const modelId = filteredCandidates[candidateIndex];
      if (!modelId) return;
      if (await probeCopilotModel(modelId, { command, commandArgs, env, timeoutMs })) {
        availableModels.push(modelId);
      }
    }
  });

  await Promise.all(workers);
  const uniqueModels = uniqueStrings(availableModels).slice(0, targetResultCount);
  writeCachedDiscovery(cacheKey, uniqueModels, env);
  return uniqueModels;
}

async function main() {
  const explicitSdkPath = String(process.argv[2] ?? "").trim();
  const sdkPaths = candidateSdkPaths(explicitSdkPath, process.env);
  const configuredModels = discoverConfiguredModelIds(process.env);
  const cliModels = await discoverCopilotCliListedModelIds({ env: process.env });
  const auth = cliModels.length > 0 ? null : await resolveCopilotDiscoveryAuth(process.env);
  const sdkModels = cliModels.length > 0 ? [] : await discoverSdkCopilotModelIds(sdkPaths, auth);
  const directModels = cliModels.length > 0 || sdkModels.length > 0 ? [] : await discoverDirectCopilotModelIds(auth, process.env);
  const liveModels = cliModels.length > 0 ? cliModels : (sdkModels.length > 0 ? sdkModels : directModels);
  const maxResults = parseIntegerEnv(process.env.OPENCLAW_MODEL_DISCOVERY_COPILOT_MAX_RESULTS, 0);
  const disableProbes = parseBooleanEnv(process.env.OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES, false);

  if (liveModels.length > 0) {
    const outputModels = maxResults > 0 ? liveModels.slice(0, maxResults) : liveModels;
    process.stdout.write(`${JSON.stringify(outputModels)}\n`);
    return;
  }

  if (disableProbes) {
    process.stdout.write(`${JSON.stringify([])}\n`);
    return;
  }

  const runnableModels = await discoverRunnableCopilotModelIds({
    sdkPaths,
    candidates: configuredModels,
    env: process.env,
  });
  if (Array.isArray(runnableModels)) {
    process.stdout.write(`${JSON.stringify(runnableModels)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify([])}\n`);
}

await main();
