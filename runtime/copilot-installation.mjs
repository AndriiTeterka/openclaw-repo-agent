import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeCopilotCliToken } from "./copilot-auth-token.mjs";
import { filterSupportedCopilotModelIds, normalizeCopilotModelId } from "./adapters/copilot-model-id-utils.mjs";
import { uniqueStrings } from "./adapters/model-discovery-shared.mjs";

const COPILOT_CLIENT_SDK_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_COPILOT_CLIENT_SDK";
const DEFAULT_COPILOT_CLIENT_TIMEOUT_MS = 15_000;
const DEFAULT_COPILOT_COMMAND = process.platform === "win32" ? "copilot.exe" : "copilot";

function parseIntegerEnv(value, fallback) {
  const numeric = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function readJsonArrayEnv(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function compareNumberArraysDesc(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? -1;
    const rightValue = right[index] ?? -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

function versionSegments(value) {
  return [...String(value ?? "").matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
}

function comparePackageVersionsDesc(left, right) {
  return compareNumberArraysDesc(versionSegments(left), versionSegments(right))
    || String(right ?? "").localeCompare(String(left ?? ""));
}

function selectPathModule(filePath) {
  const normalized = String(filePath ?? "").trim();
  return /^[A-Za-z]:[\\/]/.test(normalized) || normalized.includes("\\")
    ? path.win32
    : path.posix;
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

function normalizeCliListedModelIds(models = []) {
  return uniqueStrings(
    (Array.isArray(models) ? models : [])
      .map((model) => {
        if (typeof model === "string") return normalizeCopilotModelId(model);
        if (!model || typeof model !== "object") return "";
        if (!isSelectableModel(model)) return "";
        return normalizeCopilotModelId(model.id);
      })
      .filter(Boolean)
  );
}

export function resolveUserHomeDir(env = process.env) {
  const configuredHome = String(
    env?.HOME
    ?? env?.USERPROFILE
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? ""
  ).trim();
  if (configuredHome) return configuredHome;

  try {
    return String(os.homedir?.() ?? "").trim();
  } catch {
    return "";
  }
}

export function resolveCopilotHome(env = process.env) {
  const override = String(env?.COPILOT_HOME ?? "").trim();
  if (override) return override;

  const homeDir = resolveUserHomeDir(env);
  return homeDir ? path.join(homeDir, ".copilot") : "";
}

export function resolveCopilotConfigPath(env = process.env) {
  const copilotHome = resolveCopilotHome(env);
  return copilotHome ? path.join(copilotHome, "config.json") : "";
}

export function resolveCopilotCliCommand(env = process.env) {
  return String(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI ?? "").trim()
    || DEFAULT_COPILOT_COMMAND;
}

export function resolveCopilotCliArgs(env = process.env) {
  return readJsonArrayEnv(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_CLI_ARGS);
}

function collectCopilotPackagePaths(bundleRelativePath, env = process.env) {
  const copilotHome = resolveCopilotHome(env);
  if (!copilotHome) return [];

  const universalRoot = path.join(copilotHome, "pkg", "universal");
  try {
    return fs.readdirSync(universalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => comparePackageVersionsDesc(left.name, right.name))
      .map((entry) => path.join(universalRoot, entry.name, bundleRelativePath))
      .filter((candidatePath) => fs.existsSync(candidatePath));
  } catch {
    return [];
  }
}

export function defaultGlobalCopilotSdkCandidatePaths(nodeExecPath = process.execPath) {
  const normalizedExecPath = String(nodeExecPath ?? "").trim();
  const pathImpl = selectPathModule(normalizedExecPath);
  const execDir = normalizedExecPath ? pathImpl.dirname(normalizedExecPath) : "";
  const prefixDir = execDir ? pathImpl.resolve(execDir, "..") : "";

  return uniqueStrings([
    prefixDir ? pathImpl.join(prefixDir, "lib", "node_modules", "@github", "copilot", "copilot-sdk", "index.js") : "",
    prefixDir ? pathImpl.join(prefixDir, "lib", "node_modules", "copilot-sdk", "index.js") : "",
    "/usr/local/lib/node_modules/@github/copilot/copilot-sdk/index.js",
    "/usr/local/lib/node_modules/copilot-sdk/index.js",
  ]).filter(Boolean);
}

export function globalCopilotSdkCandidates(nodeExecPath = process.execPath) {
  return defaultGlobalCopilotSdkCandidatePaths(nodeExecPath)
    .filter((candidatePath) => fs.existsSync(candidatePath));
}

export function copilotClientSdkCandidates(env = process.env) {
  const explicitClientSdk = String(env?.[COPILOT_CLIENT_SDK_OVERRIDE_ENV] ?? "").trim();
  const explicitGeneralSdk = String(env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_SDK ?? "").trim();
  const siblingClientSdk = explicitGeneralSdk
    ? path.join(path.dirname(path.dirname(explicitGeneralSdk)), "copilot-sdk", "index.js")
    : "";

  return uniqueStrings([
    explicitClientSdk,
    siblingClientSdk,
    ...globalCopilotSdkCandidates(),
    ...collectCopilotPackagePaths(path.join("copilot-sdk", "index.js"), env),
  ]).filter((candidatePath) => fs.existsSync(candidatePath));
}

function resolveExecutablePath(command) {
  const normalized = String(command ?? "").trim();
  if (!normalized) return "";

  if (
    path.isAbsolute(normalized)
    || normalized.includes("/")
    || normalized.includes("\\")
  ) {
    return fs.existsSync(normalized) ? normalized : "";
  }

  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const output = execFileSync(locator, [normalized], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return output.split(/\r?\n/g).map((line) => line.trim()).find(Boolean) ?? "";
  } catch {
    return "";
  }
}

export function resolveCopilotCliPath(env = process.env) {
  return resolveExecutablePath(resolveCopilotCliCommand(env));
}

async function stopCopilotClient(client) {
  if (!client) return;

  try {
    await client.stop?.();
  } catch {
    try {
      await client.forceStop?.();
    } catch {
      // ignore cleanup failures during model discovery fallback
    }
  }
}

export async function discoverCopilotCliListedModelIds({ env = process.env } = {}) {
  const cliPath = resolveCopilotCliPath(env);
  if (!cliPath) return [];

  const clientSdkPaths = copilotClientSdkCandidates(env);
  if (clientSdkPaths.length === 0) return [];

  const timeoutMs = parseIntegerEnv(
    env?.OPENCLAW_MODEL_DISCOVERY_COPILOT_CLIENT_TIMEOUT_MS,
    DEFAULT_COPILOT_CLIENT_TIMEOUT_MS,
  );
  const githubToken = normalizeCopilotCliToken(
    String(env?.COPILOT_GITHUB_TOKEN ?? env?.GH_TOKEN ?? env?.GITHUB_TOKEN ?? "").trim()
  );
  const copilotHome = resolveCopilotHome(env);
  const discoveryEnv = {
    ...process.env,
    ...env,
    ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
  };
  if (!discoveryEnv.HOME) {
    const userHome = resolveUserHomeDir(env);
    if (userHome) discoveryEnv.HOME = userHome;
  }
  const cliArgs = resolveCopilotCliArgs(env);

  for (const clientSdkPath of clientSdkPaths) {
    const normalizedPath = String(clientSdkPath ?? "").trim();
    if (!normalizedPath) continue;

    let client = null;
    let timer = null;
    try {
      const clientSdk = await import(pathToFileURL(normalizedPath).href);
      const CopilotClient = clientSdk?.CopilotClient;
      if (typeof CopilotClient !== "function") continue;

      client = new CopilotClient({
        cliPath,
        ...(cliArgs.length > 0 ? { cliArgs } : {}),
        cwd: process.cwd(),
        env: discoveryEnv,
        logLevel: "error",
        ...(githubToken
          ? { githubToken, useLoggedInUser: false }
          : { useLoggedInUser: true }),
      });

      const models = await Promise.race([
        (async () => {
          await client.start();
          return await client.listModels();
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out listing Copilot CLI models.")), timeoutMs);
          timer?.unref?.();
        }),
      ]);
      const modelIds = filterSupportedCopilotModelIds(normalizeCliListedModelIds(models));
      if (modelIds.length > 0) return modelIds;
    } catch {
      // fall through to the next discovery strategy
    } finally {
      if (timer) clearTimeout(timer);
      await stopCopilotClient(client);
    }
  }

  return [];
}
