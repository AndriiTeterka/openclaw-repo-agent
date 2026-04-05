import { readJsonFile } from "../../../runtime/shared.mjs";
import { validateProjectManifest } from "../../../runtime/manifest-contract.mjs";

import {
  detectDefaultAuthPaths,
  resolveEffectiveAllowedAgents
} from "../auth/foundations.mjs";
import {
  buildEffectiveManifest,
  readSecretsFile
} from "../command-runtime.mjs";
import { normalizePluginConfig } from "../plugin-config.mjs";
import { PRODUCT_VERSION } from "../product-metadata.mjs";
import {
  buildStatusSection,
  printCommandReport
} from "../ui/report-helpers.mjs";

export async function handleConfigValidate(context, options) {
  const pluginRaw = await readJsonFile(context.paths.configFile, null);
  if (!pluginRaw) throw new Error(`Missing ${context.paths.configFile}`);
  const plugin = normalizePluginConfig(pluginRaw, context.repoRoot, context.detection, options);
  const localEnv = (await readSecretsFile(context)).values;
  const detectedAuthPaths = await detectDefaultAuthPaths();
  const effectiveAllowedAgents = resolveEffectiveAllowedAgents(pluginRaw, plugin, localEnv, options, detectedAuthPaths);
  const manifest = buildEffectiveManifest(plugin, context.repoRoot, localEnv, {
    ...options,
    acpAllowedAgent: effectiveAllowedAgents,
  });
  const errors = validateProjectManifest(manifest);
  const payload = {
    ok: errors.length === 0,
    productVersion: PRODUCT_VERSION,
    plugin,
    manifest,
    errors
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printCommandReport(errors.length === 0 ? "success" : "error", "Configuration validation", [
      { label: "Project", value: plugin.projectName },
      { label: "Deployment", value: plugin.deploymentProfile },
      { label: "Validation", value: errors.length === 0 ? "ok" : "failed" }
    ], [
      buildStatusSection("Errors", "error", errors)
    ].filter(Boolean));
  }

  if (errors.length > 0) process.exitCode = 1;
}
