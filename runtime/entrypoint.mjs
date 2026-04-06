import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { normalizeCopilotCliToken, resolveCopilotCliTokenFromSources } from "./copilot-auth-token.mjs";
import {
  createProcessEventLogger,
  emitObservedEvent,
  withObservedStage
} from "./observability.mjs";
import {
  COPILOT_TOKEN_EXCHANGE_URL as SHARED_COPILOT_TOKEN_EXCHANGE_URL,
  resolveCopilotRuntimeAuth,
} from "./copilot-runtime-auth.mjs";
import { ensureDir, fileExists, safeRunCommand } from "./shared.mjs";

const HOME_DIR = process.env.HOME || "/home/node";
const RUNTIME_HOME = path.join(HOME_DIR, ".openclaw");
const RUNTIME_DIR = path.join(RUNTIME_HOME, "runtime");
const GRADLE_HOME = path.join(HOME_DIR, ".gradle-openclaw");
const BOOTSTRAP_AUTH_SCRIPT = "/opt/openclaw/bootstrap-auth.mjs";
const RENDER_CONFIG_SCRIPT = "/opt/openclaw/render-openclaw-config.mjs";
const LOCAL_ACPX_MANIFEST = path.join(HOME_DIR, ".openclaw", "extensions", "acpx", "openclaw.plugin.json");
const BUNDLED_ACPX_DIR = "/app/extensions/acpx";
const BUNDLED_ACPX_MANIFEST = "/app/extensions/acpx/openclaw.plugin.json";
const BUNDLED_ACPX_NODE_MODULES_DIR = path.join(BUNDLED_ACPX_DIR, "node_modules");
const GLOBAL_ACPX_COMMAND = "/usr/local/bin/acpx";
const GLOBAL_ACPX_EXPECTED_VERSION = "0.3.1";
const COPILOT_TOKEN_EXCHANGE_URL = SHARED_COPILOT_TOKEN_EXCHANGE_URL;
const STARTUP_RENDER_ENV_OVERRIDES = Object.freeze({
  OPENCLAW_MODEL_DISCOVERY_COPILOT_DISABLE_PROBES: "1",
});
const POST_START_CONFIG_RECONCILE_DELAY_MS = Number.parseInt(
  process.env.OPENCLAW_POST_START_CONFIG_RECONCILE_DELAY_MS || "5000",
  10,
);
const POST_START_CONFIG_RECONCILE_INTERVAL_MS = Number.parseInt(
  process.env.OPENCLAW_POST_START_CONFIG_RECONCILE_INTERVAL_MS || "5000",
  10,
);
const POST_START_CONFIG_RECONCILE_ATTEMPTS = Number.parseInt(
  process.env.OPENCLAW_POST_START_CONFIG_RECONCILE_ATTEMPTS || "6",
  10,
);
const POST_START_CONFIG_RECONCILE_TIMEOUT_MS = Number.parseInt(
  process.env.OPENCLAW_POST_START_CONFIG_RECONCILE_TIMEOUT_MS || "180000",
  10,
);
// Transient Telegram request failures can recover on their own; only restart on poll-loop stalls.
const TELEGRAM_STALL_PATTERNS = [
  "Polling stall detected",
  "polling runner stop timed out",
];

function isDisabled(rawValue, fallback = false) {
  if (rawValue == null || rawValue === "") return fallback;
  const normalized = String(rawValue).trim().toLowerCase();
  return ["0", "false", "off", "no"].includes(normalized);
}

function prependPath(dirPath) {
  process.env.PATH = `${dirPath}:${process.env.PATH || ""}`;
}

function applyHostEnvPassthrough(env = process.env) {
  const rawValue = String(env?.OPENCLAW_HOST_ENV_PASSTHROUGH_JSON ?? "").trim();
  if (!rawValue) return;

  let parsed = null;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

  for (const [name, rawEnvValue] of Object.entries(parsed)) {
    const normalizedName = String(name ?? "").trim();
    const value = String(rawEnvValue ?? "").trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedName) || !value) continue;
    process.env[normalizedName] = value;
  }
}

function resolveMountedCopilotConfigPath(env = process.env) {
  const copilotHome = String(env?.COPILOT_HOME ?? "").trim();
  if (copilotHome) return path.join(copilotHome, "config.json");

  const homeDir = String(env?.HOME ?? process.env.HOME ?? "").trim();
  if (!homeDir) return "";
  return path.join(homeDir, ".copilot", "config.json");
}

async function resolveMountedCopilotRuntimeToken(env = process.env) {
  const envToken = normalizeCopilotCliToken(
    env?.COPILOT_GITHUB_TOKEN || env?.GH_TOKEN || env?.GITHUB_TOKEN || "",
  );
  if (envToken) return envToken;

  const configPath = resolveMountedCopilotConfigPath(env);
  if (!configPath || !(await fileExists(configPath))) return "";

  const configData = await readJsonFile(configPath, null).catch(() => null);
  return resolveCopilotCliTokenFromSources(configData);
}

async function prepareRuntimeDirectories() {
  await ensureDir(RUNTIME_HOME);
  await ensureDir(RUNTIME_DIR);
  await ensureDir(GRADLE_HOME);
  try {
    await fs.chmod(RUNTIME_HOME, 0o700);
    await fs.chmod(RUNTIME_DIR, 0o700);
  } catch {}
}

async function prepareAcpxDirectories() {
  await ensureDir(BUNDLED_ACPX_DIR);
  await ensureDir(BUNDLED_ACPX_NODE_MODULES_DIR);
}

async function exportBundledAcpxCommand() {
  if (!(await fileExists(GLOBAL_ACPX_COMMAND))) return;
  if (!String(process.env.OPENCLAW_ACPX_COMMAND || "").trim()) {
    process.env.OPENCLAW_ACPX_COMMAND = GLOBAL_ACPX_COMMAND;
  }
  if (!String(process.env.OPENCLAW_ACPX_EXPECTED_VERSION || "").trim()) {
    process.env.OPENCLAW_ACPX_EXPECTED_VERSION = GLOBAL_ACPX_EXPECTED_VERSION;
  }
}

async function exportOptionalJavaHome() {
  if (String(process.env.JAVA_HOME || "").trim()) return;

  const candidates = [];
  try {
    const entries = await fs.readdir("/usr/lib/jvm", { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join("/usr/lib/jvm", entry.name);
      if (await fileExists(path.join(candidate, "bin", "java"))) {
        candidates.push(candidate);
      }
    }
  } catch {}

  candidates.sort((left, right) => {
    const leftPreferred = left.includes("java-17-openjdk") ? 1 : 0;
    const rightPreferred = right.includes("java-17-openjdk") ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    return left.localeCompare(right);
  });

  const selected = candidates[0];
  if (!selected) return;
  process.env.JAVA_HOME = selected;
  prependPath(path.join(selected, "bin"));
}

async function validateCopilotRuntimeTokenExchange() {
  const token = await resolveMountedCopilotRuntimeToken(process.env);

  delete process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS;
  delete process.env.OPENCLAW_COPILOT_RUNTIME_BASE_URL;
  delete process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_SOURCE;
  if (!token) {
    process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS = "missing";
    return;
  }

  const resolved = await resolveCopilotRuntimeAuth({
    githubToken: token,
    env: process.env,
  });

  process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS = resolved.status;
  if (resolved.httpStatus) {
    process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_HTTP_STATUS = resolved.httpStatus;
  }
  if (resolved.baseUrl) {
    process.env.OPENCLAW_COPILOT_RUNTIME_BASE_URL = resolved.baseUrl;
  }
  if (resolved.source) {
    process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_SOURCE = resolved.source;
  }
}

async function runNodeScript(scriptPath) {
  const result = await safeRunCommand(process.execPath, [scriptPath], {
    env: process.env,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to run ${scriptPath}`);
  }
}

async function renderOpenclawConfigStatus({ envOverrides = null, timeoutMs = 120_000 } = {}) {
  const result = await safeRunCommand(process.execPath, [RENDER_CONFIG_SCRIPT, "--json"], {
    env: envOverrides
      ? {
          ...process.env,
          ...envOverrides,
        }
      : process.env,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to run ${RENDER_CONFIG_SCRIPT}`);
  }

  const stdout = String(result.stdout || "").trim();
  if (!stdout) return null;

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse render status JSON from ${RENDER_CONFIG_SCRIPT}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function bootstrapProviderAuth() {
  await runNodeScript(BOOTSTRAP_AUTH_SCRIPT);
}

async function ensureAcpxPlugin() {
  if (await fileExists(LOCAL_ACPX_MANIFEST)) return;
  if (await fileExists(BUNDLED_ACPX_MANIFEST)) return;
  throw new Error(
    `Missing ACPX plugin. Checked ${LOCAL_ACPX_MANIFEST} and ${BUNDLED_ACPX_MANIFEST}. Update the OpenClaw base image or rebuild the runtime image before starting OpenClaw.`,
  );
}

async function renderOpenclawConfig() {
  await renderOpenclawConfigStatus({
    envOverrides: STARTUP_RENDER_ENV_OVERRIDES,
  });
}

async function reconcileGatewayConfigAfterStart(child) {
  const delayMs = Number.isFinite(POST_START_CONFIG_RECONCILE_DELAY_MS) && POST_START_CONFIG_RECONCILE_DELAY_MS >= 0
    ? POST_START_CONFIG_RECONCILE_DELAY_MS
    : 5_000;
  const intervalMs = Number.isFinite(POST_START_CONFIG_RECONCILE_INTERVAL_MS) && POST_START_CONFIG_RECONCILE_INTERVAL_MS >= 0
    ? POST_START_CONFIG_RECONCILE_INTERVAL_MS
    : 5_000;
  const attempts = Number.isFinite(POST_START_CONFIG_RECONCILE_ATTEMPTS) && POST_START_CONFIG_RECONCILE_ATTEMPTS > 0
    ? Math.trunc(POST_START_CONFIG_RECONCILE_ATTEMPTS)
    : 6;
  const reconcileTimeoutMs = Number.isFinite(POST_START_CONFIG_RECONCILE_TIMEOUT_MS) && POST_START_CONFIG_RECONCILE_TIMEOUT_MS > 0
    ? POST_START_CONFIG_RECONCILE_TIMEOUT_MS
    : 180_000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const waitMs = attempt === 0 ? delayMs : intervalMs;
    if (waitMs > 0) await sleep(waitMs);
    if (child.killed || child.exitCode != null) return;

    try {
      const status = await renderOpenclawConfigStatus({
        timeoutMs: reconcileTimeoutMs,
      });
      if (status?.changed) {
        console.error(
          `Post-start OpenClaw config reconcile detected startup drift on attempt ${attempt + 1}/${attempts}; rendered the final config for the running gateway.`,
        );
      }
    } catch (error) {
      console.error(
        `Post-start OpenClaw config reconcile failed on attempt ${attempt + 1}/${attempts}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function telegramWatchdogEnabled() {
  if (isDisabled(process.env.OPENCLAW_TELEGRAM_WATCHDOG_ENABLED, false)) return false;
  if (isDisabled(process.env.OPENCLAW_TELEGRAM_ENABLED, false)) return false;
  return String(process.env.TELEGRAM_BOT_TOKEN || "").trim() !== "";
}

function isGatewayCommand(argv) {
  if (argv.length >= 2 && argv[0] === "openclaw" && argv[1] === "gateway") return true;
  if (argv.length >= 3 && argv[0] === "node" && argv[2] === "gateway") return true;
  return false;
}

function isHealthCommand(argv) {
  if (argv.length >= 2 && argv[0] === "openclaw" && argv[1] === "health") return true;
  if (argv.length >= 3 && argv[0] === "node" && argv[2] === "health") return true;
  return false;
}

function telegramWatchdogMatchesStall(message) {
  return TELEGRAM_STALL_PATTERNS.some((pattern) => String(message || "").includes(pattern));
}

async function readLatestTelegramFailure() {
  const result = await safeRunCommand(
    "openclaw",
    ["channels", "logs", "--channel", "telegram", "--json", "--lines", "40"],
    { env: process.env, timeoutMs: 10_000 },
  );
  if (result.code !== 0 || !result.stdout.trim()) return null;

  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const lastLine = Array.isArray(payload?.lines) ? payload.lines.at(-1) : null;
  if (!lastLine || lastLine.level !== "error" || !lastLine.time) return null;
  if (!telegramWatchdogMatchesStall(lastLine.message)) return null;

  const lastEpoch = Date.parse(String(lastLine.time));
  if (!Number.isFinite(lastEpoch)) return null;

  return {
    ageSec: Math.floor((Date.now() - lastEpoch) / 1000),
    message: String(lastLine.message || ""),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChild(child) {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function watchGatewayTelegram(child) {
  const intervalMs = Number.parseInt(process.env.OPENCLAW_TELEGRAM_WATCHDOG_INTERVAL_SEC || "30", 10) * 1000;
  const graceSec = Number.parseInt(process.env.OPENCLAW_TELEGRAM_WATCHDOG_ERROR_GRACE_SEC || "120", 10);

  while (!child.killed && child.exitCode == null) {
    await sleep(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000);
    if (child.killed || child.exitCode != null) break;
    if (!telegramWatchdogEnabled()) continue;

    const failure = await readLatestTelegramFailure();
    if (!failure || failure.ageSec < graceSec) continue;

    console.error(
      `Telegram watchdog detected a stale polling stall (${failure.ageSec}s old). Restarting the gateway process.`,
    );
    child.kill("SIGTERM");
    await sleep(15_000);
    if (!child.killed && child.exitCode == null) child.kill("SIGKILL");
    return;
  }
}

async function runWithGatewayWatchdog(argv, logger = null) {
  return await withObservedStage(logger, "gateway.process", "gateway.process", async () => {
    const child = spawn(argv[0], argv.slice(1), {
      env: process.env,
      stdio: "inherit",
    });

    const stopChild = () => {
      if (!child.killed && child.exitCode == null) child.kill("SIGTERM");
    };
    process.on("SIGINT", stopChild);
    process.on("SIGTERM", stopChild);

    const configReconcilePromise = reconcileGatewayConfigAfterStart(child);
    const watchdogPromise = telegramWatchdogEnabled() ? watchGatewayTelegram(child) : Promise.resolve();
    const result = await waitForChild(child);
    await configReconcilePromise.catch(() => {});
    await watchdogPromise.catch(() => {});

    process.off("SIGINT", stopChild);
    process.off("SIGTERM", stopChild);

    if (result.signal) return 1;
    return typeof result.code === "number" ? result.code : 1;
  }, {
    data: {
      command: String(argv[0] ?? "").trim(),
      argCount: argv.length,
      telegramWatchdogEnabled: telegramWatchdogEnabled()
    },
    buildSuccessData(exitCode) {
      return {
        exitCode
      };
    }
  });
}

async function runBootstrap(logger = null) {
  await withObservedStage(logger, "runtime.prepare-directories", "runtime.prepare-directories", async () => {
    await prepareRuntimeDirectories();
    await prepareAcpxDirectories();
    await exportBundledAcpxCommand();
    await exportOptionalJavaHome();
  });
  await withObservedStage(logger, "runtime.bootstrap-auth", "runtime.bootstrap-auth", async () => {
    await bootstrapProviderAuth();
  });
  await withObservedStage(logger, "runtime.validate-copilot-token", "runtime.validate-copilot-token", async () => {
    await validateCopilotRuntimeTokenExchange();
    return {
      status: process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_STATUS || "unknown",
      source: process.env.OPENCLAW_COPILOT_RUNTIME_TOKEN_SOURCE || ""
    };
  }, {
    buildSuccessData(result) {
      return result;
    }
  });
  await withObservedStage(logger, "runtime.render-config", "runtime.render-config", async () => {
    await renderOpenclawConfig();
  });
  await withObservedStage(logger, "runtime.ensure-acpx-plugin", "runtime.ensure-acpx-plugin", async () => {
    await ensureAcpxPlugin();
  });
}

async function main() {
  applyHostEnvPassthrough(process.env);
  const argv = process.argv.slice(2);
  const eventLogger = createProcessEventLogger(process.env, {
    component: "runtime.entrypoint"
  });

  await emitObservedEvent(eventLogger, "runtime.entrypoint.started", {
    data: {
      argCount: argv.length,
      healthCommand: isHealthCommand(argv),
      gatewayCommand: isGatewayCommand(argv)
    }
  });

  try {
    if (!isHealthCommand(argv)) {
      await runBootstrap(eventLogger);
    }

    if (argv.length === 0) {
      await emitObservedEvent(eventLogger, "runtime.entrypoint.finished", {
        data: {
          exitCode: 0
        }
      });
      process.exit(0);
    }
    if (isGatewayCommand(argv)) {
      const exitCode = await runWithGatewayWatchdog(argv, eventLogger);
      await emitObservedEvent(eventLogger, "runtime.entrypoint.finished", {
        data: {
          exitCode,
          mode: "gateway"
        }
      });
      process.exit(exitCode);
    }

    const child = spawn(argv[0], argv.slice(1), {
      env: process.env,
      stdio: "inherit",
    });
    const result = await waitForChild(child);
    const exitCode = result.signal ? 1 : (typeof result.code === "number" ? result.code : 1);
    await emitObservedEvent(eventLogger, "runtime.entrypoint.finished", {
      data: {
        exitCode,
        mode: "command"
      }
    });
    process.exit(exitCode);
  } catch (error) {
    await emitObservedEvent(eventLogger, "runtime.entrypoint.failed", {
      level: "error",
      error,
      data: {
        argCount: argv.length,
        healthCommand: isHealthCommand(argv),
        gatewayCommand: isGatewayCommand(argv)
      }
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
