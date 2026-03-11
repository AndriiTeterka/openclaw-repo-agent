import { probeAuth } from "./bootstrap-auth.mjs";
import { buildManifestStatus, normalizeProjectManifest, validateProjectManifest } from "./manifest-contract.mjs";
import { readJsonFile } from "./shared.mjs";

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = process.env.OPENCLAW_PROJECT_MANIFEST?.trim() || "/config/project-manifest.json";
  const renderStatusPath = process.env.OPENCLAW_RENDER_STATUS_PATH?.trim() || "/home/node/.openclaw/runtime/render-status.json";

  const rawManifest = await readJsonFile(manifestPath, {});
  const manifest = normalizeProjectManifest(rawManifest, {
    hostPlatform: process.env.OPENCLAW_HOST_PLATFORM,
  });
  const manifestErrors = validateProjectManifest(manifest);
  const renderStatus = await readJsonFile(renderStatusPath, null);
  const auth = await probeAuth({ probeOnly: true });

  const report = {
    ok: manifestErrors.length === 0 && Boolean(renderStatus?.ok) && auth.ok,
    manifest: buildManifestStatus(manifest, manifestErrors),
    renderStatus,
    auth,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Manifest: ${manifest.projectName} (${manifest.runtimeProfile}/${manifest.deploymentProfile})`);
    console.log(`Manifest validation: ${manifestErrors.length === 0 ? "ok" : manifestErrors.join("; ")}`);
    console.log(`Render status: ${renderStatus?.ok ? "ok" : "not ready"}`);
    if (renderStatus?.configDiffPaths?.length) {
      console.log(`Recent config diff paths: ${renderStatus.configDiffPaths.join(", ")}`);
    }
    console.log(`Auth: ${auth.ok ? "ok" : "not ready"} (${auth.mode})`);
    console.log(auth.detail);
    if (auth.recovery) console.log(auth.recovery);
  }

  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
