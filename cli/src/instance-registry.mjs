import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFileAtomic } from "../../runtime/shared.mjs";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./builtin-profiles.mjs";

export const INSTANCE_REGISTRY_VERSION = 1;
export const LEGACY_COMPOSE_PORT = 18789;
export const LEGACY_LOCAL_RUNTIME_IMAGE = "openclaw-repo-agent-runtime:local";
export const GATEWAY_PORT_RANGE_START = 20000;
export const GATEWAY_PORT_RANGE_END = 39999;
const MAX_REPO_SLUG_LENGTH = 45;
const INSTANCE_HASH_LENGTH = 8;

function toPortablePath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

function normalizeIdentityPath(value) {
  const portable = toPortablePath(value).replace(/\/+$/g, "");
  if (/^[a-z]:\//i.test(portable)) return portable.toLowerCase();
  return portable || "/";
}

export function sanitizeRepoSlug(value) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "openclaw").slice(0, MAX_REPO_SLUG_LENGTH);
}

export function deriveLegacyComposeProjectName(repoRoot) {
  const normalizedRoot = toPortablePath(repoRoot).replace(/\/+$/g, "");
  const basename = path.posix.basename(normalizedRoot) || path.basename(path.resolve(repoRoot));
  const slug = sanitizeRepoSlug(basename);
  return /^[a-z0-9]/.test(slug) ? slug : `repo-${slug}`.slice(0, 63);
}

export function resolveRepoIdentityPath(repoRoot) {
  const resolved = path.resolve(repoRoot);
  try {
    return normalizeIdentityPath(fs.realpathSync.native(resolved));
  } catch {
    return normalizeIdentityPath(resolved);
  }
}

export function deriveInstanceId(repoRoot) {
  const identityPath = resolveRepoIdentityPath(repoRoot);
  const repoSlug = sanitizeRepoSlug(path.basename(identityPath) || "openclaw");
  const repoHash = crypto.createHash("sha256").update(identityPath).digest("hex").slice(0, INSTANCE_HASH_LENGTH);
  return `${repoSlug}-${repoHash}`;
}

export function deriveComposeProjectName(repoRootOrInstanceId) {
  const raw = String(repoRootOrInstanceId ?? "").trim();
  const instanceId = raw.includes(path.sep) || raw.includes("/") || /^[a-z]:/i.test(raw)
    ? deriveInstanceId(raw)
    : raw;
  return `openclaw-${instanceId}`.slice(0, 63);
}

export function deriveDockerMcpProfileName(instanceId) {
  return `openclaw-${String(instanceId ?? "").trim()}`.slice(0, 63);
}

export function deriveLocalRuntimeImage(instanceId, productVersion = PRODUCT_VERSION) {
  return `openclaw-repo-agent-runtime:${productVersion}-${String(instanceId ?? "").trim()}`;
}

export function hashInstanceValue(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function fingerprintTelegramBotToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.startsWith("replace-with-")) return "";
  return hashInstanceValue(normalized);
}

export function shouldManageGatewayPort(localEnv = {}) {
  const explicit = String(localEnv.OPENCLAW_PORT_MANAGED ?? "").trim();
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit.toLowerCase());
  const currentPort = String(localEnv.OPENCLAW_GATEWAY_PORT ?? "").trim();
  return !currentPort || currentPort === String(LEGACY_COMPOSE_PORT);
}

export function resolveInstanceRegistryPath(env = process.env) {
  const overrideRoot = String(env.OPENCLAW_REPO_AGENT_STATE_HOME ?? "").trim();
  if (overrideRoot) return path.join(path.resolve(overrideRoot), PRODUCT_NAME, "instances.json");

  if (process.platform === "win32") {
    const localAppData = String(env.LOCALAPPDATA ?? "").trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, PRODUCT_NAME, "instances.json");
  }

  const xdgStateHome = String(env.XDG_STATE_HOME ?? "").trim();
  const stateRoot = xdgStateHome ? path.resolve(xdgStateHome) : path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, PRODUCT_NAME, "instances.json");
}

export async function readInstanceRegistry(registryPath = resolveInstanceRegistryPath()) {
  const payload = await readJsonFile(registryPath, {
    version: INSTANCE_REGISTRY_VERSION,
    instances: {}
  });

  if (!payload || typeof payload !== "object") {
    return {
      version: INSTANCE_REGISTRY_VERSION,
      instances: {}
    };
  }

  const instances = payload.instances && typeof payload.instances === "object" ? payload.instances : {};
  return {
    version: INSTANCE_REGISTRY_VERSION,
    instances
  };
}

export async function writeInstanceRegistry(registryPath, registry) {
  await ensureDir(path.dirname(registryPath));
  await writeJsonFileAtomic(registryPath, {
    version: INSTANCE_REGISTRY_VERSION,
    instances: registry?.instances ?? {}
  });
}

export function listInstanceRegistryEntries(registry = {}) {
  return Object.values(registry.instances ?? {}).sort((left, right) => {
    const leftPath = String(left?.repoRoot ?? "");
    const rightPath = String(right?.repoRoot ?? "");
    return leftPath.localeCompare(rightPath);
  });
}

async function defaultPortAvailabilityCheck(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({
      host: "127.0.0.1",
      port,
      exclusive: true
    }, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return true;
}

export async function allocateGatewayPort({
  instanceId,
  registryEntries = [],
  excludeInstanceId = "",
  isPortAvailable = defaultPortAvailabilityCheck
}) {
  const usedPorts = new Set(
    registryEntries
      .filter((entry) => String(entry?.instanceId ?? "") !== String(excludeInstanceId ?? ""))
      .map((entry) => Number.parseInt(entry?.gatewayPort, 10))
      .filter((value) => Number.isInteger(value) && value >= GATEWAY_PORT_RANGE_START && value <= GATEWAY_PORT_RANGE_END)
  );

  const span = GATEWAY_PORT_RANGE_END - GATEWAY_PORT_RANGE_START + 1;
  const hash = Number.parseInt(hashInstanceValue(instanceId).slice(0, 8), 16) >>> 0;
  const startOffset = hash % span;

  for (let offset = 0; offset < span; offset += 1) {
    const candidate = GATEWAY_PORT_RANGE_START + ((startOffset + offset) % span);
    if (usedPorts.has(candidate)) continue;
    try {
      await isPortAvailable(candidate);
      return candidate;
    } catch {}
  }

  throw new Error(`No free gateway port is available in ${GATEWAY_PORT_RANGE_START}-${GATEWAY_PORT_RANGE_END}.`);
}

export function buildInstanceMetadata(repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const identityPath = resolveRepoIdentityPath(repoRoot);
  const repoSlug = sanitizeRepoSlug(path.basename(identityPath) || path.basename(resolvedRepoRoot));
  const instanceId = deriveInstanceId(repoRoot);
  return {
    repoRoot: resolvedRepoRoot,
    repoSlug,
    instanceId,
    composeProjectName: deriveComposeProjectName(instanceId),
    legacyComposeProjectName: deriveLegacyComposeProjectName(repoRoot),
    dockerMcpProfile: deriveDockerMcpProfileName(instanceId),
    localRuntimeImage: deriveLocalRuntimeImage(instanceId)
  };
}

export function buildRegistryEntry(context, localEnv = {}) {
  return {
    instanceId: context.instanceId,
    repoRoot: context.repoRoot,
    repoSlug: context.repoSlug,
    composeProjectName: context.composeProjectName,
    gatewayPort: String(localEnv.OPENCLAW_GATEWAY_PORT ?? ""),
    gatewayToken: String(localEnv.OPENCLAW_GATEWAY_TOKEN ?? ""),
    portManaged: shouldManageGatewayPort(localEnv),
    telegramTokenHash: fingerprintTelegramBotToken(localEnv.TELEGRAM_BOT_TOKEN),
    localRuntimeImage: context.localRuntimeImage,
    dockerMcpProfile: context.dockerMcpProfile,
    lastSeenAt: new Date().toISOString()
  };
}

export async function upsertInstanceRegistryEntry(registryPath, entry) {
  const registry = await readInstanceRegistry(registryPath);
  registry.instances[entry.instanceId] = entry;
  await writeInstanceRegistry(registryPath, registry);
  return registry;
}
