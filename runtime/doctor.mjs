import { probeAuth } from "./bootstrap-auth.mjs";
import { buildManifestFromEnv, buildManifestStatus, validateProjectManifest } from "./manifest-contract.mjs";
import {
  createProcessEventLogger,
  emitObservedEvent
} from "./observability.mjs";
import { readJsonFile } from "./shared.mjs";

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const renderStatusPath = process.env.OPENCLAW_RENDER_STATUS_PATH?.trim() || "/workspace/.openclaw/runtime/render-status.json";
  const eventLogger = createProcessEventLogger(process.env, {
    component: "runtime.doctor"
  });

  await emitObservedEvent(eventLogger, "runtime.doctor.started", {
    data: {
      renderStatusPath
    }
  });

  const manifest = buildManifestFromEnv(process.env);
  const manifestErrors = validateProjectManifest(manifest);
  const renderStatus = await readJsonFile(renderStatusPath, null);
  const auth = await probeAuth({ probeOnly: true });

  const observability = eventLogger
    ? {
        eventLogFile: process.env.OPENCLAW_EVENT_LOG_FILE?.trim() || "",
        runId: eventLogger.runId,
        correlationId: eventLogger.correlationId
      }
    : null;
  const report = {
    ok: manifestErrors.length === 0 && Boolean(renderStatus?.ok) && auth.ok,
    manifest: buildManifestStatus(manifest, manifestErrors),
    renderStatus,
    auth,
    ...(observability ? { observability } : {})
  };

  await emitObservedEvent(eventLogger, "runtime.doctor.finished", {
    data: {
      ok: report.ok,
      manifestValid: manifestErrors.length === 0,
      renderReady: Boolean(renderStatus?.ok),
      authReady: auth.ok
    }
  });

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
  const eventLogger = createProcessEventLogger(process.env, {
    component: "runtime.doctor"
  });
  emitObservedEvent(eventLogger, "runtime.doctor.failed", {
    level: "error",
    error
  }).catch(() => {});
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
