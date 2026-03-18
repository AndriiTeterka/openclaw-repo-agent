import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildManifestFromEnv, normalizeAuthMode } from "./manifest-contract.mjs";
import { copyFileIfNewer, ensureDir, fileExists, safeRunCommand, writeJsonFile } from "./shared.mjs";

function isMissingCodexBinary(stderr = "") {
  return /ENOENT|not found|is not recognized/i.test(String(stderr ?? "").trim());
}

function extractJwtPayload(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return null;

  try {
    const [, payload] = raw.split(".");
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveMainAgentDir(homeDir) {
  return path.join(homeDir, ".openclaw", "agents", "main", "agent");
}

function normalizeAuthProfileStore(store) {
  if (!store || typeof store !== "object") {
    return {
      version: 1,
      profiles: {},
    };
  }

  const profiles = store.profiles && typeof store.profiles === "object" ? store.profiles : {};
  return {
    ...store,
    version: Number.isFinite(Number(store.version)) ? Number(store.version) : 1,
    profiles,
  };
}

async function upsertAuthProfileStore(agentDir, profileId, credential) {
  const storePath = path.join(agentDir, "auth-profiles.json");
  const store = normalizeAuthProfileStore(await readJsonFile(storePath, null));

  store.profiles[profileId] = credential;
  await writeJsonFile(storePath, store);
  await fs.chmod(storePath, 0o600);
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

  for (const agentDir of agentDirs) {
    await ensureDir(agentDir);
    await upsertAuthProfileStore(agentDir, "openai-codex:default", credential);
  }

  return true;
}

async function syncOpenAiApiKeyProfiles(apiKey, agentDirs) {
  const normalizedApiKey = String(apiKey ?? "").trim();
  if (!normalizedApiKey) return false;

  const credential = {
    type: "api_key",
    provider: "openai",
    key: normalizedApiKey,
  };

  for (const agentDir of agentDirs) {
    await ensureDir(agentDir);
    await upsertAuthProfileStore(agentDir, "openai:default", credential);
  }

  return true;
}

function parseArgs(argv) {
  return {
    probeOnly: argv.includes("--probe-only"),
    json: argv.includes("--json"),
  };
}

function describeCodexRecovery(context) {
  const steps = [];
  if (context.binaryMissing) {
    steps.push("Codex CLI is missing inside the runtime image. Rebuild or upgrade openclaw-repo-agent so the container installs @openai/codex.");
  } else if (context.sourceAuthExists) {
    steps.push("Mounted Codex auth exists, but `codex login status` failed. Re-run your host Codex login or remove the stale auth mount.");
  } else if (context.apiKeyExists) {
    steps.push("OPENAI_API_KEY is available. The gateway can bootstrap Codex with the API key during startup.");
  } else {
    steps.push("Provide TARGET_AUTH_PATH pointing at a Codex home with auth.json, or set OPENAI_API_KEY.");
  }
  return steps.join(" ");
}

async function codexAdapter(context, options) {
  const {
    homeDir,
    authMountPath,
    codexBin,
    agentDirs,
    apiKey,
  } = context;

  const codexHome = path.join(homeDir, ".codex");
  const sourceAuthPath = path.join(authMountPath, "auth.json");
  const targetAuthPath = path.join(codexHome, "auth.json");
  const sourceAuthExists = await fileExists(sourceAuthPath);
  const targetAuthExists = await fileExists(targetAuthPath);
  const apiKeyExists = Boolean(apiKey);

  await ensureDir(codexHome);

  const loginStatus = await safeRunCommand(codexBin, ["login", "status"], {
    env: process.env,
  });
  const binaryMissing = isMissingCodexBinary(loginStatus.stderr || loginStatus.stdout);
  if (loginStatus.code === 0) {
    return {
      ok: true,
      mode: "codex",
      detail: "Codex CLI authentication is available.",
      recovery: "",
      sourceAuthExists,
      targetAuthExists,
      apiKeyExists,
    };
  }

  if (binaryMissing) {
    return {
      ok: false,
      mode: "codex",
      detail: "Codex CLI is not installed in the runtime image.",
      recovery: describeCodexRecovery({ binaryMissing, sourceAuthExists, apiKeyExists }),
      sourceAuthExists,
      targetAuthExists,
      apiKeyExists,
      stderr: loginStatus.stderr || loginStatus.stdout,
    };
  }

  if (options.probeOnly) {
    const recovery = describeCodexRecovery({ sourceAuthExists, apiKeyExists, binaryMissing });
    return {
      ok: apiKeyExists,
      mode: "codex",
      detail: apiKeyExists
        ? "Codex CLI is not currently logged in, but OPENAI_API_KEY is available for startup bootstrap."
        : "Codex CLI authentication is not ready.",
      recovery,
      sourceAuthExists,
      targetAuthExists,
      apiKeyExists,
      stderr: loginStatus.stderr || loginStatus.stdout,
    };
  }

  if (await copyFileIfNewer(sourceAuthPath, targetAuthPath)) {
    await fs.chmod(targetAuthPath, 0o600);
  }

  const codexAuthPath = await fileExists(targetAuthPath) ? targetAuthPath : sourceAuthExists ? sourceAuthPath : "";
  const codexProfilesSynced = codexAuthPath ? await syncOpenAiCodexAuthProfiles(codexAuthPath, agentDirs) : false;

  const refreshedLoginStatus = await safeRunCommand(codexBin, ["login", "status"], {
    env: process.env,
  });
  if (refreshedLoginStatus.code === 0) {
    return {
      ok: true,
      mode: "codex",
      detail: codexProfilesSynced
        ? "OpenClaw OpenAI Codex auth profiles synced."
        : "Codex CLI authentication is available.",
      recovery: "",
      sourceAuthExists,
      targetAuthExists: await fileExists(targetAuthPath),
      apiKeyExists,
    };
  }

  if (apiKeyExists) {
    await syncOpenAiApiKeyProfiles(apiKey, agentDirs);
    const apiLogin = await safeRunCommand(codexBin, ["login", "--with-api-key"], {
      env: process.env,
      input: apiKey,
    });
    if (apiLogin.code === 0) {
      return {
        ok: true,
        mode: "codex",
        detail: "OpenClaw OpenAI API-key auth profiles synced.",
        recovery: "",
        sourceAuthExists,
        targetAuthExists: await fileExists(targetAuthPath),
        apiKeyExists,
      };
    }
    return {
      ok: false,
      mode: "codex",
      detail: "Codex CLI API-key bootstrap failed.",
      recovery: "Verify OPENAI_API_KEY and retry `scripts/doctor` or restart the stack.",
      sourceAuthExists,
      targetAuthExists: await fileExists(targetAuthPath),
      apiKeyExists,
      stderr: apiLogin.stderr || apiLogin.stdout,
    };
  }

  return {
    ok: false,
    mode: "codex",
    detail: "Codex CLI is not authenticated.",
    recovery: describeCodexRecovery({ sourceAuthExists, apiKeyExists, binaryMissing: false }),
    sourceAuthExists,
    targetAuthExists: await fileExists(targetAuthPath),
    apiKeyExists,
    stderr: refreshedLoginStatus.stderr || refreshedLoginStatus.stdout,
  };
}

async function externalAdapter() {
  return {
    ok: true,
    mode: "external",
    detail: "External auth mode is active. The gateway will not manage CLI credentials.",
    recovery: "Ensure your external ACP/CLI runtime is installed and authenticated before starting or pairing the stack.",
  };
}

async function noneAdapter() {
  return {
    ok: true,
    mode: "none",
    detail: "Auth bootstrap is disabled.",
    recovery: "Provide auth out-of-band if your selected agent requires it.",
  };
}

export async function probeAuth(options = {}) {
  const homeDir = process.env.HOME?.trim() || "/home/node";
  const authMountPath = "/agent-auth";
  const manifest = buildManifestFromEnv(process.env);
  const mode = normalizeAuthMode(process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE ?? manifest.security.authBootstrapMode);
  const codexBin = process.env.OPENCLAW_AGENT_AUTH_CLI_BIN?.trim()
    || process.env.OPENCLAW_CODEX_CLI_BIN?.trim()
    || "/usr/local/bin/codex";
  const configuredAgentDir = process.env.OPENCLAW_AGENT_DIR?.trim() || String(manifest.agent?.agentDir ?? "").trim();
  const agentDirs = [...new Set([resolveMainAgentDir(homeDir), configuredAgentDir].filter(Boolean))];
  const context = {
    homeDir,
    authMountPath,
    manifest,
    codexBin,
    agentDirs,
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
  };

  if (mode === "external") return await externalAdapter(context, options);
  if (mode === "none") return await noneAdapter(context, options);
  return await codexAdapter(context, options);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await probeAuth({ probeOnly: args.probeOnly });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(result.detail);
    if (result.recovery) console.error(result.recovery);
    if (result.stderr) console.error(result.stderr.trim());
  }

  if (!result.ok) process.exit(1);
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
