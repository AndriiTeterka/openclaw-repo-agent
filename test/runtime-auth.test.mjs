import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverGeminiCliProjectId,
  ensureGeminiCliSettings,
  probeAuth,
  refreshGeminiCliOAuthData,
  resolveBootstrapAgentDirs,
  resolveGeminiBootstrapProjectId,
  resolveGeminiProjectId,
  syncGeminiCliAuthProfiles,
 } from "../runtime/bootstrap-auth.mjs";
import { isMissingBinary as isMissingBootstrapBinary } from "../runtime/adapters/bootstrap-shared.mjs";

function createJwt(payload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("probeAuth reports a missing Codex CLI", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-test-"));
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "codex";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = path.join(tempRoot, "missing-codex");

    const result = await probeAuth({ probeOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "Codex CLI is not installed in the runtime image.");
    assert.match(result.recovery, /@openai\/codex/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth syncs mounted Codex subscription auth profiles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-codex-"));
  const fakeCodex = path.join(tempRoot, "fake-codex.cmd");
  await fs.writeFile(fakeCodex, [
    "@echo off",
    "if \"%1\"==\"login\" (",
    "  if \"%2\"==\"status\" exit /b 0",
    ")",
    "exit /b 0"
  ].join("\r\n"));
  await fs.mkdir(path.join(tempRoot, ".codex"), { recursive: true });
  const accessToken = createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  await fs.writeFile(path.join(tempRoot, ".codex", "auth.json"), JSON.stringify({
    tokens: {
      access_token: accessToken,
      refresh_token: "refresh-token",
      account_id: "acct_test",
    },
  }, null, 2));

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "codex";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = fakeCodex;

    const result = await probeAuth();
    const profileStore = JSON.parse(await fs.readFile(
      path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      "utf8"
    ));

    assert.equal(result.mode, "codex");
    assert.equal(profileStore.profiles["openai-codex:default"]?.provider, "openai-codex");
    assert.equal(profileStore.profiles["openai-codex:default"]?.access, accessToken);
    assert.equal(profileStore.profiles["openai-codex:default"]?.refresh, "refresh-token");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth reports a missing Gemini CLI", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-gemini-test-"));
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "gemini";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = path.join(tempRoot, "missing-gemini");

    const result = await probeAuth({ probeOnly: true });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "Gemini CLI is not installed in the runtime image.");
    assert.match(result.recovery, /@google\/gemini-cli/);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth reports mounted Gemini subscription auth in probe mode", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-gemini-mounted-"));
  const fakeGemini = path.join(tempRoot, "fake-gemini.cmd");
  await fs.writeFile(fakeGemini, [
    "@echo off",
    "if \"%1\"==\"--version\" exit /b 0",
    "exit /b 0"
  ].join("\r\n"));
  await fs.mkdir(path.join(tempRoot, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, ".gemini", "oauth_creds.json"), JSON.stringify({
    access_token: "stale-access",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60_000,
  }, null, 2));

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "gemini";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = fakeGemini;

    const result = await probeAuth({ probeOnly: true });
    assert.equal(result.mode, "gemini");
    assert.equal(result.ok, true);
    assert.equal(result.detail, "Gemini subscription login is mounted from the host.");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("isMissingBinary ignores Gemini cleanup warnings from read-only mounted homes", () => {
  const stderr = [
    "Early cleanup failed: Error: ENOENT: no such file or directory, mkdir '/home/node/.gemini/.gemini'",
    "Tool output cleanup failed: ENOENT: no such file or directory, mkdir '/home/node/.gemini/.gemini'",
  ].join("\n");

  assert.equal(isMissingBootstrapBinary(stderr), false);
  assert.equal(isMissingBootstrapBinary("spawn /usr/local/bin/gemini ENOENT"), true);
});

test("probeAuth reports missing Copilot auth when no config or token exists", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-copilot-test-"));
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_COPILOT_AUTH_SOURCE: process.env.OPENCLAW_COPILOT_AUTH_SOURCE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "copilot";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = "";
    delete process.env.COPILOT_GITHUB_TOKEN;

    const result = await probeAuth({ probeOnly: true });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not ready/);
    assert.match(result.recovery, /mount \.copilot/i);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth syncs Copilot runtime token profiles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-copilot-token-"));
  const mainAgentStorePath = path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const workspaceAgentStorePath = path.join(tempRoot, ".openclaw", "agents", "workspace", "agent", "auth-profiles.json");

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_COPILOT_AUTH_SOURCE: process.env.OPENCLAW_COPILOT_AUTH_SOURCE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "copilot";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = "";
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_test_token_1234567890";

    const result = await probeAuth();
    const mainProfileStore = JSON.parse(await fs.readFile(mainAgentStorePath, "utf8"));
    const workspaceProfileStore = JSON.parse(await fs.readFile(workspaceAgentStorePath, "utf8"));

    assert.equal(result.mode, "copilot");
    assert.equal(mainProfileStore.profiles["github-copilot:default"]?.provider, "github-copilot");
    assert.equal(mainProfileStore.profiles["github-copilot:default"]?.type, "token");
    assert.equal(mainProfileStore.profiles["github-copilot:default"]?.token, "github_pat_test_token_1234567890");
    assert.equal(workspaceProfileStore.profiles["github-copilot:default"]?.type, "token");
    assert.equal(workspaceProfileStore.profiles["github-copilot:default"]?.token, "github_pat_test_token_1234567890");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth bootstraps all allowed providers", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-multi-"));
  const fakeCodex = path.join(tempRoot, "fake-codex.cmd");
  await fs.writeFile(fakeCodex, [
    "@echo off",
    "if \"%1\"==\"login\" (",
    "  if \"%2\"==\"status\" exit /b 0",
    ")",
    "exit /b 0"
  ].join("\r\n"));
  await fs.mkdir(path.join(tempRoot, ".codex"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, ".codex", "auth.json"), JSON.stringify({
    tokens: {
      access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: "refresh-token",
      account_id: "acct_test",
    },
  }, null, 2));

  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_ACP_DEFAULT_AGENT: process.env.OPENCLAW_ACP_DEFAULT_AGENT,
    OPENCLAW_ACP_ALLOWED_AGENTS: process.env.OPENCLAW_ACP_ALLOWED_AGENTS,
    OPENCLAW_COPILOT_AUTH_SOURCE: process.env.OPENCLAW_COPILOT_AUTH_SOURCE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
  };

  try {
    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "codex";
    process.env.OPENCLAW_ACP_DEFAULT_AGENT = "codex";
    process.env.OPENCLAW_ACP_ALLOWED_AGENTS = JSON.stringify(["codex", "copilot"]);
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = fakeCodex;
    process.env.COPILOT_GITHUB_TOKEN = "github_pat_test_token_1234567890";

    const result = await probeAuth();
    const profileStore = JSON.parse(await fs.readFile(
      path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      "utf8"
    ));

    assert.equal(result.mode, "multi");
    assert.deepEqual(result.results.map((entry) => entry.mode), ["codex", "copilot"]);
    assert.equal(profileStore.profiles["openai-codex:default"]?.provider, "openai-codex");
    assert.equal(profileStore.profiles["github-copilot:default"]?.type, "token");
    assert.equal(profileStore.profiles["github-copilot:default"]?.token, "github_pat_test_token_1234567890");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth clears stale Copilot runtime profiles when only mounted subscription auth exists", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-copilot-mounted-"));
  const agentStorePath = path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const copilotConfigPath = path.join(tempRoot, ".copilot", "config.json");
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_COPILOT_AUTH_SOURCE: process.env.OPENCLAW_COPILOT_AUTH_SOURCE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
  };

  try {
    await fs.mkdir(path.dirname(agentStorePath), { recursive: true });
    await fs.mkdir(path.dirname(copilotConfigPath), { recursive: true });
    await fs.writeFile(agentStorePath, JSON.stringify({
      version: 1,
      profiles: {
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "stale-runtime-token"
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-test"
        }
      },
      lastGood: {
        "github-copilot": "github-copilot:default"
      },
      usageStats: {
        "github-copilot:default": {
          successes: 3
        }
      }
    }, null, 2));
    await fs.writeFile(copilotConfigPath, JSON.stringify({
      logged_in_users: [{ login: "andrii-teterka13" }]
    }, null, 2));

    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "copilot";
    process.env.OPENCLAW_COPILOT_AUTH_SOURCE = "auth-folder";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = "";
    delete process.env.COPILOT_GITHUB_TOKEN;

    const result = await probeAuth();
    const profileStore = JSON.parse(await fs.readFile(agentStorePath, "utf8"));

    assert.equal(result.mode, "copilot");
    assert.equal(result.detail, "GitHub Copilot subscription login detected. Sign in on the host again if the runtime token bridge is stale.");
    assert.equal(profileStore.profiles["github-copilot:default"], undefined);
    assert.equal(profileStore.lastGood["github-copilot"], undefined);
    assert.equal(profileStore.usageStats["github-copilot:default"], undefined);
    assert.equal(profileStore.profiles["openai:default"]?.key, "sk-test");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("probeAuth syncs Copilot token profiles from the mounted subscription config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-copilot-mounted-token-"));
  const copilotConfigPath = path.join(tempRoot, ".copilot", "config.json");
  const mainAgentStorePath = path.join(tempRoot, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const workspaceAgentStorePath = path.join(tempRoot, ".openclaw", "agents", "workspace", "agent", "auth-profiles.json");
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_BOOTSTRAP_AUTH_MODE: process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE,
    OPENCLAW_COPILOT_AUTH_SOURCE: process.env.OPENCLAW_COPILOT_AUTH_SOURCE,
    OPENCLAW_AGENT_AUTH_CLI_BIN: process.env.OPENCLAW_AGENT_AUTH_CLI_BIN,
    COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
  };

  try {
    await fs.mkdir(path.dirname(copilotConfigPath), { recursive: true });
    await fs.writeFile(copilotConfigPath, JSON.stringify({
      logged_in_users: [{ login: "andrii-teterka13" }],
      access_token: "ghu_test_token_1234567890"
    }, null, 2));

    process.env.HOME = tempRoot;
    process.env.OPENCLAW_BOOTSTRAP_AUTH_MODE = "copilot";
    process.env.OPENCLAW_COPILOT_AUTH_SOURCE = "auth-folder";
    process.env.OPENCLAW_AGENT_AUTH_CLI_BIN = "";
    delete process.env.COPILOT_GITHUB_TOKEN;

    const result = await probeAuth();
    const mainProfileStore = JSON.parse(await fs.readFile(mainAgentStorePath, "utf8"));
    const workspaceProfileStore = JSON.parse(await fs.readFile(workspaceAgentStorePath, "utf8"));

    assert.equal(result.ok, true);
    assert.equal(result.mode, "copilot");
    assert.equal(mainProfileStore.profiles["github-copilot:default"]?.type, "token");
    assert.equal(mainProfileStore.profiles["github-copilot:default"]?.token, "ghu_test_token_1234567890");
    assert.equal(workspaceProfileStore.profiles["github-copilot:default"]?.type, "token");
    assert.equal(workspaceProfileStore.profiles["github-copilot:default"]?.token, "ghu_test_token_1234567890");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("resolveGeminiProjectId prefers the longest matching host-root mapping", () => {
  const store = {
    projects: {
      "c:\\users\\ateterka": "root-project",
      "c:\\users\\ateterka\\intrack-automation": "nested-project"
    }
  };

  assert.equal(
    resolveGeminiProjectId(store, "C:/Users/ateterka/intrack-automation/api-testing"),
    "nested-project"
  );
  assert.equal(
    resolveGeminiProjectId({ projects: { "c:\\users\\ateterka": "only-project" } }, ""),
    "only-project"
  );
});

test("resolveBootstrapAgentDirs includes the workspace agent alongside main and configured directories", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-dirs-"));
  const extraAgentDir = path.join(tempRoot, ".openclaw", "agents", "custom", "agent");
  await fs.mkdir(extraAgentDir, { recursive: true });

  const dirs = await resolveBootstrapAgentDirs(tempRoot, path.join(tempRoot, "configured-agent"));

  assert.deepEqual(
    dirs,
    [
      path.join(tempRoot, ".openclaw", "agents", "main", "agent"),
      path.join(tempRoot, ".openclaw", "agents", "workspace", "agent"),
      path.join(tempRoot, "configured-agent"),
      extraAgentDir,
    ],
  );
});

test("resolveGeminiBootstrapProjectId prefers Google-discovered free-tier projects over local projects.json mappings", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({
      url,
      body: init.body ? JSON.parse(init.body) : null,
    });

    if (url.endsWith("/v1internal:loadCodeAssist")) {
      return new Response(JSON.stringify({
        allowedTiers: [{ id: "free-tier", isDefault: true }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.endsWith("/v1internal:onboardUser")) {
      return new Response(JSON.stringify({
        done: true,
        response: {
          cloudaicompanionProject: { id: "managed-project" }
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const projectId = await resolveGeminiBootstrapProjectId("oauth-token", "ateterka", fetchImpl);

  assert.equal(projectId, "managed-project");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.cloudaicompanionProject, undefined);
  assert.equal(requests[1].body.cloudaicompanionProject, undefined);
});

test("resolveGeminiBootstrapProjectId falls back to the configured project only when Google requires one", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, body });

    if (url.endsWith("/v1internal:loadCodeAssist") && !body?.cloudaicompanionProject) {
      return new Response(JSON.stringify({
        currentTier: { id: "standard-tier" }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.endsWith("/v1internal:loadCodeAssist") && body?.cloudaicompanionProject === "workspace-project") {
      return new Response(JSON.stringify({
        currentTier: { id: "standard-tier" },
        cloudaicompanionProject: "workspace-project"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const projectId = await resolveGeminiBootstrapProjectId("oauth-token", "workspace-project", fetchImpl);

  assert.equal(projectId, "workspace-project");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.cloudaicompanionProject, undefined);
  assert.equal(requests[1].body.cloudaicompanionProject, "workspace-project");
  assert.equal(requests[1].body.metadata.duetProject, "workspace-project");
});

test("discoverGeminiCliProjectId surfaces project permission failures instead of silently reusing the bad project", async () => {
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/v1internal:loadCodeAssist")) {
      return new Response(JSON.stringify({
        error: {
          message: `Permission denied on resource project ${body?.cloudaicompanionProject}.`
        }
      }), {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    () => discoverGeminiCliProjectId("oauth-token", "ateterka", fetchImpl),
    /Permission denied on resource project ateterka\./,
  );
});

test("refreshGeminiCliOAuthData forces a fresh access token from the refresh token", async () => {
  const requests = [];
  const refreshed = await refreshGeminiCliOAuthData({
    access_token: "stale-access",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60_000,
    client_id: "test-client-id",
    client_secret: "test-client-secret",
  }, async (url, init = {}) => {
    requests.push({
      url,
      body: init.body ? init.body.toString() : "",
    });

    return new Response(JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.match(requests[0].body, /client_id=test-client-id/);
  assert.match(requests[0].body, /client_secret=test-client-secret/);
  assert.match(requests[0].body, /grant_type=refresh_token/);
  assert.match(requests[0].body, /refresh_token=refresh-token/);
  assert.equal(refreshed.access, "fresh-access");
  assert.equal(refreshed.refresh, "fresh-refresh");
  assert.equal(refreshed.authData.access_token, "fresh-access");
  assert.equal(refreshed.authData.refresh_token, "fresh-refresh");
  assert.ok(refreshed.expires > Date.now());
});

test("refreshGeminiCliOAuthData discovers client credentials from the installed Gemini CLI bundle", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-bundle-"));
  const bundleRoot = path.join(tempRoot, "bundle");
  const fakeClientId = ["123456789012", "-fakeoauthclient", ".apps.googleusercontent.com"].join("");
  const fakeClientSecret = ["GOCSPX", "-fake_secret_value"].join("");

  await fs.mkdir(bundleRoot, { recursive: true });
  await fs.writeFile(
    path.join(bundleRoot, "oauth2-provider.js"),
    `const config = { client_id: "${fakeClientId}", client_secret: "${fakeClientSecret}" };`,
  );

  const requests = [];
  await refreshGeminiCliOAuthData({
    access_token: "stale-access",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60_000,
  }, async (url, init = {}) => {
    requests.push({
      url,
      body: init.body ? init.body.toString() : "",
    });

    return new Response(JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }, {
    OPENCLAW_GEMINI_CLI_PACKAGE_ROOT: bundleRoot,
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].body, new RegExp(`client_id=${fakeClientId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(requests[0].body, new RegExp(`client_secret=${fakeClientSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("syncGeminiCliAuthProfiles stores refreshed Gemini OAuth credentials in agent profiles", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-sync-"));
  const oauthCredsPath = path.join(tempRoot, "oauth_creds.json");
  const accountsPath = path.join(tempRoot, "google_accounts.json");
  const projectsPath = path.join(tempRoot, "projects.json");
  const agentDir = path.join(tempRoot, ".openclaw", "agents", "workspace", "agent");

  await fs.writeFile(oauthCredsPath, JSON.stringify({
    access_token: "stale-access",
    refresh_token: "refresh-token",
    expiry_date: Date.now() + 60_000,
  }, null, 2));
  await fs.writeFile(accountsPath, JSON.stringify({
    active: {
      email: "person@example.com",
    }
  }, null, 2));
  await fs.writeFile(projectsPath, JSON.stringify({
    projects: {
      "c:/repo": "workspace-project"
    }
  }, null, 2));

  const requests = [];
  const result = await syncGeminiCliAuthProfiles(
    oauthCredsPath,
    accountsPath,
    projectsPath,
    "C:/repo",
    [agentDir],
    {
      OPENCLAW_GEMINI_OAUTH_CLIENT_ID: "test-client-id",
      OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET: "test-client-secret",
    },
    async (url, init = {}) => {
      const body = init.body ? init.body.toString() : "";
      requests.push({ url, body });

      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.toString().endsWith("/v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({
          allowedTiers: [{ id: "free-tier", isDefault: true }]
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.toString().endsWith("/v1internal:onboardUser")) {
        return new Response(JSON.stringify({
          done: true,
          response: {
            cloudaicompanionProject: { id: "managed-project" }
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
  );

  const profileStore = JSON.parse(await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"));

  assert.equal(result.synced, true);
  assert.equal(result.projectId, "managed-project");
  assert.equal(result.refreshedAuthData.access_token, "fresh-access");
  assert.equal(result.refreshedAuthData.refresh_token, "fresh-refresh");
  assert.equal(profileStore.profiles["google-gemini-cli:default"]?.provider, "google-gemini-cli");
  assert.equal(profileStore.profiles["google-gemini-cli:default"]?.access, "fresh-access");
  assert.equal(profileStore.profiles["google-gemini-cli:default"]?.refresh, "fresh-refresh");
  assert.equal(profileStore.profiles["google-gemini-cli:default"]?.projectId, "managed-project");
  assert.equal(profileStore.profiles["google-gemini-cli:default"]?.email, "person@example.com");
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
});

test("ensureGeminiCliSettings writes the Gemini CLI auth selection", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-settings-"));
  const settingsPath = path.join(tempRoot, "settings.json");

  await ensureGeminiCliSettings(settingsPath, {
    ui: { theme: "GitHub" },
    model: { name: "gemini-3.1-pro-preview" },
  });

  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));

  assert.equal(settings.selectedAuthType, "oauth-personal");
  assert.equal(settings.security?.auth?.selectedType, "oauth-personal");
  assert.equal(settings.ui?.theme, "GitHub");
  assert.equal(settings.model?.name, "gemini-3.1-pro-preview");
});
