import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureDir,
  fileExists,
  readJsonFile,
  writeJsonFileAtomic
} from "../../runtime/shared.mjs";

const INSTANCE_STATE_SCHEMA_VERSION = 1;

export function buildDefaultInstanceState(context, values = {}) {
  return {
    schemaVersion: INSTANCE_STATE_SCHEMA_VERSION,
    instanceId: context.instanceId,
    repoRoot: context.repoRoot,
    composeProjectName: context.composeProjectName,
    runtimeCore: {
      image: String(values.runtimeCore?.image ?? "").trim(),
      digest: String(values.runtimeCore?.digest ?? "").trim(),
      source: String(values.runtimeCore?.source ?? "").trim() || "unresolved"
    },
    toolingFingerprint: String(values.toolingFingerprint ?? "").trim(),
    lastMaterializedAt: String(values.lastMaterializedAt ?? "").trim()
  };
}

export async function readInstanceState(context) {
  const payload = await readJsonFile(context.paths.stateFile, null);
  if (!payload || typeof payload !== "object") {
    return buildDefaultInstanceState(context);
  }
  return buildDefaultInstanceState(context, payload);
}

export async function writeInstanceState(context, state) {
  await ensureDir(path.dirname(context.paths.stateFile));
  await writeJsonFileAtomic(context.paths.stateFile, buildDefaultInstanceState(context, state));
}

export async function withInstanceLock(lockFile, callback, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 100;
  const startedAt = Date.now();

  while (true) {
    try {
      await ensureDir(path.dirname(lockFile));
      const handle = await fs.open(lockFile, "wx");
      try {
        await handle.writeFile(String(process.pid));
        return await callback();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if ((Date.now() - startedAt) >= timeoutMs) {
        throw new Error(`Timed out waiting for instance lock ${lockFile}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

async function hashFile(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(contents).digest("hex");
}

export async function buildPathsPayload(context) {
  return {
    repoRoot: context.repoRoot,
    stateRoot: context.paths.stateRoot,
    mountRoot: context.paths.mountRoot,
    configFile: context.paths.configFile,
    instructionsFile: context.paths.instructionsFile,
    secretsEnvFile: context.paths.secretsEnvFile,
    runtimeEnvFile: context.paths.runtimeEnvFile,
    composeFile: context.paths.composeFile,
    eventLogFile: context.paths.eventLogFile,
    stateFile: context.paths.stateFile,
    runtimeDir: context.paths.runtimeDir,
    playwrightDir: context.paths.playwrightDir,
    toolingManifestFile: context.paths.toolingManifestFile,
    toolingContextDir: context.paths.toolingContextDir,
    providerHomes: {
      ...(context.paths.providerHomes ?? {})
    }
  };
}

export async function writePathsManifest(context) {
  const payload = await buildPathsPayload(context);
  await writeJsonFileAtomic(context.paths.pathsManifestFile, payload);
  return payload;
}

export async function fileDigestIfExists(filePath) {
  if (!(await fileExists(filePath))) return "";
  return await hashFile(filePath);
}
