import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_DISCOVERY_NPM_ROOT_ENV = "OPENCLAW_MODEL_DISCOVERY_NPM_ROOT";
export const CODEX_MODELS_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_CODEX_MODELS";
const CODEX_BINARY_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_CODEX_BINARY";
const CODEX_CLI_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_CODEX_CLI";
export const GEMINI_MODELS_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_GEMINI_MODELS";
const GEMINI_MODELS_JS_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_GEMINI_MODELS_JS";
const GEMINI_CLI_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_GEMINI_CLI";
export const COPILOT_MODELS_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS";
const COPILOT_SDK_OVERRIDE_ENV = "OPENCLAW_MODEL_DISCOVERY_COPILOT_SDK";
export const COPILOT_MODEL_DISCOVERY_SCRIPT = fileURLToPath(new URL("../copilot-model-discovery.mjs", import.meta.url));

export function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

export function matchesSupportedModelPrefix(modelId = "", supportedPrefixes = []) {
  const normalizedModelId = String(modelId ?? "").trim().toLowerCase();
  if (!normalizedModelId) return false;
  return supportedPrefixes.some((prefix) => {
    const normalizedPrefix = String(prefix ?? "").trim().toLowerCase();
    return normalizedPrefix && (
      normalizedModelId === normalizedPrefix
      || normalizedModelId.startsWith(normalizedPrefix)
    );
  });
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

function versionSegments(modelId) {
  return [...String(modelId ?? "").toLowerCase().matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
}

function capabilityRank(modelId) {
  const normalized = String(modelId ?? "").toLowerCase();
  if (normalized.includes("customtools")) return -20;
  if (normalized.includes("pro")) return 50;
  if (normalized.includes("max")) return 45;
  if (normalized.includes("flash-lite")) return 20;
  if (normalized.includes("flash")) return 30;
  if (normalized.includes("mini")) return 10;
  return 40;
}

function previewRank(modelId) {
  return String(modelId ?? "").toLowerCase().includes("preview") ? 1 : 0;
}

function compareDiscoveredModelIds(left, right) {
  const versionCompare = compareNumberArraysDesc(versionSegments(left), versionSegments(right));
  if (versionCompare !== 0) return versionCompare;

  const capabilityCompare = capabilityRank(right) - capabilityRank(left);
  if (capabilityCompare !== 0) return capabilityCompare;

  const previewCompare = previewRank(right) - previewRank(left);
  if (previewCompare !== 0) return previewCompare;

  return String(left ?? "").localeCompare(String(right ?? ""));
}

export function sortedUniqueModelIds(values = []) {
  return uniqueStrings(values).sort(compareDiscoveredModelIds);
}

export function readTextFilesIfExist(candidatePaths = []) {
  const results = [];
  for (const candidatePath of uniqueStrings(candidatePaths)) {
    try {
      if (!fs.existsSync(candidatePath)) continue;
      if (!fs.statSync(candidatePath).isFile()) continue;
      results.push(fs.readFileSync(candidatePath, "utf8"));
    } catch {
      continue;
    }
  }
  return results;
}

export function readBufferIfExists(candidatePaths = []) {
  for (const candidatePath of uniqueStrings(candidatePaths)) {
    try {
      if (!fs.existsSync(candidatePath)) continue;
      return fs.readFileSync(candidatePath);
    } catch {
      continue;
    }
  }
  return null;
}

export function readDiscoveryOverride(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return [];

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry?.id ?? entry?.name ?? entry?.model ?? entry?.key ?? entry ?? "").trim()).filter(Boolean);
    }
  } catch {
    // fall through to line-based parsing
  }

  return normalized.split(/[\r\n,]+/g).map((entry) => entry.trim()).filter(Boolean);
}

export function runDiscoveryCommand(command, args = [], env = process.env) {
  const binary = String(command ?? "").trim();
  if (!binary) return "";
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...env },
    }).trim();
  } catch {
    return "";
  }
}

function globalNpmRoot(env = process.env) {
  const override = String(env?.[MODEL_DISCOVERY_NPM_ROOT_ENV] ?? "").trim();
  if (override) return override;

  try {
    const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
    return execFileSync(npmExecutable, ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function codexBinaryCandidates(env = process.env) {
  const CODEX_TARGET_BY_PLATFORM = Object.freeze({
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "android:x64": "x86_64-unknown-linux-musl",
    "android:arm64": "aarch64-unknown-linux-musl",
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  });

  const override = String(env?.[CODEX_BINARY_OVERRIDE_ENV] ?? "").trim();
  const npmRoot = globalNpmRoot(env);
  const target = CODEX_TARGET_BY_PLATFORM[`${process.platform}:${process.arch}`] ?? "";
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const basePackagePath = npmRoot ? path.join(npmRoot, "@openai", "codex") : "";
  const optionalPackageName = target ? `@openai/codex-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}` : "";

  return uniqueStrings([
    override,
    target && basePackagePath
      ? path.join(basePackagePath, "node_modules", optionalPackageName, "vendor", target, "codex", binaryName)
      : "",
    target && basePackagePath
      ? path.join(basePackagePath, "vendor", target, "codex", binaryName)
      : "",
  ]);
}

export function codexCliCandidates(env = process.env) {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  return uniqueStrings([
    env?.[CODEX_CLI_OVERRIDE_ENV],
    binaryName,
  ]);
}

function isDirectory(candidatePath = "") {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function geminiPackageRootCandidates(env = process.env) {
  const override = String(env?.[GEMINI_MODELS_JS_OVERRIDE_ENV] ?? "").trim();
  const npmRoot = globalNpmRoot(env);

  return uniqueStrings([
    isDirectory(override) ? override : "",
    npmRoot
      ? path.join(npmRoot, "@google", "gemini-cli")
      : "",
    npmRoot
      ? path.join(npmRoot, "@google", "gemini-cli", "node_modules", "@google", "gemini-cli-core")
      : "",
    npmRoot
      ? path.join(npmRoot, "@google", "gemini-cli-core")
      : "",
  ]);
}

function geminiBundleCandidateRank(fileName = "") {
  const normalized = String(fileName ?? "").trim().toLowerCase();
  if (normalized.startsWith("chunk-")) return 0;
  if (normalized.startsWith("core-")) return 1;
  if (normalized.startsWith("dist-")) return 2;
  if (normalized === "gemini.js") return 3;
  return 10;
}

function geminiBundleJsCandidates(bundleDirectoryPath = "") {
  try {
    return fs.readdirSync(bundleDirectoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (
        /^chunk-.*\.js$/i.test(entry.name)
        || /^core-.*\.js$/i.test(entry.name)
        || /^dist-.*\.js$/i.test(entry.name)
        || /^gemini\.js$/i.test(entry.name)
      ))
      .sort((left, right) => (
        geminiBundleCandidateRank(left.name)
        - geminiBundleCandidateRank(right.name)
      ) || left.name.localeCompare(right.name))
      .map((entry) => path.join(bundleDirectoryPath, entry.name));
  } catch {
    return [];
  }
}

export function geminiModelsJsCandidates(env = process.env) {
  const override = String(env?.[GEMINI_MODELS_JS_OVERRIDE_ENV] ?? "").trim();
  const packageRoots = geminiPackageRootCandidates(env);

  return uniqueStrings([
    override,
    ...packageRoots.map((root) => path.join(root, "dist", "src", "config", "models.js")),
    ...packageRoots.flatMap((root) => geminiBundleJsCandidates(path.join(root, "bundle"))),
  ]);
}

export function geminiCliCandidates(env = process.env) {
  const binaryName = process.platform === "win32" ? "gemini.cmd" : "gemini";
  return uniqueStrings([
    env?.[GEMINI_CLI_OVERRIDE_ENV],
    binaryName,
  ]);
}

export function copilotSdkCandidates(env = process.env) {
  const override = String(env?.[COPILOT_SDK_OVERRIDE_ENV] ?? "").trim();
  const npmRoot = globalNpmRoot(env);

  return uniqueStrings([
    override,
    npmRoot
      ? path.join(npmRoot, "@github", "copilot", "copilot-sdk", "index.js")
      : "",
  ]);
}
