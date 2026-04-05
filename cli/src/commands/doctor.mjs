import path from "node:path";

import {
  emitObservedEvent,
  emitObservedStage,
  withObservedStage
} from "../../../runtime/observability.mjs";
import {
  fileExists,
  readTextFile
} from "../../../runtime/shared.mjs";
import { validateProjectManifest } from "../../../runtime/manifest-contract.mjs";

import {
  resolveBootstrapAgentForMode,
  resolveStoredAgentAuthPath
} from "../auth/foundations.mjs";
import {
  buildCachedMaterializedRuntime,
  detectGatewayPortState,
  dockerCommand,
  dockerCompose,
  findRunningTelegramTokenConflicts,
  gatewayRunning,
  openclawGatewayCommand,
  prepareMaterializedRuntimeState,
  prepareReadOnlyState,
  readSecretsFile,
  runContextCommand,
  shouldAutoHealGatewayPortConflict
} from "../command-runtime.mjs";
import { shouldManageGatewayPort } from "../instance-registry.mjs";
import { getAuthBootstrapProviderForMode } from "../plugin-config.mjs";
import { PRODUCT_NAME } from "../product-metadata.mjs";
import {
  buildDashboardUrl,
  buildStatusSection,
  printCommandReport,
  summarizeDoctorResults,
  summarizeOpenClawHealthPayload,
  summarizeOpenClawStatusPayload
} from "../ui/report-helpers.mjs";
import { parseJsonOutput } from "../utils/parse-utils.mjs";
import {
  normalizePortablePath,
  toHostPath
} from "../utils/path-utils.mjs";
import {
  handleUp,
  hasConfiguredTelegramBotToken
} from "./up.mjs";

function pushCheck(results, key, ok, detail, recovery = "", level = "error") {
  results.push({ key, ok, detail, recovery, level });
}

function buildObservabilityPayload(context, eventLogger) {
  return {
    eventLogFile: context.paths.eventLogFile,
    runId: eventLogger?.runId || "",
    correlationId: eventLogger?.correlationId || ""
  };
}

export async function handleDoctor(context, options) {
  const eventLogger = options.eventLogger?.child?.({ component: "cli" }) || null;
  let state = await withObservedStage(eventLogger, "state.prepare", "state.prepare", () => prepareReadOnlyState(context, options), {
    data: {
      refresh: Boolean(options.refresh)
    },
    buildSuccessData(nextState) {
      return {
        projectName: nextState.manifest.projectName,
        defaultAgent: nextState.manifest.acp.defaultAgent,
        refresh: Boolean(options.refresh)
      };
    }
  });
  let runtimeImages = state.runtimeImages || buildCachedMaterializedRuntime(state);
  const results = [];

  const dockerVersion = await runContextCommand(context, "docker", ["--version"]);
  pushCheck(
    results,
    "docker",
    dockerVersion.code === 0,
    dockerVersion.code === 0 ? dockerVersion.stdout.trim() || dockerVersion.stderr.trim() : "Docker CLI is not available.",
    dockerVersion.code === 0 ? "" : "Install Docker Desktop or Docker Engine and ensure `docker` is on PATH."
  );

  const composeVersion = await runContextCommand(context, "docker", ["compose", "version"]);
  pushCheck(
    results,
    "compose",
    composeVersion.code === 0,
    composeVersion.code === 0 ? composeVersion.stdout.trim() || composeVersion.stderr.trim() : "Docker Compose plugin is not available.",
    composeVersion.code === 0 ? "" : "Install the Docker Compose plugin or update Docker."
  );

  const localEnv = (await readSecretsFile(context)).values;
  const telegramToken = String(localEnv.TELEGRAM_BOT_TOKEN ?? "").trim();
  pushCheck(
    results,
    "telegram-token",
    hasConfiguredTelegramBotToken(telegramToken),
    hasConfiguredTelegramBotToken(telegramToken) ? "Telegram bot token is configured." : "Telegram bot token is missing.",
    hasConfiguredTelegramBotToken(telegramToken) ? "" : `Set TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`
  );

  const authProvider = getAuthBootstrapProviderForMode(state.manifest.security.authBootstrapMode);
  const bootstrapAgent = resolveBootstrapAgentForMode(state.manifest.security.authBootstrapMode, state.manifest.acp.defaultAgent);
  const authPath = authProvider
    ? resolveStoredAgentAuthPath(bootstrapAgent, state.detectedAuthPaths ?? {})
    : "";
  const authFilePath = authProvider && authPath
    ? path.join(toHostPath(authPath), authProvider.authFileName)
    : "";
  const authPathExists = authFilePath ? await fileExists(authFilePath) : false;
  const authOk = !authProvider
    || authPathExists;
  pushCheck(
    results,
    "auth",
    authOk,
    authOk
      ? "Provider subscription login is available on the host and will be mounted read-only into the runtime."
      : `${authProvider?.agentLabel || "Managed"} auth bootstrap is not ready.`,
    authOk
      ? ""
      : `Sign in with the host ${authProvider?.agentLabel || "managed"} CLI so ${PRODUCT_NAME} can mount ${authProvider?.authHomeDirName || authProvider?.authFileName || "credentials"} into the runtime.`
  );

  const runtimeSurfaceRoot = normalizePortablePath(path.join(context.repoRoot, ".openclaw"));
  const runtimeSurfaceOk = normalizePortablePath(context.paths.runtimeDir).startsWith(`${runtimeSurfaceRoot}/`)
    && normalizePortablePath(context.paths.playwrightDir).startsWith(`${runtimeSurfaceRoot}/`);
  pushCheck(
    results,
    "runtime-surface",
    runtimeSurfaceOk,
    runtimeSurfaceOk
      ? "Rendered runtime and Playwright files live under the repo-local .openclaw surface."
      : "Rendered runtime files are not repo-local.",
    runtimeSurfaceOk ? "" : "Re-run `openclaw-repo-agent update` to regenerate repo-local runtime files."
  );

  const composeSource = await readTextFile(context.paths.composeFile, "");
  const runtimeEnvSource = await readTextFile(context.paths.runtimeEnvFile, "");
  const providerHomeMountChecks = [
    {
      envKey: "OPENCLAW_CODEX_HOME_MOUNT_PATH",
      mountPattern: /\$\{OPENCLAW_CODEX_HOME_MOUNT_PATH\}:\$\{CODEX_HOME\}:ro/
    },
    {
      envKey: "OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH",
      mountPattern: /\$\{OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH\}:\$\{GEMINI_CLI_HOME\}:ro/
    },
    {
      envKey: "OPENCLAW_COPILOT_HOME_MOUNT_PATH",
      mountPattern: /\$\{OPENCLAW_COPILOT_HOME_MOUNT_PATH\}:\$\{COPILOT_HOME\}:ro/
    }
  ];
  const providerHomeMountsOk = providerHomeMountChecks.every(({ envKey, mountPattern }) => {
    const hasMountSource = new RegExp(`^${envKey}=.+$`, "m").test(runtimeEnvSource);
    return hasMountSource ? mountPattern.test(composeSource) : !mountPattern.test(composeSource);
  });
  const renderedIsolationOk = Boolean(composeSource)
    && /read_only:\s*true/.test(composeSource)
    && /\$\{TARGET_REPO_PATH\}:\/workspace:rw/.test(composeSource)
    && providerHomeMountsOk
    && !/auth-mirrors/.test(composeSource)
    && !/\/agent-auth/.test(composeSource)
    && !/:\/state:/.test(composeSource);
  pushCheck(
    results,
    "rendered-isolation",
    renderedIsolationOk,
    renderedIsolationOk
      ? "Rendered compose file uses a read-only rootfs and only workspace plus selected provider home binds."
      : "Rendered compose file does not match the isolation contract.",
    renderedIsolationOk ? "" : "Run `openclaw-repo-agent update` and inspect the rendered compose file."
  );

  const runtimeEnvContractOk = Boolean(runtimeEnvSource)
    && /OPENCLAW_RUNTIME_CORE_DIGEST=/.test(runtimeEnvSource)
    && /OPENCLAW_CODEX_HOME_MOUNT_PATH=/.test(runtimeEnvSource)
    && /OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH=/.test(runtimeEnvSource)
    && /OPENCLAW_COPILOT_HOME_MOUNT_PATH=/.test(runtimeEnvSource)
    && !/OPENCLAW_AUTH_MIRRORS_MOUNT_PATH=|TARGET_AUTH_PATH=|OPENCLAW_CODEX_AUTH_PATH=|OPENCLAW_GEMINI_AUTH_PATH=|OPENCLAW_COPILOT_AUTH_PATH=/.test(runtimeEnvSource);
  pushCheck(
    results,
    "runtime-env-contract",
    runtimeEnvContractOk,
    runtimeEnvContractOk
      ? "Runtime env uses digest traceability and direct provider-home mounts."
      : "Runtime env still exposes removed auth-mirror or auth-path variables.",
    runtimeEnvContractOk ? "" : "Re-render the runtime env and remove auth-path variables."
  );

  const manifestErrors = validateProjectManifest(state.manifest);
  pushCheck(
    results,
    "manifest",
    manifestErrors.length === 0,
    manifestErrors.length === 0 ? "Manifest rendered successfully." : manifestErrors.join("; "),
    manifestErrors.length === 0 ? "" : "Run `openclaw-repo-agent config validate` and fix the reported fields."
  );

  pushCheck(
    results,
    "runtime-image",
    true,
    `Runtime core ${runtimeImages.runtimeCoreImage}${runtimeImages.runtimeCoreDigest ? ` (${runtimeImages.runtimeCoreDigest})` : ""}; tooling image ${runtimeImages.toolingImage}.`,
    "Run `openclaw-repo-agent update` to refresh the runtime selection and rebuild the tooling layer."
  );

  let running = await gatewayRunning(context);
  const portStateBeforeFix = await detectGatewayPortState(context, state.localEnv);
  if (!portStateBeforeFix.ok && options.fix && (
    shouldManageGatewayPort(state.localEnv)
    || shouldAutoHealGatewayPortConflict(state.localEnv, portStateBeforeFix)
  )) {
    state = await prepareMaterializedRuntimeState(context, {
      ...options,
      reassignPort: true
    });
    runtimeImages = state.runtimeImages || buildCachedMaterializedRuntime(state);
  }
  const portState = await detectGatewayPortState(context, state.localEnv);
  pushCheck(
    results,
    "gateway-port",
    portState.ok,
    portState.message,
    portState.ok
      ? ""
      : (shouldManageGatewayPort(state.localEnv)
        ? "Run `openclaw-repo-agent doctor --fix` or `openclaw-repo-agent up --reassign-port`."
        : `Run \`${PRODUCT_NAME} up --reassign-port\` or \`${PRODUCT_NAME} doctor --fix\`.`)
  );

  const tokenConflicts = await findRunningTelegramTokenConflicts(context, state.localEnv);
  pushCheck(
    results,
    "telegram-token-uniqueness",
    tokenConflicts.length === 0,
    tokenConflicts.length === 0
      ? "Telegram bot token is unique among running repo instances."
      : `Telegram bot token is also in use by ${tokenConflicts.map((entry) => entry.instanceId).join(", ")}.`,
    tokenConflicts.length === 0 ? "" : "Use a separate TELEGRAM_BOT_TOKEN per repo instance."
  );

  if (!running && options.fix) {
    await handleUp(context, options);
    running = await gatewayRunning(context);
  }

  pushCheck(
    results,
    "gateway",
    running,
    running ? "OpenClaw gateway container is running." : "OpenClaw gateway is not running.",
    running ? "" : "Run `openclaw-repo-agent up` and retry."
  );

  if (running) {
    const status = await openclawGatewayCommand(context, ["status", "--json"], { capture: true });
    const statusPayload = status.code === 0 ? parseJsonOutput(status.stdout, null) : null;
    pushCheck(
      results,
      "openclaw-status",
      status.code === 0,
      status.code === 0
        ? summarizeOpenClawStatusPayload(statusPayload)
        : (status.stderr.trim() || status.stdout.trim() || "OpenClaw status failed."),
      status.code === 0 ? "" : "Inspect the gateway logs with `docker compose logs -f openclaw-gateway`."
    );

    const channelStatus = await openclawGatewayCommand(context, ["health", "--json"], { capture: true });
    const healthPayload = channelStatus.code === 0 ? parseJsonOutput(channelStatus.stdout, null) : null;
    pushCheck(
      results,
      "pairing",
      channelStatus.code === 0,
      channelStatus.code === 0
        ? summarizeOpenClawHealthPayload(healthPayload)
        : (channelStatus.stderr.trim() || channelStatus.stdout.trim() || "Telegram pairing/channel probe failed."),
      channelStatus.code === 0 ? "" : "Run `openclaw-repo-agent pair` after fixing token or network issues."
    );

    const inContainerDoctor = await dockerCompose(context, ["exec", "openclaw-gateway", "node", "/opt/openclaw/doctor.mjs", "--json"], { capture: true });
    pushCheck(
      results,
      "in-container-doctor",
      inContainerDoctor.code === 0,
      inContainerDoctor.code === 0 ? "In-container doctor checks passed." : (inContainerDoctor.stderr.trim() || inContainerDoctor.stdout.trim() || "In-container doctor failed."),
      inContainerDoctor.code === 0 ? "" : "Review the in-container doctor output and fix auth or render errors."
    );

    const workspaceAccess = await dockerCompose(context, ["exec", "openclaw-gateway", "sh", "-lc", "test -d /workspace"], { capture: true });
    pushCheck(
      results,
      "workspace-mount",
      workspaceAccess.code === 0,
      workspaceAccess.code === 0 ? "Workspace mount is readable." : "Workspace mount is not readable inside the container.",
      workspaceAccess.code === 0 ? "" : "Check TARGET_REPO_PATH in the rendered runtime env."
    );

    const containerIdResult = await dockerCompose(context, ["ps", "-q", "openclaw-gateway"], { capture: true });
    const containerId = containerIdResult.code === 0 ? String(containerIdResult.stdout ?? "").trim() : "";
    if (containerId) {
      const inspectResult = await dockerCommand(context, ["inspect", containerId], { capture: true });
      const inspectPayload = inspectResult.code === 0 ? parseJsonOutput(inspectResult.stdout, []) : [];
      const containerInfo = Array.isArray(inspectPayload) ? inspectPayload[0] ?? null : null;
      const mounts = Array.isArray(containerInfo?.Mounts) ? containerInfo.Mounts : [];
      const allowedBindSources = new Set([
        normalizePortablePath(context.repoRoot),
        ...Object.values(context.paths.providerHomes ?? {})
          .map((homePath) => String(homePath ?? "").trim())
          .filter(Boolean)
          .map((homePath) => normalizePortablePath(homePath))
      ]);
      const disallowedBindMounts = mounts.filter((mount) =>
        String(mount?.Type ?? "").trim().toLowerCase() === "bind"
        && !allowedBindSources.has(normalizePortablePath(mount?.Source))
      );
      const readonlyRootfs = containerInfo?.HostConfig?.ReadonlyRootfs === true;
      pushCheck(
        results,
        "runtime-mount-boundary",
        readonlyRootfs && disallowedBindMounts.length === 0,
        readonlyRootfs && disallowedBindMounts.length === 0
          ? "Running container mount boundary matches the isolation contract."
          : `Running container isolation drift detected${disallowedBindMounts.length > 0 ? `: ${disallowedBindMounts.map((mount) => mount.Source).join(", ")}` : ""}.`,
        readonlyRootfs && disallowedBindMounts.length === 0
          ? ""
          : "Restart the stack after regenerating the runtime files; only the workspace and selected provider home roots should be bind-mounted."
      );
    }
  }

  const ok = results.every((result) => result.ok || result.level !== "error");
  const summary = summarizeDoctorResults(results);
  for (const result of results) {
    await emitObservedStage(eventLogger, "doctor.check", "doctor.check.completed", {
      data: result
    });
  }
  await emitObservedEvent(eventLogger, "doctor.summary", {
    data: {
      ok,
      ...summary
    }
  });
  if (options.json) {
    console.log(JSON.stringify({
      ok,
      runtime: {
        runtimeCoreImage: runtimeImages.runtimeCoreImage,
        runtimeCoreDigest: runtimeImages.runtimeCoreDigest,
        toolingImage: runtimeImages.toolingImage,
        coreProvenance: runtimeImages.coreProvenance
      },
      observability: buildObservabilityPayload(context, eventLogger),
      results
    }, null, 2));
  } else {
    printCommandReport(ok ? "success" : "warning", "Doctor", [
      { label: "Repo", value: context.repoRoot },
      { label: "Result", value: ok ? "ready" : "needs attention" },
      { label: "Checks", value: `${summary.ok} ok, ${summary.info} info, ${summary.warn} warn, ${summary.fail} fail` },
      { label: "Gateway", value: running ? buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) : "stopped" }
    ], [
      buildStatusSection("Checks", "info", results.map((result) => ({
        status: result.ok ? "success" : result.level,
        text: `${result.key}: ${result.detail}${!result.ok && result.recovery ? ` Next: ${result.recovery}` : ""}`
      })))
    ].filter(Boolean));
  }

  if (!ok) process.exitCode = 1;
}
