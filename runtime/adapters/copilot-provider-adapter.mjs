import fs from "node:fs";

import { resolveCopilotCliTokenFromSources } from "../copilot-auth-token.mjs";
import { resolveCopilotConfigPath } from "../copilot-installation.mjs";
import { fileExists, readJsonFile } from "../shared.mjs";
import { removeAuthProfile, syncAuthProfile } from "./bootstrap-shared.mjs";
import {
  COPILOT_MODEL_DISCOVERY_SCRIPT,
  COPILOT_MODELS_OVERRIDE_ENV,
  copilotSdkCandidates,
  readDiscoveryOverride,
  runDiscoveryCommand,
} from "./model-discovery-shared.mjs";
import {
  filterSupportedCopilotModelIds,
} from "./copilot-model-id-utils.mjs";

const COPILOT_PROVIDER_METADATA = Object.freeze({
  mode: "copilot",
  agentId: "copilot",
  agentLabel: "Copilot",
  authSourceEnvKey: "OPENCLAW_COPILOT_AUTH_SOURCE",
  authHomeEnvKey: "COPILOT_HOME",
  authHomeDirName: ".copilot",
  defaultModelProvider: "github-copilot",
  authFolderLabel: "GitHub Copilot subscription login",
  authFolderPrompt: "GitHub Copilot subscription login folder",
  authFileName: "config.json",
  authCliBin: "/usr/local/bin/copilot",
  authSourceChoices: Object.freeze([
    Object.freeze({ value: "auth-folder", label: "Use GitHub Copilot subscription login" }),
  ]),
});

function describeCopilotRecovery(context) {
  const steps = [];
  if (context.authConfigExists) {
    steps.push("GitHub Copilot subscription auth is mounted from the host, but the runtime token bridge is not ready. Sign in on the host again, then run /acp doctor.");
  } else {
    steps.push("Sign in with the host GitHub Copilot CLI so openclaw-repo-agent can mount .copilot into the runtime and bridge the Copilot token.");
  }
  return steps.join(" ");
}

async function syncCopilotRuntimeTokenProfiles(token, agentDirs) {
  const normalizedToken = String(token ?? "").trim();
  if (!normalizedToken) return false;

  const credential = {
    type: "token",
    provider: "github-copilot",
    token: normalizedToken,
  };

  await syncAuthProfile(agentDirs, "github-copilot:default", credential);
  return true;
}

function normalizeCopilotRuntimeTokenStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasCopilotLoggedInUser(env = process.env) {
  const configPath = resolveCopilotConfigPath(env);
  if (!configPath || !fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const loggedInUsers = Array.isArray(config?.logged_in_users) ? config.logged_in_users : [];
    return loggedInUsers.length > 0;
  } catch {
    return false;
  }
}

function discoverCopilotModelIds(env = process.env) {
  const overridden = readDiscoveryOverride(env?.[COPILOT_MODELS_OVERRIDE_ENV]);
  if (overridden.length > 0) {
    return filterSupportedCopilotModelIds(overridden);
  }

  const sdkCandidate = copilotSdkCandidates(env).find((candidate) => candidate && fs.existsSync(candidate)) || "";
  const discoveryArgs = sdkCandidate
    ? [COPILOT_MODEL_DISCOVERY_SCRIPT, sdkCandidate]
    : [COPILOT_MODEL_DISCOVERY_SCRIPT];
  const output = runDiscoveryCommand(process.execPath, discoveryArgs, env);
  if (output) {
    const parsed = readDiscoveryOverride(output);
    const filtered = filterSupportedCopilotModelIds(parsed);
    if (filtered.length > 0) return filtered;
  }

  return [];
}

async function bootstrapCopilot(context, options = {}) {
  const {
    env = process.env,
    homeDir,
    agentDirs,
    githubToken,
  } = context;

  const configPath = resolveCopilotConfigPath({
    ...env,
    HOME: String(env?.HOME ?? homeDir ?? "").trim() || homeDir,
  });
  const authConfigExists = await fileExists(configPath);
  const configData = authConfigExists ? await readJsonFile(configPath, null) : null;
  const runtimeToken = resolveCopilotCliTokenFromSources(githubToken, configData);
  const runtimeTokenAvailable = Boolean(runtimeToken);
  const loggedInUsers = Array.isArray(configData?.logged_in_users) ? configData.logged_in_users : [];
  const hasSubscription = loggedInUsers.length > 0;

  if (options.probeOnly) {
    const authReady = hasSubscription || runtimeTokenAvailable;
    return {
      ok: authReady,
      mode: "copilot",
      detail: authReady
        ? (hasSubscription
          ? "GitHub Copilot subscription login detected."
          : "A Copilot runtime token is available for startup bootstrap.")
        : "GitHub Copilot authentication is not ready.",
      recovery: describeCopilotRecovery({ authConfigExists }),
      authConfigExists,
      runtimeTokenAvailable,
    };
  }

  if (runtimeTokenAvailable) {
    await syncCopilotRuntimeTokenProfiles(runtimeToken, agentDirs);
    return {
      ok: true,
      mode: "copilot",
      detail: hasSubscription
        ? "OpenClaw GitHub Copilot auth profiles synced with the host subscription login."
        : "OpenClaw GitHub Copilot runtime token bridge is ready.",
      recovery: "",
      authConfigExists,
      runtimeTokenAvailable,
    };
  }

  if (hasSubscription) {
    await removeAuthProfile(agentDirs, "github-copilot:default", "github-copilot");
    return {
      ok: true,
      mode: "copilot",
      detail: "GitHub Copilot subscription login detected. Sign in on the host again if the runtime token bridge is stale.",
      recovery: "",
      authConfigExists,
      runtimeTokenAvailable,
    };
  }

  return {
    ok: false,
    mode: "copilot",
    detail: "GitHub Copilot is not authenticated.",
    recovery: describeCopilotRecovery({ authConfigExists }),
    authConfigExists,
    runtimeTokenAvailable,
  };
}

function describeCopilotUnavailable({ label = "", env = process.env } = {}) {
  const tokenStatus = normalizeCopilotRuntimeTokenStatus(env?.OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS);
  const httpStatus = String(env?.OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS ?? "").trim();
  if (tokenStatus && tokenStatus !== "ok") {
    const tokenSuffix = httpStatus ? ` (HTTP ${httpStatus})` : "";
    const recovery = hasCopilotLoggedInUser(env)
      ? "Sign in on the host again so the runtime token bridge refreshes, then run /acp doctor."
      : "Sign in on the host again, then run /acp doctor.";
    return `${label} is currently unavailable. The runtime GitHub token could not be exchanged for a Copilot session token${tokenSuffix}. ${recovery}`;
  }
  return `${label} is currently unavailable. Sign in on the host, then run /acp doctor.`;
}

function resolveCopilotModelProvider() {
  return COPILOT_PROVIDER_METADATA.defaultModelProvider;
}

export const COPILOT_PROVIDER_ADAPTER = Object.freeze({
  metadata: COPILOT_PROVIDER_METADATA,
  bootstrap: bootstrapCopilot,
  discoverModelIds: discoverCopilotModelIds,
  filterModelIds: filterSupportedCopilotModelIds,
  resolveModelProvider: resolveCopilotModelProvider,
  shouldPreserveConfiguredModelId: () => false,
  describeUnavailable: describeCopilotUnavailable,
});
