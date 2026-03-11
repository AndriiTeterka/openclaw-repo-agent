import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function isPlainObject(value) {
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

export async function runCommand(command, args, options = {}) {
  const { cwd, env, input } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (input != null && input !== "") child.stdin.end(input);
    else child.stdin.end();
  });
}
