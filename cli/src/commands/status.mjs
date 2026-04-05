import https from "node:https";

import {
  buildCachedMaterializedRuntime,
  gatewayRunning,
  prepareReadOnlyState
} from "../command-runtime.mjs";
import { shouldManageGatewayPort } from "../instance-registry.mjs";
import {
  PRODUCT_NAME,
  PRODUCT_VERSION
} from "../product-metadata.mjs";
import { toDisplayPath } from "../state-layout.mjs";
import {
  buildDashboardUrl,
  buildStatusSection,
  printCommandReport
} from "../ui/report-helpers.mjs";

function compareVersions(left, right) {
  const leftParts = String(left ?? "").replace(/^v/i, "").split(".").map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = String(right ?? "").replace(/^v/i, "").split(".").map((value) => Number.parseInt(value, 10) || 0);
  const size = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < size; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
async function checkLatestPackageVersion(packageName) {
  return await new Promise((resolve) => {
    const request = https.get(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: {
        "User-Agent": PRODUCT_NAME,
        Accept: "application/json"
      },
      timeout: 3000
    }, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        response.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(String(payload.version ?? "").replace(/^v/i, "") || null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

export async function handleStatus(context, options) {
  const state = await prepareReadOnlyState(context, options);
  const runtimeImages = state.runtimeImages || buildCachedMaterializedRuntime(state);
  const packageName = process.env.NPM_PACKAGE_NAME || PRODUCT_NAME;
  const latestVersion = options.checkUpdates ? await checkLatestPackageVersion(packageName) : null;
  const updateStatus = latestVersion
    ? compareVersions(latestVersion, PRODUCT_VERSION) > 0
      ? `update available (${latestVersion})`
      : "current"
    : "unknown";
  const running = await gatewayRunning(context);
  const payload = {
    productVersion: PRODUCT_VERSION,
    latestVersion,
    updateStatus,
    running,
    instance: {
      instanceId: context.instanceId,
      composeProjectName: context.composeProjectName,
      gatewayPort: state.localEnv.OPENCLAW_GATEWAY_PORT,
      portManaged: shouldManageGatewayPort(state.localEnv)
    },
    manifest: {
      projectName: state.manifest.projectName,
      deploymentProfile: state.manifest.deploymentProfile,
      toolingProfiles: state.manifest.toolingProfiles,
      stack: state.manifest.stack,
      runtimeProfile: state.manifest.runtimeProfile,
      queueProfile: state.manifest.queueProfile,
      authMode: state.manifest.security.authBootstrapMode
    },
    runtime: {
      configPrepared: true,
      runtimeCoreImage: runtimeImages.runtimeCoreImage,
      runtimeCoreDigest: runtimeImages.runtimeCoreDigest,
      toolingImage: runtimeImages.toolingImage,
      coreProvenance: runtimeImages.coreProvenance,
      runtimeDir: context.paths.runtimeDir,
      playwrightDir: context.paths.playwrightDir
    }
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printCommandReport("success", "Status", [
      { label: "Version", value: PRODUCT_VERSION },
      { label: "Update", value: updateStatus },
      { label: "Repo", value: context.repoRoot },
      { label: "Gateway", value: running ? buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) : "stopped" },
      { label: "Profiles", value: `${state.manifest.deploymentProfile} / ${state.manifest.runtimeProfile} / ${state.manifest.queueProfile}` },
      { label: "Auth", value: state.manifest.security.authBootstrapMode },
      { label: "Runtime core", value: runtimeImages.runtimeCoreDigest || runtimeImages.runtimeCoreImage }
    ], [
      buildStatusSection("Tooling", "info", [
        `Profiles: ${state.manifest.toolingProfiles.length > 0 ? state.manifest.toolingProfiles.join(", ") : "none"}`,
        `Languages: ${state.manifest.stack.languages.length > 0 ? state.manifest.stack.languages.join(", ") : "none"}`,
        `Tools: ${state.manifest.stack.tools.length > 0 ? state.manifest.stack.tools.join(", ") : "none"}`,
        `Runtime surface: ${toDisplayPath(context.repoRoot, context.paths.runtimeDir)}`,
        `Playwright surface: ${toDisplayPath(context.repoRoot, context.paths.playwrightDir)}`,
        `Local tooling image: ${runtimeImages.toolingImage}`
      ])
    ].filter(Boolean));
  }
}
