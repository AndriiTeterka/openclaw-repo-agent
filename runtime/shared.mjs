import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath, fallback) {
  if (!(await fileExists(filePath))) return fallback;

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to read JSON from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeJsonFileAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function readTextFile(filePath, fallback = "") {
  if (!(await fileExists(filePath))) return fallback;
  return await fs.readFile(filePath, "utf8");
}

export async function writeTextFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, String(value), "utf8");
}

export function resolveBoolean(rawValue, fallback) {
  if (rawValue == null || rawValue === "") return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function resolveInteger(rawValue, fallback) {
  if (rawValue == null || rawValue === "") return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function parseStringArrayEnv(rawValue, fallback = []) {
  if (!rawValue) return fallback;

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) throw new Error("expected JSON array");
    return parsed.map((entry) => String(entry));
  } catch (error) {
    throw new Error(`Invalid JSON array value "${rawValue}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function uniqueStrings(values) {
  return [...new Set(values.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function normalizeIdentityPath(value) {
  const portable = String(value ?? "").replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!portable) return "";
  if (/^[a-z]:\//i.test(portable)) return portable.toLowerCase();
  return portable;
}

export function deriveProjectRootName(repoPath, fallback = "workspace") {
  const normalizedRepoPath = String(repoPath ?? "").trim();
  if (!normalizedRepoPath) return String(fallback ?? "").trim() || "workspace";
  const normalized = normalizeIdentityPath(path.resolve(normalizedRepoPath));
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || String(fallback ?? "").trim() || "workspace";
}

function deriveStableProjectId(repoPath, fallback = "workspace") {
  const normalizedRepoPath = String(repoPath ?? "").trim();
  const seed = normalizedRepoPath
    ? normalizeIdentityPath(path.resolve(normalizedRepoPath))
    : String(fallback ?? "").trim();
  return crypto.createHash("sha256").update(seed || "workspace").digest("hex").slice(0, 8);
}

export function deriveDefaultAgentName(projectName, repoPath) {
  const resolvedProjectName = String(projectName ?? "").trim() || deriveProjectRootName(repoPath);
  return `${resolvedProjectName}-${deriveStableProjectId(repoPath, resolvedProjectName)}`;
}

function normalizeTelegramPrincipal(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "*" || /^tg:/i.test(raw) || /^telegram:/i.test(raw) || raw.startsWith("@")) return raw;
  if (/^-?\d+$/.test(raw)) return `tg:${raw}`;
  return raw;
}

export function normalizePrincipalArray(values) {
  return uniqueStrings(values.map((value) => normalizeTelegramPrincipal(value)));
}

export function deepMerge(...values) {
  return values.reduce((accumulator, value) => mergeValue(accumulator, value), {});
}

function mergeValue(left, right) {
  if (!isPlainObject(right)) {
    if (Array.isArray(right)) return right.map((entry) => cloneValue(entry));
    return right;
  }

  const base = isPlainObject(left) ? { ...left } : {};
  for (const [key, value] of Object.entries(right)) {
    const current = base[key];
    if (isPlainObject(value)) {
      base[key] = mergeValue(current, value);
      continue;
    }
    if (Array.isArray(value)) {
      base[key] = value.map((entry) => cloneValue(entry));
      continue;
    }
    base[key] = value;
  }
  return base;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (isPlainObject(value)) return deepMerge(value);
  return value;
}

export function diffObjectPaths(left, right, prefix = "") {
  if (left === right) return [];

  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null) ? [] : [prefix || "$"];
  }

  if (!isPlainObject(left) || !isPlainObject(right)) {
    return [prefix || "$"];
  }

  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const paths = [];
  for (const key of keys) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const leftValue = left[key];
    const rightValue = right[key];
    if (isPlainObject(leftValue) && isPlainObject(rightValue)) {
      paths.push(...diffObjectPaths(leftValue, rightValue, nextPrefix));
      continue;
    }
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (JSON.stringify(leftValue ?? null) !== JSON.stringify(rightValue ?? null)) paths.push(nextPrefix);
      continue;
    }
    if (leftValue !== rightValue) paths.push(nextPrefix);
  }
  return paths;
}

export async function copyFileIfNewer(sourcePath, targetPath) {
  if (!(await fileExists(sourcePath))) return false;

  const sourceStat = await fs.stat(sourcePath);
  let targetStat = null;
  try {
    targetStat = await fs.stat(targetPath);
  } catch {}

  if (targetStat && sourceStat.mtimeMs <= targetStat.mtimeMs) return false;
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function runCommand(command, args, options = {}) {
  const { cwd, env, input, timeoutMs } = options;
  const useWindowsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command ?? "").trim());

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: useWindowsShell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let timeoutId = null;
    let forceKillId = null;

    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (forceKillId) clearTimeout(forceKillId);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (forceKillId) clearTimeout(forceKillId);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      const timeoutSuffix = timedOut
        ? `${stderrText ? "\n" : ""}Command timed out after ${timeoutMs}ms.`
        : "";
      resolve({
        code: timedOut ? 1 : (typeof code === "number" ? code : 1),
        stdout: stdoutText,
        stderr: `${stderrText}${timeoutSuffix}`,
      });
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {}
        forceKillId = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1000);
        forceKillId.unref?.();
      }, timeoutMs);
      timeoutId.unref?.();
    }

    if (input != null && input !== "") child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function safeRunCommand(command, args, options = {}) {
  try {
    return await runCommand(command, args, options);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
