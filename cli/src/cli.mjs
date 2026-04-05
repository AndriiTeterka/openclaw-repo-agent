import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEventLogger,
  emitObservedEvent
} from "../../runtime/observability.mjs";
import {
  describeCommandFromArgv,
  parseArguments
} from "./command-line.mjs";
import {
  ACP_AGENT_CHOICES,
  buildComposeBuildArgs,
  buildComposeUpArgs,
  buildCopilotCredentialTargets,
  buildRuntimeCoreBuildArgs,
  buildRuntimeCoreOverlayBuildArgs,
  ensureGitExcludeEntries,
  hasIgnoreEntry,
  materializeRuntime,
  renderState,
  resolveCopilotRuntimeToken,
  resolveRuntimeCommandEnv,
  resolveGitInfoExcludePath,
  resolveState,
  shouldAutoHealGatewayPortConflict
} from "./command-runtime.mjs";
import { handleConfigValidate } from "./commands/config.mjs";
import {
  collectInitPromptState,
  handleInit,
  promptChoice
} from "./commands/init.mjs";
import { handleDown } from "./commands/down.mjs";
import { handleDoctor } from "./commands/doctor.mjs";
import { handleInstancesList } from "./commands/instances.mjs";
import {
  handlePair,
  selectLatestPendingDeviceRequest,
  selectLatestPendingPairingRequest
} from "./commands/pair.mjs";
import { handlePaths } from "./commands/paths.mjs";
import { handleStatus } from "./commands/status.mjs";
import {
  classifyTelegramBotProbeResult,
  handleUp,
  looksLikeTelegramBotToken,
  shouldRetryComposeUpFailure
} from "./commands/up.mjs";
import { handleUpdate } from "./commands/update.mjs";
import { detectRepository } from "./repository-detection.mjs";
import { PRODUCT_NAME, PRODUCT_VERSION } from "./product-metadata.mjs";
import { resolveAgentPaths } from "./state-layout.mjs";
import {
  buildInstanceMetadata,
  resolveInstanceRegistryPath
} from "./instance-registry.mjs";

export { describeCommandFromArgv } from "./command-line.mjs";
export {
  CODEX_AUTH_SOURCE_CHOICES,
  COPILOT_AUTH_SOURCE_CHOICES,
  GEMINI_AUTH_SOURCE_CHOICES,
  normalizePluginConfig
} from "./plugin-config.mjs";
export { buildDashboardUrl } from "./ui/report-helpers.mjs";
export {
  defaultCodexAuthSource,
  defaultCopilotAuthSource,
  defaultGeminiAuthSource,
  inferImplicitAllowedAgents
} from "./auth/foundations.mjs";
export { normalizePortablePath } from "./utils/path-utils.mjs";
export {
  ACP_AGENT_CHOICES,
  buildComposeBuildArgs,
  buildComposeUpArgs,
  buildCopilotCredentialTargets,
  buildRuntimeCoreBuildArgs,
  buildRuntimeCoreOverlayBuildArgs,
  ensureGitExcludeEntries,
  hasIgnoreEntry,
  materializeRuntime,
  renderState,
  resolveCopilotRuntimeToken,
  resolveRuntimeCommandEnv,
  resolveGitInfoExcludePath,
  resolveState,
  shouldAutoHealGatewayPortConflict
} from "./command-runtime.mjs";
export {
  collectInitPromptState,
  promptChoice
} from "./commands/init.mjs";
export {
  classifyTelegramBotProbeResult,
  looksLikeTelegramBotToken,
  shouldRetryComposeUpFailure
} from "./commands/up.mjs";
export {
  selectLatestPendingDeviceRequest,
  selectLatestPendingPairingRequest
} from "./commands/pair.mjs";

function resolveProductRoot(explicitProductRoot) {
  if (explicitProductRoot) return path.resolve(explicitProductRoot);
  if (process.pkg) return path.dirname(process.execPath);
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..");
}

function resolvePaths(repoRoot, instanceId, env = process.env) {
  return resolveAgentPaths(repoRoot, instanceId, env);
}

function createCommandEventLogger(context, commandKey) {
  return createEventLogger({
    repoRoot: context.repoRoot,
    destination: context.paths.eventLogFile,
    component: "cli",
    defaults: {
      command: commandKey,
      repoRoot: context.repoRoot,
      repoSlug: context.repoSlug,
      instanceId: context.instanceId
    }
  });
}

const OBSERVED_COMMANDS = new Set(["init", "up", "doctor", "update"]);

const COMMAND_HANDLERS = {
  init: handleInit,
  up: handleUp,
  down: handleDown,
  pair: handlePair,
  doctor: handleDoctor,
  status: handleStatus,
  update: handleUpdate,
  paths: handlePaths,
  "instances:list": handleInstancesList,
  "config:validate": handleConfigValidate,
};

function printHelp() {
  console.log(`${PRODUCT_NAME} ${PRODUCT_VERSION}

Usage:
  ${PRODUCT_NAME} <command> [options]

Commands:
  init             Initialize repo-local config and machine-local runtime state
  up               Start the local OpenClaw stack
  down             Stop the local OpenClaw stack
  pair             Approve local gateway/device and Telegram pairing, or external device pairing
  doctor           Check local prerequisites and gateway health
  status           Show rendered manifest and runtime status
  update           Refresh generated runtime files and restart the stack when needed
  paths            Show repo-local and machine-local runtime paths
  instances list   Show all registered repo instances on this machine
  config validate  Validate the workspace config and rendered manifest

Global options:
  --repo-root <path>
  --product-root <path>
  --json
  --reassign-port
  --refresh
  --help, -h
  --version, -v

Examples:
  ${PRODUCT_NAME} init --repo-root /path/to/repo
  ${PRODUCT_NAME} up --reassign-port
  ${PRODUCT_NAME} paths --json
  ${PRODUCT_NAME} status --check-updates
  ${PRODUCT_NAME} doctor --fix
  ${PRODUCT_NAME} pair
  ${PRODUCT_NAME} pair --gateway-url ws://gateway.example/ws --gateway-token <token>
  ${PRODUCT_NAME} instances list
`);
}

export async function main(argv) {
  const parsed = parseArguments(argv);
  const [command, subcommand] = parsed.positionals;
  if (parsed.options.version) {
    console.log(PRODUCT_VERSION);
    return;
  }
  if (!command || parsed.options.help || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(parsed.options.repoRoot ?? process.cwd());
  const productRoot = resolveProductRoot(parsed.options.productRoot);
  const instance = buildInstanceMetadata(repoRoot);
  const context = {
    repoRoot,
    productRoot,
    repoSlug: instance.repoSlug,
    instanceId: instance.instanceId,
    composeProjectName: instance.composeProjectName,
    instanceRegistryFile: resolveInstanceRegistryPath(),
    paths: resolvePaths(repoRoot, instance.instanceId, process.env),
    detection: await detectRepository(repoRoot)
  };

  const commandKey = subcommand ? `${command}:${subcommand}` : command;
  const handler = COMMAND_HANDLERS[commandKey];
  if (!handler) {
    throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
  }
  if (!OBSERVED_COMMANDS.has(commandKey)) {
    return await handler(context, parsed.options);
  }

  const eventLogger = createCommandEventLogger(context, commandKey);
  const previousObservability = context.observability;
  context.observability = {
    logger: eventLogger,
    eventLogFile: context.paths.eventLogFile
  };

  await emitObservedEvent(eventLogger, "command.started", {
    data: {
      options: parsed.options,
      eventLogFile: context.paths.eventLogFile
    }
  });

  try {
    const result = await handler(context, {
      ...parsed.options,
      eventLogger
    });
    await emitObservedEvent(eventLogger, "command.finished", {
      data: {
        eventLogFile: context.paths.eventLogFile
      }
    });
    return result;
  } catch (error) {
    await emitObservedEvent(eventLogger, "command.failed", {
      level: "error",
      error,
      data: {
        options: parsed.options,
        eventLogFile: context.paths.eventLogFile
      }
    });
    throw error;
  } finally {
    context.observability = previousObservability;
  }
}
