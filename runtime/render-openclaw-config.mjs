import {
  buildManifestStatus,
  buildOpenClawConfig,
  normalizeProjectManifest,
  validateProjectManifest,
} from "./manifest-contract.mjs";
import {
  diffObjectPaths,
  readJsonFile,
  writeJsonFileAtomic,
} from "./shared.mjs";

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

function buildStatus({
  manifestStatus,
  manifestPath,
  configPath,
  previousConfig,
  nextConfig,
  renderErrors,
  validationErrors,
  checkOnly,
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
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = process.env.OPENCLAW_PROJECT_MANIFEST?.trim() || "/config/project-manifest.json";
  const configPath = process.env.OPENCLAW_RENDERED_CONFIG_PATH?.trim() || "/home/node/.openclaw/openclaw.json";
  const renderStatusPath = process.env.OPENCLAW_RENDER_STATUS_PATH?.trim() || "/home/node/.openclaw/runtime/render-status.json";

  const rawManifest = await readJsonFile(manifestPath, {});
  const manifest = normalizeProjectManifest(rawManifest, {
    hostPlatform: process.env.OPENCLAW_HOST_PLATFORM,
  });
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
    });
    await writeJsonFileAtomic(renderStatusPath, status);
    if (args.json) console.log(JSON.stringify(status, null, 2));
    if (!currentConfig) {
      throw new Error(`Project manifest validation failed: ${validationErrors.join("; ")}`);
    }
    if (args.checkOnly) process.exit(1);
    console.error(`Project manifest validation failed; keeping last good config at ${configPath}.`);
    return;
  }

  const { config: nextConfig } = buildOpenClawConfig(manifest, process.env);
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
  });

  if (renderErrors.length > 0) {
    await writeJsonFileAtomic(renderStatusPath, status);
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
  if (args.json) console.log(JSON.stringify(status, null, 2));
  console.error(
    status.changed
      ? `Rendered OpenClaw config at ${configPath}.`
      : `OpenClaw config at ${configPath} is already up to date.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
