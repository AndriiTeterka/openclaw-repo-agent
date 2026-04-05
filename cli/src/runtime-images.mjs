import crypto from "node:crypto";

import {
  DEFAULT_RUNTIME_CORE_IMAGE,
  PRODUCT_NAME,
} from "./product-metadata.mjs";

const TOOLING_IMAGE_SCHEMA_VERSION = 2;
const LOCAL_TOOLING_IMAGE_REPOSITORY = `${PRODUCT_NAME}-tooling`;
const LOCAL_RUNTIME_CORE_FALLBACK_REPOSITORY = `${PRODUCT_NAME}-runtime-core-fallback`;

function normalizeStringArray(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}

function stripTagFromImageRef(imageRef) {
  const withoutDigest = String(imageRef ?? "").trim().split("@", 1)[0];
  if (!withoutDigest) return "";
  const lastSlashIndex = withoutDigest.lastIndexOf("/");
  const lastColonIndex = withoutDigest.lastIndexOf(":");
  if (lastColonIndex > lastSlashIndex) return withoutDigest.slice(0, lastColonIndex);
  return withoutDigest;
}

function extractDigestFromRepoDigest(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.includes("@") ? normalized.split("@").slice(-1)[0].trim() : normalized;
}

export function resolveRuntimeCoreImageRef(value) {
  const normalized = String(value ?? "").trim();
  return normalized || DEFAULT_RUNTIME_CORE_IMAGE;
}

export function parseDockerImageInspectOutput(output) {
  try {
    const parsed = JSON.parse(String(output ?? ""));
    if (Array.isArray(parsed)) return parsed[0] ?? null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function extractRuntimeCoreDigest(imageInspect, imageRef = "") {
  const repoDigests = Array.isArray(imageInspect?.RepoDigests) ? imageInspect.RepoDigests : [];
  const repository = stripTagFromImageRef(imageRef);
  const matchingDigest = repository
    ? repoDigests.find((digest) => String(digest ?? "").startsWith(`${repository}@`))
    : "";
  const digest = extractDigestFromRepoDigest(matchingDigest || repoDigests[0] || "");
  if (digest) return digest;

  const imageId = String(imageInspect?.Id ?? "").trim();
  return /^sha256:/i.test(imageId) ? imageId : "";
}

export function deriveToolingImageTag({
  runtimeCoreImage = DEFAULT_RUNTIME_CORE_IMAGE,
  runtimeCoreDigest = "",
  runtimeOverlayDigest = "",
  toolingProfiles = [],
  toolingInstallCommand = "",
  agentInstallCommand = "",
  schemaVersion = TOOLING_IMAGE_SCHEMA_VERSION
} = {}) {
  const seed = JSON.stringify({
    schemaVersion,
    runtimeCoreImage: resolveRuntimeCoreImageRef(runtimeCoreImage),
    runtimeCoreDigest: String(runtimeCoreDigest ?? "").trim(),
    runtimeOverlayDigest: String(runtimeOverlayDigest ?? "").trim(),
    toolingProfiles: normalizeStringArray(toolingProfiles),
    toolingInstallCommand: String(toolingInstallCommand ?? "").trim(),
    agentInstallCommand: String(agentInstallCommand ?? "").trim()
  });
  const fingerprint = crypto.createHash("sha256").update(seed).digest("hex");
  return `${LOCAL_TOOLING_IMAGE_REPOSITORY}:v${schemaVersion}-${fingerprint.slice(0, 24)}`;
}

export function deriveFallbackRuntimeCoreImageTag({
  runtimeCoreImage = DEFAULT_RUNTIME_CORE_IMAGE,
  runtimeCoreDigest = "",
  schemaVersion = 1
} = {}) {
  const seed = JSON.stringify({
    schemaVersion,
    runtimeCoreImage: resolveRuntimeCoreImageRef(runtimeCoreImage),
    runtimeCoreDigest: String(runtimeCoreDigest ?? "").trim()
  });
  const fingerprint = crypto.createHash("sha256").update(seed).digest("hex");
  return `${LOCAL_RUNTIME_CORE_FALLBACK_REPOSITORY}:v${schemaVersion}-${fingerprint.slice(0, 24)}`;
}
