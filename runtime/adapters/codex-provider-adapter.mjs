import path from "node:path";

import { fileExists, readJsonFile, safeRunCommand } from "../shared.mjs";
import {
  CODEX_MODELS_OVERRIDE_ENV,
  codexBinaryCandidates,
  codexCliCandidates,
  matchesSupportedModelPrefix,
  readBufferIfExists,
  readDiscoveryOverride,
  runDiscoveryCommand,
  sortedUniqueModelIds,
  uniqueStrings,
} from "./model-discovery-shared.mjs";
import {
  extractJwtPayload,
  isMissingBinary,
  syncAuthProfile,
} from "./bootstrap-shared.mjs";

const CODEX_PROVIDER_METADATA = Object.freeze({
  mode: "codex",
  agentId: "codex",
  agentLabel: "Codex",
  authSourceEnvKey: "OPENCLAW_CODEX_AUTH_SOURCE",
  authHomeEnvKey: "CODEX_HOME",
  authHomeDirName: ".codex",
  defaultModelProvider: "openai-codex",
  authFolderLabel: "OpenAI subscription login",
  authFolderPrompt: "OpenAI subscription login folder",
  authFileName: "auth.json",
  authCliBin: "/usr/local/bin/codex",
  authSourceChoices: Object.freeze([
    Object.freeze({ value: "auth-folder", label: "Use OpenAI subscription login" }),
  ]),
});

const SUPPORTED_CODEX_MODEL_PREFIXES = Object.freeze([
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
]);

function describeCodexRecovery(context) {
  const steps = [];
  if (context.binaryMissing) {
    steps.push("Codex CLI is missing inside the runtime image. Rebuild or upgrade openclaw-repo-agent so the container installs @openai/codex.");
  } else if (context.authExists) {
    steps.push("Codex subscription auth is mounted from the host, but `codex login status` failed. Re-run your host Codex login, then run /acp doctor.");
  } else {
    steps.push("Sign in with the host Codex CLI so openclaw-repo-agent can mount .codex into the runtime, then run /acp doctor.");
  }
  return steps.join(" ");
}

async function syncOpenAiCodexAuthProfiles(codexAuthPath, agentDirs) {
  const authData = await readJsonFile(codexAuthPath, null);
  const access = String(authData?.tokens?.access_token ?? "").trim();
  const refresh = String(authData?.tokens?.refresh_token ?? "").trim();
  if (!access || !refresh) return false;

  const payload = extractJwtPayload(access);
  const expires = Number(payload?.exp) * 1000;
  if (!Number.isFinite(expires) || expires <= 0) return false;

  const accountId = String(authData?.tokens?.account_id ?? "").trim();
  const credential = {
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };

  await syncAuthProfile(agentDirs, "openai-codex:default", credential);
  return true;
}

function normalizeCodexModelId(versionPart, variant = "") {
  const normalizedVersion = String(versionPart ?? "").trim().replace(/-/g, ".");
  const normalizedVariant = String(variant ?? "").trim().toLowerCase();
  if (normalizedVersion === "5") {
    if (normalizedVariant === "mini") return "gpt-5.4-mini";
    if (!normalizedVariant) return "gpt-5.4";
  }
  return `gpt-${normalizedVersion}-codex${normalizedVariant ? `-${normalizedVariant}` : ""}`;
}

function isVersionedCodexModelId(modelId) {
  return /^gpt-\d+(?:[.-]\d+)+(?:-[a-z0-9.]+)*$/i.test(String(modelId ?? "").trim());
}

function isSupportedCodexModelId(modelId) {
  return matchesSupportedModelPrefix(modelId, SUPPORTED_CODEX_MODEL_PREFIXES);
}

function filterSupportedCodexModelIds(modelIds = []) {
  return uniqueStrings(modelIds).filter(isSupportedCodexModelId);
}

function discoverCodexModelIds(env = process.env) {
  const overrideModels = readDiscoveryOverride(env?.[CODEX_MODELS_OVERRIDE_ENV]);
  if (overrideModels.length > 0) {
    return sortedUniqueModelIds(filterSupportedCodexModelIds(
      overrideModels.filter((value) => /\bgpt-(\d+(?:[.-]\d+)*)-codex(?:-(max|mini))?\b/i.test(value)),
    ));
  }

  for (const candidate of codexCliCandidates(env)) {
    const output = runDiscoveryCommand(candidate, ["models", "list", "--json"], env)
      || runDiscoveryCommand(candidate, ["models", "list"], env);
    if (!output) continue;
    const matches = [];
    const pattern = /\bgpt-(\d+(?:[.-]\d+)*)-codex(?:-(max|mini))?\b/gi;
    for (const match of output.matchAll(pattern)) {
      matches.push(normalizeCodexModelId(match[1], match[2]));
    }
    if (matches.length > 0) return sortedUniqueModelIds(filterSupportedCodexModelIds(matches));
  }

  const binary = readBufferIfExists(codexBinaryCandidates(env));
  if (!binary) return [];

  const text = binary.toString("latin1");
  const matches = [];
  const pattern = /\bgpt-(\d+(?:[.-]\d+)*)-codex(?:-(max|mini))?\b/gi;
  for (const match of text.matchAll(pattern)) {
    matches.push(normalizeCodexModelId(match[1], match[2]));
  }
  return sortedUniqueModelIds(filterSupportedCodexModelIds(matches));
}

async function bootstrapCodex(context, options = {}) {
  const runtimeEnv = context.env ?? process.env;
  const {
    homeDir,
    authCliBin,
    agentDirs,
  } = context;

  const codexAuthPath = path.join(homeDir, ".codex", "auth.json");
  const authExists = await fileExists(codexAuthPath);

  const loginStatus = await safeRunCommand(authCliBin, ["login", "status"], {
    env: runtimeEnv,
  });
  const binaryMissing = isMissingBinary(loginStatus.stderr || loginStatus.stdout);
  if (loginStatus.code === 0) {
    const codexProfilesSynced = authExists ? await syncOpenAiCodexAuthProfiles(codexAuthPath, agentDirs) : false;
    return {
      ok: true,
      mode: "codex",
      detail: codexProfilesSynced
        ? "OpenClaw OpenAI Codex auth profiles synced."
        : "Codex CLI authentication is available.",
      recovery: "",
      authExists,
    };
  }

  if (binaryMissing) {
    return {
      ok: false,
      mode: "codex",
      detail: "Codex CLI is not installed in the runtime image.",
      recovery: describeCodexRecovery({ binaryMissing, authExists }),
      authExists,
      stderr: loginStatus.stderr || loginStatus.stdout,
    };
  }

  if (options.probeOnly) {
    const recovery = describeCodexRecovery({ authExists, binaryMissing });
    return {
      ok: false,
      mode: "codex",
      detail: authExists
        ? "Codex subscription auth is mounted from the host, but Codex CLI is not ready."
        : "Codex CLI authentication is not ready.",
      recovery,
      authExists,
      stderr: loginStatus.stderr || loginStatus.stdout,
    };
  }

  return {
    ok: false,
    mode: "codex",
    detail: "Codex CLI is not authenticated.",
    recovery: describeCodexRecovery({ authExists, binaryMissing: false }),
    authExists,
    stderr: loginStatus.stderr || loginStatus.stdout,
  };
}

function resolveCodexModelProvider() {
  return CODEX_PROVIDER_METADATA.defaultModelProvider;
}

export const CODEX_PROVIDER_ADAPTER = Object.freeze({
  metadata: CODEX_PROVIDER_METADATA,
  bootstrap: bootstrapCodex,
  discoverModelIds: discoverCodexModelIds,
  filterModelIds: filterSupportedCodexModelIds,
  isSupportedModelId: isSupportedCodexModelId,
  resolveModelProvider: resolveCodexModelProvider,
  shouldPreserveConfiguredModelId: isVersionedCodexModelId,
});
