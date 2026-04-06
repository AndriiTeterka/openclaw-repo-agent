import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_PLUGIN_CONFIG } from "../cli/src/builtin-profiles.mjs";
import { materializeRuntime, normalizePortablePath, renderState, resolveState } from "../cli/src/cli.mjs";
import { buildInstanceMetadata, resolveInstanceRegistryPath } from "../cli/src/instance-registry.mjs";
import { resolveAgentPaths } from "../cli/src/state-layout.mjs";
import { createEventLogger } from "../runtime/observability.mjs";

const repoRoot = path.resolve(".");

function createDetection() {
  return {
    projectName: "demo-workspace",
    toolingProfiles: [],
    stack: {
      languages: [],
      tools: []
    }
  };
}

async function createTempContext(envOverrides = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-state-"));
  const tempRepo = path.join(tempRoot, "repo");
  const instance = buildInstanceMetadata(tempRepo);
  const env = {
    OPENCLAW_REPO_AGENT_STATE_HOME: path.join(tempRoot, "state"),
    OPENCLAW_REPO_AGENT_MOUNT_HOME: path.join(tempRoot, "mounts"),
    ...(typeof envOverrides === "function" ? envOverrides(tempRoot) : envOverrides)
  };
  const context = {
    repoRoot: tempRepo,
    productRoot: repoRoot,
    repoSlug: instance.repoSlug,
    instanceId: instance.instanceId,
    composeProjectName: instance.composeProjectName,
    instanceRegistryFile: resolveInstanceRegistryPath(env),
    paths: resolveAgentPaths(tempRepo, instance.instanceId, env),
    detection: createDetection()
  };

  await fs.mkdir(path.join(tempRepo, ".openclaw"), { recursive: true });
  await fs.writeFile(path.join(tempRepo, ".openclaw", "config.json"), `${JSON.stringify({
    ...DEFAULT_PLUGIN_CONFIG,
    projectName: "demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfiles: ["node22"],
    tooling: {
      installScripts: [],
      allowUnsafeCommands: false
    },
    agent: {
      ...DEFAULT_PLUGIN_CONFIG.agent,
      installScripts: []
    }
  }, null, 2)}\n`);
  await fs.mkdir(path.dirname(context.paths.secretsEnvFile), { recursive: true });
  await fs.writeFile(context.paths.secretsEnvFile, "TELEGRAM_BOT_TOKEN=\n");
  return context;
}

test("resolveState does not call the command runner", async () => {
  const context = await createTempContext();
  context.commandRunner = async () => {
    throw new Error("resolveState should not spawn commands");
  };

  const state = await resolveState(context);
  assert.equal(state.manifest.projectName, "demo-workspace");
  assert.equal(state.requestedRuntimeCoreImage, "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest");
});

test("renderState does not call the command runner", async () => {
  const context = await createTempContext();
  context.commandRunner = async () => {
    throw new Error("renderState should not spawn commands");
  };

  const resolved = await resolveState(context);
  const rendered = await renderState(resolved, {
    targets: ["tooling"],
    options: {}
  });

  const toolingManifest = JSON.parse(await fs.readFile(context.paths.toolingManifestFile, "utf8"));
  assert.equal(rendered.toolingManifest.schemaVersion, 1);
  assert.equal(toolingManifest.schemaVersion, 1);
});

test("renderState runtime env mounts provider homes and excludes legacy auth surfaces", async () => {
  const context = await createTempContext((tempRoot) => ({
    CODEX_HOME: path.join(tempRoot, ".codex"),
    GEMINI_CLI_HOME: path.join(tempRoot, ".gemini"),
    COPILOT_HOME: path.join(tempRoot, ".copilot"),
    OPENCLAW_AGENTS_HOME: path.join(tempRoot, ".agents"),
    OPENCLAW_CLAUDE_HOME: path.join(tempRoot, ".claude")
  }));
  context.commandRunner = async () => {
    throw new Error("renderState should not spawn commands");
  };
  await fs.mkdir(context.paths.providerHomes.codex, { recursive: true });
  await fs.mkdir(context.paths.providerHomes.gemini, { recursive: true });
  await fs.mkdir(path.join(path.dirname(context.repoRoot), ".agents"), { recursive: true });

  const resolved = await resolveState(context);
  await renderState(resolved, {
    targets: ["runtime"],
    materializedRuntime: {
      runtimeCoreImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      runtimeCoreDigest: "sha256:test",
      toolingImage: "openclaw-repo-agent-tooling:test",
      coreProvenance: "pulled"
    },
    options: {}
  });

  const runtimeEnv = await fs.readFile(context.paths.runtimeEnvFile, "utf8");
  const composeSource = await fs.readFile(context.paths.composeFile, "utf8");
  assert.match(runtimeEnv, /OPENCLAW_RUNTIME_CORE_DIGEST=sha256:test/);
  assert.match(runtimeEnv, /OPENCLAW_NODE_OPTIONS=--max-old-space-size=3072/);
  assert.match(runtimeEnv, /OPENCLAW_CONTAINER_MEMORY_LIMIT=4g/);
  assert.match(runtimeEnv, /OPENCLAW_EVENT_LOG_FILE=\/workspace\/\.openclaw\/runtime\/events\.jsonl/);
  assert.match(runtimeEnv, /CODEX_HOME=\/home\/node\/\.codex/);
  assert.match(runtimeEnv, /GEMINI_CLI_HOME=\/home\/node\/\.gemini/);
  assert.match(runtimeEnv, /COPILOT_HOME=\/home\/node\/\.copilot/);
  assert.match(runtimeEnv, /OPENCLAW_CODEX_HOME_MOUNT_PATH=.*\.codex/);
  assert.match(runtimeEnv, /OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH=.*\.gemini/);
  assert.match(runtimeEnv, /OPENCLAW_COPILOT_HOME_MOUNT_PATH=\r?\n/);
  assert.match(runtimeEnv, /OPENCLAW_COPILOT_SESSION_STATE_MOUNT_PATH=.*copilot-session-state/);
  assert.match(runtimeEnv, /OPENCLAW_AGENTS_HOME_MOUNT_PATH=.*\.agents/);
  assert.match(runtimeEnv, /OPENCLAW_CLAUDE_HOME_MOUNT_PATH=\r?\n/);
  assert.match(composeSource, /\$\{OPENCLAW_CODEX_HOME_MOUNT_PATH\}:\$\{CODEX_HOME\}:ro/);
  assert.match(composeSource, /\$\{OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH\}:\$\{GEMINI_CLI_HOME\}:ro/);
  assert.match(composeSource, /\$\{OPENCLAW_COPILOT_SESSION_STATE_MOUNT_PATH\}:\/home\/node\/\.copilot\/session-state:rw/);
  assert.match(composeSource, /\$\{OPENCLAW_AGENTS_HOME_MOUNT_PATH\}:\/home\/node\/\.agents:ro/);
  assert.doesNotMatch(composeSource, /\$\{OPENCLAW_COPILOT_HOME_MOUNT_PATH\}:\$\{COPILOT_HOME\}:ro/);
  assert.doesNotMatch(composeSource, /\$\{OPENCLAW_CLAUDE_HOME_MOUNT_PATH\}:\/home\/node\/\.claude:ro/);
  assert.doesNotMatch(runtimeEnv, /OPENCLAW_CODEX_AUTH_PATH=|OPENCLAW_GEMINI_AUTH_PATH=|OPENCLAW_COPILOT_AUTH_PATH=|TARGET_AUTH_PATH=|OPENCLAW_AUTH_MIRRORS_DIR=|OPENCLAW_AUTH_MIRRORS_MOUNT_PATH=|OPENAI_API_KEY=|GEMINI_API_KEY=|COPILOT_GITHUB_TOKEN=|GITHUB_TOKEN=/);
});

test("renderState forwards the Copilot runtime bridge token only when available", async () => {
  const context = await createTempContext();
  context.commandRunner = async () => {
    throw new Error("renderState should not spawn commands");
  };
  await fs.appendFile(context.paths.secretsEnvFile, "COPILOT_GITHUB_TOKEN=github_pat_test_token_1234567890\n");

  const resolved = await resolveState(context);
  await renderState(resolved, {
    targets: ["runtime"],
    materializedRuntime: {
      runtimeCoreImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      runtimeCoreDigest: "sha256:test",
      toolingImage: "openclaw-repo-agent-tooling:test",
      coreProvenance: "pulled"
    },
    options: {}
  });

  const runtimeEnv = await fs.readFile(context.paths.runtimeEnvFile, "utf8");
  const composeSource = await fs.readFile(context.paths.composeFile, "utf8");
  assert.match(runtimeEnv, /COPILOT_GITHUB_TOKEN=github_pat_test_token_1234567890/);
  assert.match(composeSource, /COPILOT_GITHUB_TOKEN: \$\{COPILOT_GITHUB_TOKEN:-\}/);
  assert.doesNotMatch(runtimeEnv, /(^|[\r\n])GITHUB_TOKEN=/);
});

test("renderState forwards the host-discovered Copilot model list into the runtime", async () => {
  const context = await createTempContext();
  context.commandRunner = async () => {
    throw new Error("renderState should not spawn commands");
  };
  await fs.writeFile(path.join(context.repoRoot, ".openclaw", "config.json"), `${JSON.stringify({
    ...DEFAULT_PLUGIN_CONFIG,
    projectName: "demo-workspace",
    deploymentProfile: "docker-local",
    toolingProfiles: ["node22"],
    tooling: {
      installScripts: [],
      allowUnsafeCommands: false,
    },
    agent: {
      ...DEFAULT_PLUGIN_CONFIG.agent,
      installScripts: [],
    },
    acp: {
      ...DEFAULT_PLUGIN_CONFIG.acp,
      defaultAgent: "copilot",
      allowedAgents: ["copilot"],
    },
    security: {
      ...DEFAULT_PLUGIN_CONFIG.security,
      authBootstrapMode: "copilot",
    },
  }, null, 2)}\n`);
  await fs.appendFile(
    context.paths.secretsEnvFile,
    "OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS=[\"claude-sonnet-4.6\",\"gpt-5.4\"]\n"
  );

  const resolved = await resolveState(context);
  await renderState(resolved, {
    targets: ["runtime"],
    materializedRuntime: {
      runtimeCoreImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      runtimeCoreDigest: "sha256:test",
      toolingImage: "openclaw-repo-agent-tooling:test",
      coreProvenance: "pulled"
    },
    options: {}
  });

  const runtimeEnv = await fs.readFile(context.paths.runtimeEnvFile, "utf8");
  const composeSource = await fs.readFile(context.paths.composeFile, "utf8");
  assert.match(runtimeEnv, /OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS=\["claude-sonnet-4\.6","gpt-5\.4"\]/);
  assert.match(composeSource, /OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS: \$\{OPENCLAW_MODEL_DISCOVERY_COPILOT_MODELS\}/);
});

test("renderState forwards detected Copilot MCP auth env into the runtime", async () => {
  const context = await createTempContext((tempRoot) => ({
    COPILOT_HOME: path.join(tempRoot, ".copilot"),
    ADO_MCP_AUTH_TOKEN: "ado_test_token_value",
  }));
  context.commandRunner = async () => {
    throw new Error("renderState should not spawn commands");
  };
  await fs.mkdir(context.paths.providerHomes.copilot, { recursive: true });
  await fs.writeFile(
    path.join(context.paths.providerHomes.copilot, "mcp-config.json"),
    `${JSON.stringify({
      mcpServers: {
        ado: {
          command: "npx",
          args: ["-y", "@azure-devops/mcp", "Intrack-Microservices", "--authentication", "envvar"],
        },
      },
    }, null, 2)}\n`
  );

  const resolved = await resolveState(context);
  await renderState(resolved, {
    targets: ["runtime"],
    materializedRuntime: {
      runtimeCoreImage: "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest",
      runtimeCoreDigest: "sha256:test",
      toolingImage: "openclaw-repo-agent-tooling:test",
      coreProvenance: "pulled",
    },
    options: {},
  });

  const runtimeEnv = await fs.readFile(context.paths.runtimeEnvFile, "utf8");
  const composeSource = await fs.readFile(context.paths.composeFile, "utf8");
  assert.match(
    runtimeEnv,
    /(^|[\r\n])ADO_MCP_AUTH_TOKEN=[^\r\n]+/
  );
  assert.match(
    runtimeEnv,
    /OPENCLAW_HOST_ENV_PASSTHROUGH_JSON=\{"ADO_MCP_AUTH_TOKEN":"[^"\r\n]+"\}/
  );
  assert.match(
    composeSource,
    /OPENCLAW_HOST_ENV_PASSTHROUGH_JSON: \$\{OPENCLAW_HOST_ENV_PASSTHROUGH_JSON\}/
  );
  assert.match(
    composeSource,
    /ADO_MCP_AUTH_TOKEN: \$\{ADO_MCP_AUTH_TOKEN:-\}/
  );
});

test("resolve/render/materialize emit structured events and propagate runtime correlation ids", async () => {
  const context = await createTempContext();
  await fs.appendFile(context.paths.secretsEnvFile, "OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD=false\n");
  const eventLogger = createEventLogger({
    repoRoot: context.repoRoot,
    destination: context.paths.eventLogFile,
    component: "cli",
    runId: "run-123",
    correlationId: "corr-456",
    defaults: {
      command: "up"
    }
  });
  context.observability = {
    logger: eventLogger,
    eventLogFile: context.paths.eventLogFile
  };
  context.commandRunner = async (command, args) => {
    const joined = `${command} ${args.join(" ")}`;
    if (joined.includes("image inspect ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes("image inspect openclaw-repo-agent-tooling")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes(" build ")) {
      return { code: 0, stdout: "built", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const observedOptions = { eventLogger };
  const resolved = await resolveState(context, observedOptions);
  const renderedTooling = await renderState(resolved, {
    targets: ["tooling"],
    options: observedOptions
  });
  const runtimeImages = await materializeRuntime(resolved, renderedTooling, observedOptions);
  await renderState(renderedTooling, {
    targets: ["runtime"],
    materializedRuntime: runtimeImages,
    options: observedOptions
  });

  const runtimeEnv = await fs.readFile(context.paths.runtimeEnvFile, "utf8");
  assert.match(runtimeEnv, /OPENCLAW_EVENT_LOG_FILE=\/workspace\/\.openclaw\/runtime\/events\.jsonl/);
  assert.match(runtimeEnv, /OPENCLAW_EVENT_RUN_ID=run-123/);
  assert.match(runtimeEnv, /OPENCLAW_EVENT_CORRELATION_ID=corr-456/);

  const records = (await fs.readFile(context.paths.eventLogFile, "utf8"))
    .trim()
    .split(/\r?\n/g)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.stage === "state.resolve" && record.event === "state.resolve.started"));
  assert.ok(records.some((record) => record.stage === "state.resolve" && record.event === "state.resolve.finished"));
  assert.ok(records.some((record) => record.stage === "state.render" && record.event === "state.render.finished"));
  assert.ok(records.some((record) => record.stage === "runtime.materialize" && record.event === "runtime.materialize.finished"));
  assert.ok(records.every((record) => record.runId === "run-123"));
  assert.ok(records.every((record) => record.correlationId === "corr-456"));
});

test("materializeRuntime uses the command runner for Docker operations", async () => {
  const context = await createTempContext();
  await fs.appendFile(context.paths.secretsEnvFile, "OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD=false\n");
  const calls = [];
  context.commandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const joined = `${command} ${args.join(" ")}`;
    if (joined.includes("image inspect ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes("image inspect openclaw-repo-agent-tooling")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes(" build ")) {
      return { code: 0, stdout: "built", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const resolved = await resolveState(context);
  const rendered = await renderState(resolved, {
    targets: ["tooling"],
    options: {}
  });
  const runtimeImages = await materializeRuntime(resolved, rendered, {});

  assert.match(runtimeImages.toolingImage, /^openclaw-repo-agent-tooling:v2-/);
  assert.ok(calls.some((entry) => entry.join(" ").includes("docker image inspect")));
  assert.ok(calls.some((entry) => entry.join(" ").includes("docker build --file Dockerfile.tooling")));
});

test("materializeRuntime prefers a local runtime-core build for product checkouts", async () => {
  const context = await createTempContext();
  await fs.appendFile(context.paths.secretsEnvFile, "OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD=true\n");
  const calls = [];
  let runtimeCoreBuilt = false;
  context.commandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const joined = `${command} ${args.join(" ")}`;
    if (joined.includes("image inspect openclaw-repo-agent-runtime-core-fallback")) {
      if (!runtimeCoreBuilt) return { code: 1, stdout: "", stderr: "missing" };
      return {
        code: 0,
        stdout: JSON.stringify([{ RepoDigests: [], Id: "sha256:local-runtime-core" }]),
        stderr: ""
      };
    }
    if (joined.includes("build --file runtime/Dockerfile.core.overlay")) {
      runtimeCoreBuilt = true;
      return { code: 0, stdout: "built", stderr: "" };
    }
    if (joined.includes("image inspect openclaw-repo-agent-tooling")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes("build --file Dockerfile.tooling")) {
      return { code: 0, stdout: "built", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const resolved = await resolveState(context);
  const rendered = await renderState(resolved, {
    targets: ["tooling"],
    options: {}
  });
  const runtimeImages = await materializeRuntime(resolved, rendered, {});

  assert.equal(runtimeImages.coreProvenance, "local-product-build");
  assert.equal(runtimeImages.runtimeCoreDigest, "sha256:local-runtime-core");
  assert.match(runtimeImages.runtimeCoreImage, /^openclaw-repo-agent-runtime-core-fallback:v1-[a-f0-9]{24}$/);
  assert.ok(calls.some((entry) => entry.join(" ").includes("docker build --file runtime/Dockerfile.core.overlay")));
  assert.ok(calls.some((entry) => entry.join(" ").includes("docker build --file Dockerfile.tooling")));
  assert.ok(!calls.some((entry) => entry.join(" ").includes("docker pull ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core:latest")));
});

test("materializeRuntime tolerates a local runtime-core build race once the image exists", async () => {
  const context = await createTempContext();
  await fs.appendFile(context.paths.secretsEnvFile, "OPENCLAW_PREFER_LOCAL_RUNTIME_CORE_BUILD=true\n");
  let runtimeCoreAvailable = false;
  context.commandRunner = async (command, args) => {
    const joined = `${command} ${args.join(" ")}`;
    if (joined.includes("image inspect openclaw-repo-agent-runtime-core-fallback")) {
      if (!runtimeCoreAvailable) return { code: 1, stdout: "", stderr: "missing" };
      return {
        code: 0,
        stdout: JSON.stringify([{ RepoDigests: [], Id: "sha256:local-runtime-core-race" }]),
        stderr: ""
      };
    }
    if (joined.includes("build --file runtime/Dockerfile.core.overlay")) {
      runtimeCoreAvailable = true;
      return { code: 1, stdout: "", stderr: "already exists" };
    }
    if (joined.includes("image inspect openclaw-repo-agent-tooling")) {
      return { code: 1, stdout: "", stderr: "missing" };
    }
    if (joined.includes("build --file Dockerfile.tooling")) {
      return { code: 0, stdout: "built", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const resolved = await resolveState(context);
  const rendered = await renderState(resolved, {
    targets: ["tooling"],
    options: {}
  });
  const runtimeImages = await materializeRuntime(resolved, rendered, {});

  assert.equal(runtimeImages.coreProvenance, "local-product-build");
  assert.equal(runtimeImages.runtimeCoreDigest, "sha256:local-runtime-core-race");
});

test("normalizePortablePath treats Docker Desktop bind sources as the same host path", () => {
  assert.equal(
    normalizePortablePath("/run/desktop/mnt/host/c/Users/ateterka/intrack-automation"),
    "c:/users/ateterka/intrack-automation"
  );
  assert.equal(
    normalizePortablePath("/run/desktop/mnt/host/c/Users/ateterka/.codex"),
    "c:/users/ateterka/.codex"
  );
  assert.equal(
    normalizePortablePath("C:\\Users\\ateterka\\intrack-automation"),
    "c:/users/ateterka/intrack-automation"
  );
});
