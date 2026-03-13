import { DEFAULT_RUNTIME_IMAGE_REPOSITORY } from "./builtin-profiles.mjs";
import { LEGACY_LOCAL_RUNTIME_IMAGE } from "./instance-registry.mjs";

export function isManagedRemoteRuntimeImage(stackImage, repository = DEFAULT_RUNTIME_IMAGE_REPOSITORY) {
  const normalizedStackImage = String(stackImage ?? "").trim();
  return Boolean(normalizedStackImage)
    && normalizedStackImage.startsWith(`${repository}:`)
    && normalizedStackImage.endsWith("-polyglot");
}

export function isManagedLocalRuntimeImage(stackImage, instanceId = "") {
  const normalizedStackImage = String(stackImage ?? "").trim();
  const normalizedInstanceId = String(instanceId ?? "").trim();
  if (!normalizedStackImage) return false;
  if (normalizedStackImage === LEGACY_LOCAL_RUNTIME_IMAGE) return true;
  return Boolean(normalizedInstanceId)
    && normalizedStackImage.startsWith("openclaw-repo-agent-runtime:")
    && normalizedStackImage.endsWith(`-${normalizedInstanceId}`);
}

export function shouldAutoUseLocalBuild({ useLocalBuild, stackImage, defaultStackImage, errorOutput }) {
  if (useLocalBuild) return false;
  const normalizedStackImage = String(stackImage ?? "").trim();
  const usesDefaultStackImage = !normalizedStackImage || normalizedStackImage === defaultStackImage;
  if (!usesDefaultStackImage) return false;

  const normalizedOutput = String(errorOutput ?? "").toLowerCase();
  return [
    "denied",
    "not found",
    "manifest unknown",
    "pull access denied",
    "error from registry"
  ].some((needle) => normalizedOutput.includes(needle));
}

export function buildLocalRuntimeEnvOverrides(localEnv = {}, defaultStackImage, localRuntimeImage, instanceId = "") {
  const nextLocalEnv = {
    ...localEnv,
    OPENCLAW_USE_LOCAL_BUILD: "true"
  };

  const currentStackImage = String(localEnv.OPENCLAW_STACK_IMAGE ?? "").trim();
  if (!currentStackImage
    || currentStackImage === defaultStackImage
    || isManagedRemoteRuntimeImage(currentStackImage)
    || isManagedLocalRuntimeImage(currentStackImage, instanceId)) {
    nextLocalEnv.OPENCLAW_STACK_IMAGE = localRuntimeImage;
  }

  return nextLocalEnv;
}
