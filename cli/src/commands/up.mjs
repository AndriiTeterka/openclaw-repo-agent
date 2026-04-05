import https from "node:https";
import chalk from "chalk";

import {
  emitObservedStage,
  withObservedStage
} from "../../../runtime/observability.mjs";
import {
  buildComposeUpArgs,
  detectGatewayPortState,
  dockerCompose,
  findRunningTelegramTokenConflicts,
  gatewayHealthy,
  openclawGatewayCommand,
  prepareMaterializedRuntimeState,
  runWithSpinner,
  shouldAutoHealGatewayPortConflict
} from "../command-runtime.mjs";
import { PRODUCT_NAME } from "../product-metadata.mjs";
import {
  buildDashboardUrl,
  extractDashboardUrl,
  printCommandReport,
  summarizeCommandFailure
} from "../ui/report-helpers.mjs";
import { parseJsonOutput } from "../utils/parse-utils.mjs";

function isPlaceholderTelegramBotToken(value) {
  return String(value ?? "").trim().startsWith("replace-with-");
}

export function hasConfiguredTelegramBotToken(value) {
  const token = String(value ?? "").trim();
  return Boolean(token) && !isPlaceholderTelegramBotToken(token);
}

export function looksLikeTelegramBotToken(value) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(value ?? "").trim());
}

export function classifyTelegramBotProbeResult(statusCode, payload = null) {
  const description = String(payload?.description ?? "").trim();
  if (statusCode === 200 && payload?.ok === true) {
    return {
      ok: true,
      definitiveFailure: false,
      detail: description
    };
  }

  const definitiveFailure = statusCode === 401
    || statusCode === 404
    || (payload?.ok === false && /unauthorized|not found|invalid|wrong token|bot token/i.test(description));

  return {
    ok: false,
    definitiveFailure,
    detail: description || (statusCode > 0 ? `HTTP ${statusCode}` : "")
  };
}

const COMPOSE_UP_RETRY_DELAY_MS = 5000;
const COMPOSE_UP_MAX_ATTEMPTS = 2;

export function shouldRetryComposeUpFailure(result = {}) {
  const lines = [result?.stderr, result?.stdout]
    .flatMap((value) => String(value ?? "").split(/\r?\n/g))
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.some((line) =>
    /^Network .+\bCreating\b/i.test(line)
    || /^Container .+\b(Creating|Recreate|Starting)\b/i.test(line)
    || /context canceled/i.test(line)
    || /deadline exceeded/i.test(line)
    || /timed out waiting for/i.test(line)
  );
}

export async function probeTelegramBotToken(token) {
  return await new Promise((resolve) => {
    const request = https.get(`https://api.telegram.org/bot${token}/getMe`, {
      timeout: 5000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const payload = parseJsonOutput(body, null);
        resolve({
          statusCode: response.statusCode ?? 0,
          payload,
          ...classifyTelegramBotProbeResult(response.statusCode ?? 0, payload)
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Telegram Bot API probe timed out."));
    });

    request.on("error", (error) => {
      resolve({
        statusCode: 0,
        payload: null,
        ok: false,
        definitiveFailure: false,
        detail: error.message
      });
    });
  });
}

async function ensureTelegramBotTokenReady(context, state) {
  if (!state.manifest.telegram.enabled) {
    return {
      enabled: false,
      configured: false,
      validated: false
    };
  }

  const token = String(state.localEnv.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!hasConfiguredTelegramBotToken(token)) {
    throw new Error(`Telegram bot token is missing. Set TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }
  if (!looksLikeTelegramBotToken(token)) {
    throw new Error(`Telegram bot token format looks invalid. Update TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }

  const probe = await probeTelegramBotToken(token);
  if (probe.definitiveFailure) {
    throw new Error(`Telegram bot token was rejected by the Telegram Bot API${probe.detail ? ` (${probe.detail})` : ""}. Update TELEGRAM_BOT_TOKEN in ${context.paths.secretsEnvFile}.`);
  }

  return {
    enabled: true,
    configured: true,
    validated: true,
    probe: {
      ok: probe.ok,
      definitiveFailure: probe.definitiveFailure,
      statusCode: probe.statusCode,
      detail: probe.detail
    }
  };
}

async function resolveDashboardUrl(context, localEnv = {}) {
  const gatewayPort = String(localEnv.OPENCLAW_GATEWAY_PORT ?? "").trim();
  const gatewayToken = String(localEnv.OPENCLAW_GATEWAY_TOKEN ?? "").trim();
  if (gatewayPort) return buildDashboardUrl(gatewayPort, gatewayToken);

  const result = await openclawGatewayCommand(context, ["dashboard", "--no-open"], { capture: true });
  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw dashboard --no-open",
      result,
      "Failed to resolve the dashboard URL."
    ));
  }

  const dashboardUrl = extractDashboardUrl([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (!dashboardUrl) {
    throw new Error("Failed to resolve the dashboard URL.");
  }
  return dashboardUrl;
}

async function startComposeStack(context, options = {}) {
  const args = buildComposeUpArgs();
  let lastResult = null;
  let retried = false;
  const commandEnv = options.env ? { ...process.env, ...options.env } : undefined;

  for (let attempt = 1; attempt <= COMPOSE_UP_MAX_ATTEMPTS; attempt += 1) {
    const result = await dockerCompose(context, args, {
      capture: true,
      timeoutMs: options.timeoutMs,
      env: commandEnv
    });
    if (result.code === 0) {
      return {
        attempts: attempt,
        retried,
        healthyFallback: false
      };
    }

    lastResult = result;
    if (await gatewayHealthy(context)) {
      return {
        attempts: attempt,
        retried,
        healthyFallback: true
      };
    }
    if (attempt >= COMPOSE_UP_MAX_ATTEMPTS || !shouldRetryComposeUpFailure(result)) break;
    retried = true;
    await new Promise((resolve) => setTimeout(resolve, COMPOSE_UP_RETRY_DELAY_MS));
  }

  if (await gatewayHealthy(context)) {
    return {
      attempts: COMPOSE_UP_MAX_ATTEMPTS,
      retried,
      healthyFallback: true
    };
  }
  throw new Error(summarizeCommandFailure(
    `docker compose ${args.join(" ")}`,
    lastResult,
    `Failed to run docker compose ${args.join(" ")}.`
  ));
}

export async function handleUp(context, options) {
  const eventLogger = options.eventLogger?.child?.({ component: "cli" }) || null;
  let state = await runWithSpinner(
    "Resolving runtime state",
    () => withObservedStage(eventLogger, "state.prepare", "state.prepare", () => prepareMaterializedRuntimeState(context, options), {
      buildSuccessData(nextState) {
        return {
          gatewayPort: nextState.localEnv.OPENCLAW_GATEWAY_PORT,
          runtimeCoreImage: nextState.runtimeImages.runtimeCoreImage,
          runtimeCoreDigest: nextState.runtimeImages.runtimeCoreDigest,
          toolingImage: nextState.runtimeImages.toolingImage
        };
      }
    }),
    options
  );

  let portState = await detectGatewayPortState(context, state.localEnv);
  await emitObservedStage(eventLogger, "gateway.port", "gateway.port.checked", {
    data: {
      ok: portState.ok,
      message: portState.message,
      reassignPort: Boolean(options.reassignPort)
    }
  });
  if (!portState.ok && shouldAutoHealGatewayPortConflict(state.localEnv, portState)) {
    state = await runWithSpinner(
      "Healing stale gateway port assignment",
      () => withObservedStage(eventLogger, "state.prepare", "state.prepare", () => prepareMaterializedRuntimeState(context, {
        ...options,
        reassignPort: true
      }), {
        buildSuccessData(nextState) {
          return {
            gatewayPort: nextState.localEnv.OPENCLAW_GATEWAY_PORT,
            runtimeCoreImage: nextState.runtimeImages.runtimeCoreImage,
            runtimeCoreDigest: nextState.runtimeImages.runtimeCoreDigest,
            toolingImage: nextState.runtimeImages.toolingImage,
            reassignPort: true
          };
        }
      }),
      options
    );
    portState = await detectGatewayPortState(context, state.localEnv);
    await emitObservedStage(eventLogger, "gateway.port", "gateway.port.checked", {
      data: {
        ok: portState.ok,
        message: portState.message,
        reassignPort: true
      }
    });
  }
  if (!portState.ok) {
    throw new Error(`${portState.message} Run \`${PRODUCT_NAME} up --reassign-port\` or \`${PRODUCT_NAME} doctor --fix\`.`);
  }
  const runningTokenConflicts = await findRunningTelegramTokenConflicts(context, state.localEnv);
  if (runningTokenConflicts.length > 0) {
    const details = runningTokenConflicts
      .map((entry) => `${entry.instanceId} (${entry.repoRoot})`)
      .join(", ");
    throw new Error(`Telegram bot token is already in use by another running repo instance: ${details}. Use a separate bot token per repo.`);
  }
  await runWithSpinner(
    "Validating Telegram bot token",
    () => withObservedStage(eventLogger, "telegram.validate", "telegram.validate", () => ensureTelegramBotTokenReady(context, state), {
      buildSuccessData(result) {
        return result;
      }
    }),
    options
  );
  await runWithSpinner(
    "Starting OpenClaw stack",
    () => withObservedStage(eventLogger, "compose.start", "compose.start", () => startComposeStack(context, {
      ...options,
      env: state.runtimeCommandEnv
    }), {
      buildSuccessData(result) {
        return result;
      }
    }),
    options
  );

  const dashboardUrl = await runWithSpinner(
    "Resolving dashboard URL",
    () => withObservedStage(eventLogger, "dashboard.resolve", "dashboard.resolve", () => resolveDashboardUrl(context, state.localEnv), {
      buildSuccessData(url) {
        return {
          dashboardUrl: url
        };
      }
    }),
    options
  );
  printCommandReport("success", "Up complete", [
    { label: "Repo", value: context.repoRoot },
    { label: "Dashboard", value: dashboardUrl },
    { label: "Deployment", value: state.manifest.deploymentProfile },
    { label: "Runtime core", value: state.runtimeImages.runtimeCoreDigest || state.runtimeImages.runtimeCoreImage },
    { label: "Tooling image", value: state.runtimeImages.toolingImage }
  ]);
}
