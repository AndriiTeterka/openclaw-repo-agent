export const LOCAL_RUNTIME_IMAGE = "openclaw-repo-agent-runtime:local";

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

export function buildLocalRuntimeEnvOverrides(localEnv = {}, defaultStackImage) {
  const nextLocalEnv = {
    ...localEnv,
    OPENCLAW_USE_LOCAL_BUILD: "true"
  };

  if (!String(localEnv.OPENCLAW_STACK_IMAGE ?? "").trim() || String(localEnv.OPENCLAW_STACK_IMAGE).trim() === defaultStackImage) {
    nextLocalEnv.OPENCLAW_STACK_IMAGE = LOCAL_RUNTIME_IMAGE;
  }

  return nextLocalEnv;
}
