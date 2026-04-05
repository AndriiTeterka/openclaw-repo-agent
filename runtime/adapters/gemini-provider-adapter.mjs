import path from "node:path";

import { fileExists, safeRunCommand } from "../shared.mjs";
import { isMissingBinary } from "./bootstrap-shared.mjs";
import { syncGeminiCliAuthProfiles } from "./gemini-bootstrap.mjs";
import {
  GEMINI_MODELS_OVERRIDE_ENV,
  geminiCliCandidates,
  geminiModelsJsCandidates,
  readDiscoveryOverride,
  readTextFilesIfExist,
  runDiscoveryCommand,
  sortedUniqueModelIds,
  uniqueStrings,
} from "./model-discovery-shared.mjs";

const GEMINI_PROVIDER_METADATA = Object.freeze({
  mode: "gemini",
  agentId: "gemini",
  agentLabel: "Gemini",
  authSourceEnvKey: "OPENCLAW_GEMINI_AUTH_SOURCE",
  authHomeEnvKey: "GEMINI_CLI_HOME",
  authHomeDirName: ".gemini",
  defaultModelProvider: "google-gemini-cli",
  authFolderLabel: "Gemini subscription login",
  authFolderPrompt: "Gemini subscription login folder",
  authFileName: "oauth_creds.json",
  authCliBin: "/usr/local/bin/gemini",
  authSourceChoices: Object.freeze([
    Object.freeze({ value: "auth-folder", label: "Use Gemini subscription login" }),
  ]),
});

function describeGeminiRecovery(context) {
  const steps = [];
  if (context.binaryMissing) {
    steps.push("Gemini CLI is missing inside the runtime image. Rebuild or upgrade openclaw-repo-agent so the container installs @google/gemini-cli.");
  } else if (context.authExists) {
    steps.push("Gemini subscription auth is mounted from the host, but the OAuth credentials could not be refreshed or validated. Re-run your host Gemini login, then run /acp doctor.");
  } else {
    steps.push("Sign in with the host Gemini CLI so openclaw-repo-agent can mount .gemini into the runtime, then run /acp doctor.");
  }
  return steps.join(" ");
}

function isDiscoverableGeminiModelId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.startsWith("gemini-")
    && !normalized.includes("embedding")
    && !normalized.includes("customtools");
}

function parseGeminiModelIdsFromSource(source = "", { allowFallback = false } = {}) {
  const declaredConstants = new Map(
    [...source.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Z0-9_]+)\s*=\s*["']([^"']+)["']/g)]
      .map(([, name, value]) => [name, value]),
  );

  const validModelsBody = source.match(
    /VALID_GEMINI_MODELS\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?new Set\(\[(.*?)\]\)/s,
  )?.[1] ?? "";
  const referencedConstants = [...validModelsBody.matchAll(/\b([A-Z0-9_]+)\b/g)]
    .map((match) => declaredConstants.get(match[1]))
    .filter(isDiscoverableGeminiModelId);

  if (referencedConstants.length > 0) return sortedUniqueModelIds(referencedConstants);
  if (!allowFallback) return [];

  const fallbackModels = [...declaredConstants.values()].filter(isDiscoverableGeminiModelId);
  return sortedUniqueModelIds(fallbackModels);
}

function geminiCliSupportsModelListing(command, env = process.env) {
  const helpOutput = runDiscoveryCommand(command, ["--help"], env);
  return /^\s*(?:gemini\s+)?models(?:\s|$)/m.test(helpOutput);
}

function discoverGeminiModelIds(env = process.env) {
  const overrideModels = readDiscoveryOverride(env?.[GEMINI_MODELS_OVERRIDE_ENV]);
  if (overrideModels.length > 0) {
    return sortedUniqueModelIds(overrideModels.filter(isDiscoverableGeminiModelId));
  }

  for (const candidatePath of geminiModelsJsCandidates(env)) {
    const [source] = readTextFilesIfExist([candidatePath]);
    if (!source) continue;
    const discoveredModels = parseGeminiModelIdsFromSource(source, {
      allowFallback: /(?:^|[\\/])models\.js$/i.test(candidatePath),
    });
    if (discoveredModels.length > 0) return discoveredModels;
  }

  for (const candidate of geminiCliCandidates(env)) {
    if (!geminiCliSupportsModelListing(candidate, env)) continue;
    const output = runDiscoveryCommand(candidate, ["models", "list", "--json"], env)
      || runDiscoveryCommand(candidate, ["models", "list"], env);
    if (!output) continue;
    const models = [...output.matchAll(/\bgemini-[a-z0-9.-]+\b/gi)]
      .map((match) => match[0])
      .filter(isDiscoverableGeminiModelId);
    if (models.length > 0) return sortedUniqueModelIds(models);
  }

  return [];
}

function resolveGeminiModelProvider() {
  return GEMINI_PROVIDER_METADATA.defaultModelProvider;
}

async function bootstrapGemini(context, options = {}) {
  const runtimeEnv = context.env ?? process.env;
  const {
    homeDir,
    authCliBin,
    agentDirs,
  } = context;

  const geminiHome = path.join(homeDir, ".gemini");
  const oauthPath = path.join(geminiHome, "oauth_creds.json");
  const accountsPath = path.join(geminiHome, "google_accounts.json");
  const projectsPath = path.join(geminiHome, "projects.json");
  const authExists = await fileExists(oauthPath);

  const versionCheck = await safeRunCommand(authCliBin, ["--version"], {
    env: runtimeEnv,
  });
  const binaryMissing = isMissingBinary(versionCheck.stderr || versionCheck.stdout);
  if (binaryMissing) {
    return {
      ok: false,
      mode: "gemini",
      detail: "Gemini CLI is not installed in the runtime image.",
      recovery: describeGeminiRecovery({ binaryMissing, authExists }),
      authExists,
      stderr: versionCheck.stderr || versionCheck.stdout,
    };
  }

  if (options.probeOnly) {
    return {
      ok: authExists,
      mode: "gemini",
      detail: authExists
        ? "Gemini subscription login is mounted from the host."
        : "Gemini CLI authentication is not ready.",
      recovery: describeGeminiRecovery({ authExists, binaryMissing: false }),
      authExists,
      stderr: versionCheck.code === 0 ? "" : (versionCheck.stderr || versionCheck.stdout),
    };
  }

  const geminiProfileSync = authExists
    ? await syncGeminiCliAuthProfiles(
      oauthPath,
      accountsPath,
      projectsPath,
      runtimeEnv.OPENCLAW_REPO_ROOT_HOST ?? "",
      agentDirs,
      runtimeEnv,
    )
    : { synced: false, reason: "" };

  if (authExists && geminiProfileSync.synced) {
    return {
      ok: true,
      mode: "gemini",
      detail: "OpenClaw Gemini CLI auth profiles synced.",
      recovery: "",
      authExists,
    };
  }

  if (authExists) {
    return {
      ok: false,
      mode: "gemini",
      detail: "Gemini CLI OAuth is present, but OpenClaw could not refresh or validate it.",
      recovery: geminiProfileSync.reason || "Unset GOOGLE_CLOUD_PROJECT and retry, or re-run your Gemini login if you intended to use a paid Code Assist project.",
      authExists,
    };
  }

  return {
    ok: false,
    mode: "gemini",
    detail: "Gemini CLI is not authenticated.",
    recovery: describeGeminiRecovery({
      authExists,
      binaryMissing: false,
    }),
    authExists,
  };
}

export const GEMINI_PROVIDER_ADAPTER = Object.freeze({
  metadata: GEMINI_PROVIDER_METADATA,
  bootstrap: bootstrapGemini,
  discoverModelIds: discoverGeminiModelIds,
  filterModelIds: (values = []) => uniqueStrings(values).filter(isDiscoverableGeminiModelId),
  resolveModelProvider: resolveGeminiModelProvider,
  shouldPreserveConfiguredModelId: () => true,
});
