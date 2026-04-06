import {
  buildManifestFromEnv,
  buildManifestStatus,
  buildOpenClawConfig,
  validateProjectManifest,
} from "./manifest-contract.mjs";
import {
  diffObjectPaths,
  isPlainObject,
  parseStringArrayEnv,
  readJsonFile,
  uniqueStrings,
  writeJsonFileAtomic,
} from "./shared.mjs";
import {
  createProcessEventLogger,
  emitObservedEvent
} from "./observability.mjs";
import {
  modelProviderPrefix,
  resolveDefaultModelProvider,
  shouldPreserveConfiguredModelRef,
} from "./model-catalog.mjs";

function parseArgs(argv) {
  return {
    checkOnly: argv.includes("--check"),
    json: argv.includes("--json"),
  };
}

function validateRenderedConfig(config) {
  const errors = [];
  if (!config?.agents?.list?.length) errors.push("rendered config must contain at least one agent");
  if (!config?.channels?.telegram) errors.push("rendered config must define channels.telegram");
  if (!config?.acp?.backend) errors.push("rendered config must define acp.backend");
  if (!config?.hooks?.internal?.entries) errors.push("rendered config must define internal hooks");
  return errors;
}

function mergePreservedAllowedProviderModels({ currentConfig, nextConfig, manifest, env }) {
  const currentModels = isPlainObject(currentConfig?.agents?.defaults?.models)
    ? currentConfig.agents.defaults.models
    : {};
  const nextModels = isPlainObject(nextConfig?.agents?.defaults?.models)
    ? { ...nextConfig.agents.defaults.models }
    : {};
  if (Object.keys(currentModels).length === 0) return nextConfig;

  const authBootstrapMode = String(env?.OPENCLAW_BOOTSTRAP_AUTH_MODE ?? manifest?.security?.authBootstrapMode ?? "").trim();
  const defaultAgent = String(env?.OPENCLAW_ACP_DEFAULT_AGENT ?? manifest?.acp?.defaultAgent ?? "").trim();
  const allowedAgents = uniqueStrings([
    defaultAgent,
    ...parseStringArrayEnv(env?.OPENCLAW_ACP_ALLOWED_AGENTS, manifest?.acp?.allowedAgents ?? []),
  ]);
  const allowedProviders = new Set(
    allowedAgents
      .map((agentId) => resolveDefaultModelProvider({
        defaultAgent: agentId,
        authMode: agentId === defaultAgent ? authBootstrapMode : agentId,
        env,
      }))
      .filter(Boolean),
  );
  if (allowedProviders.size === 0) return nextConfig;

  let changed = false;
  for (const [modelRef, entry] of Object.entries(currentModels)) {
    if (!shouldPreserveConfiguredModelRef(modelRef)) continue;
    if (!allowedProviders.has(modelProviderPrefix(modelRef))) continue;
    if (Object.hasOwn(nextModels, modelRef)) continue;
    nextModels[modelRef] = isPlainObject(entry) ? entry : {};
    changed = true;
  }

  if (!changed) return nextConfig;
  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        models: nextModels,
      },
    },
  };
}

function buildStatus({
  manifestStatus,
  manifestPath,
  configPath,
  previousConfig,
  nextConfig,
  renderErrors,
  validationErrors,
  checkOnly,
  observability,
}) {
  const configDiffPaths = previousConfig && nextConfig
    ? diffObjectPaths(previousConfig, nextConfig).slice(0, 25)
    : nextConfig
      ? ["$"]
      : [];

  return {
    ok: validationErrors.length === 0 && renderErrors.length === 0,
    checkOnly,
    manifestPath,
    configPath,
    updatedAt: new Date().toISOString(),
    manifest: manifestStatus,
    validationErrors,
    renderErrors,
    usingLastGoodConfig: validationErrors.length > 0 || renderErrors.length > 0,
    changed: configDiffPaths.length > 0,
    configDiffPaths,
    ...(observability ? { observability } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = process.env.OPENCLAW_RENDERED_CONFIG_PATH?.trim() || "/home/node/.openclaw/openclaw.json";
  const renderStatusPath = process.env.OPENCLAW_RENDER_STATUS_PATH?.trim() || "/workspace/.openclaw/runtime/render-status.json";
  const manifestPath = "(env)";
  const eventLogger = createProcessEventLogger(process.env, {
    component: "runtime.render",
    defaults: {
      checkOnly: args.checkOnly
    }
  });
  const observability = eventLogger
    ? {
        eventLogFile: process.env.OPENCLAW_EVENT_LOG_FILE?.trim() || "",
        runId: eventLogger.runId,
        correlationId: eventLogger.correlationId
      }
    : null;

  await emitObservedEvent(eventLogger, "render.config.started", {
    data: {
      checkOnly: args.checkOnly,
      configPath,
      renderStatusPath
    }
  });

  const manifest = buildManifestFromEnv(process.env);
  const validationErrors = validateProjectManifest(manifest);
  const manifestStatus = buildManifestStatus(manifest, validationErrors);
  const currentConfig = await readJsonFile(configPath, null);

  if (validationErrors.length > 0) {
    const status = buildStatus({
      manifestStatus,
      manifestPath,
      configPath,
      previousConfig: currentConfig,
      nextConfig: null,
      renderErrors: [],
      validationErrors,
      checkOnly: args.checkOnly,
      observability,
    });
    await writeJsonFileAtomic(renderStatusPath, status);
    await emitObservedEvent(eventLogger, "render.config.validation-failed", {
      level: "error",
      data: {
        checkOnly: args.checkOnly,
        validationErrors,
        usingLastGoodConfig: Boolean(currentConfig)
      }
    });
    if (args.json) console.log(JSON.stringify(status, null, 2));
    if (!currentConfig) {
      throw new Error(`Project manifest validation failed: ${validationErrors.join("; ")}`);
    }
    if (args.checkOnly) process.exit(1);
    console.error(`Project manifest validation failed; keeping last good config at ${configPath}.`);
    return;
  }

  const { config: renderedConfig } = buildOpenClawConfig(manifest, process.env);
  const nextConfig = mergePreservedAllowedProviderModels({
    currentConfig,
    nextConfig: renderedConfig,
    manifest,
    env: process.env,
  });
  const baselineConfig = await readJsonFile("/workspace/.openclaw/runtime/host-baseline.json", null).catch(() => null);
  if (baselineConfig) {
    if (baselineConfig.mcp && Object.keys(baselineConfig.mcp.servers || {}).length > 0) {
      nextConfig.mcp = nextConfig.mcp || { servers: {} };
      Object.assign(nextConfig.mcp.servers, baselineConfig.mcp.servers);
    }
    if (baselineConfig.plugins && Object.keys(baselineConfig.plugins.entries || {}).length > 0) {
      nextConfig.plugins = nextConfig.plugins || { entries: {} };
      for (const [k, v] of Object.entries(baselineConfig.plugins.entries)) {
         if (!nextConfig.plugins.entries[k]) nextConfig.plugins.entries[k] = v;
         else { Object.assign(nextConfig.plugins.entries[k], v); }
      }
    }
    if (baselineConfig.agents && baselineConfig.agents.defaults) {
      nextConfig.agents.defaults = nextConfig.agents.defaults || {};
      Object.assign(nextConfig.agents.defaults, baselineConfig.agents.defaults);
    }
  }
  const renderErrors = validateRenderedConfig(nextConfig);
  const status = buildStatus({
    manifestStatus,
    manifestPath,
    configPath,
    previousConfig: currentConfig,
    nextConfig,
    renderErrors,
    validationErrors: [],
    checkOnly: args.checkOnly,
    observability,
  });

  if (renderErrors.length > 0) {
    await writeJsonFileAtomic(renderStatusPath, status);
    await emitObservedEvent(eventLogger, "render.config.render-failed", {
      level: "error",
      data: {
        checkOnly: args.checkOnly,
        renderErrors,
        usingLastGoodConfig: Boolean(currentConfig)
      }
    });
    if (args.json) console.log(JSON.stringify(status, null, 2));
    if (!currentConfig) {
      throw new Error(`Rendered OpenClaw config failed validation: ${renderErrors.join("; ")}`);
    }
    if (args.checkOnly) process.exit(1);
    console.error(`Rendered OpenClaw config failed validation; keeping last good config at ${configPath}.`);
    return;
  }

  if (!args.checkOnly && status.changed) {
    await writeJsonFileAtomic(configPath, nextConfig);
  }

  await writeJsonFileAtomic(renderStatusPath, status);
  await emitObservedEvent(eventLogger, "render.config.finished", {
    data: {
      changed: status.changed,
      checkOnly: args.checkOnly,
      configDiffPaths: status.configDiffPaths
    }
  });
  if (args.json) console.log(JSON.stringify(status, null, 2));
  console.error(
    status.changed
      ? `Rendered OpenClaw config at ${configPath}.`
      : `OpenClaw config at ${configPath} is already up to date.`,
  );
}

main().catch((error) => {
  const eventLogger = createProcessEventLogger(process.env, {
    component: "runtime.render"
  });
  emitObservedEvent(eventLogger, "render.config.failed", {
    level: "error",
    error
  }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
