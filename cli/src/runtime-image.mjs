import { LEGACY_LOCAL_RUNTIME_IMAGE } from "./instance-registry.mjs";

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

export function buildLocalRuntimeEnvOverrides(localEnv = {}, defaultStackImage, localRuntimeImage) {
  const nextLocalEnv = {
    ...localEnv,
    OPENCLAW_USE_LOCAL_BUILD: "true"
  };

  const currentStackImage = String(localEnv.OPENCLAW_STACK_IMAGE ?? "").trim();
  if (!currentStackImage || currentStackImage === defaultStackImage || currentStackImage === LEGACY_LOCAL_RUNTIME_IMAGE) {
    nextLocalEnv.OPENCLAW_STACK_IMAGE = localRuntimeImage;
  }

  return nextLocalEnv;
}
