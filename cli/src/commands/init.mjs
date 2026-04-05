import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";

import { withObservedStage } from "../../../runtime/observability.mjs";
import {
  ensureDir,
  fileExists,
  readJsonFile,
  writeJsonFile,
  writeTextFile
} from "../../../runtime/shared.mjs";
import {
  normalizeAuthMode,
  validateProjectManifest
} from "../../../runtime/manifest-contract.mjs";
import {
  detectDefaultAuthPaths,
  resolveDetectedAuthPathForAgent,
  resolveEffectiveAllowedAgents,
  resolveExplicitAllowedAgents,
  resolveProviderAuthAvailability,
  resolveSubscriptionAuthSource
} from "../auth/foundations.mjs";
import {
  ACP_AGENT_CHOICES,
  SECRETS_ENV_HEADER,
  buildEffectiveManifest,
  ensureGitExcludeEntries,
  findRegisteredTelegramTokenConflicts,
  prepareState,
  readSecretsFile,
  runWithSpinner,
  writeEnvFile
} from "../command-runtime.mjs";
import {
  getAuthBootstrapProviderForAgent,
  normalizeAllowedAgents,
  normalizePluginConfig,
  resolvePreferredAuthMode
} from "../plugin-config.mjs";
import { PRODUCT_NAME } from "../product-metadata.mjs";
import { toDisplayPath } from "../state-layout.mjs";
import { defaultInstructionsTemplate } from "../templates.mjs";
import {
  buildDashboardUrl,
  buildNextStepsSection,
  buildPreparedSection,
  buildStatusSection,
  printCommandReport
} from "../ui/report-helpers.mjs";
import { renderStatusMarker } from "../reporting.mjs";

const ACP_AGENT_IDS = ACP_AGENT_CHOICES.map((choice) => choice.value);

function resolvePromptChoiceValue(answer, choices, fallbackValue) {
  const normalized = String(answer ?? "").trim();
  if (!normalized) return fallbackValue;

  const numericIndex = Number.parseInt(normalized, 10);
  if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= choices.length) {
    return choices[numericIndex - 1].value;
  }

  const exact = choices.find((choice) => choice.value === normalized);
  return exact?.value || "";
}
function createInteractivePrompter() {
  return {
    async select(message, choices, fallbackValue) {
      const defaultIndex = Math.max(choices.findIndex((choice) => choice.value === fallbackValue), 0);
      console.log("");
      choices.forEach((choice, index) => {
        const prefix = chalk.gray(`  ${index + 1}.`);
        const suffix = index === defaultIndex ? chalk.gray(" (default)") : "";
        console.log(`${prefix} ${choice.label}${suffix}`);
      });
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message: `Choose ${message}`,
        default: "",
        filter(inputValue) {
          return resolvePromptChoiceValue(inputValue, choices, fallbackValue);
        },
        validate(inputValue) {
          if (resolvePromptChoiceValue(inputValue, choices, fallbackValue)) return true;
          return `Enter a number between 1 and ${choices.length}, or one of: ${choices.map((choice) => choice.value).join(", ")}.`;
        }
      }]);
      return String(value ?? "").trim();
    },
    async input(message, fallback = "", options = {}) {
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message,
        default: fallback || undefined,
        validate(inputValue) {
          const normalized = String(inputValue ?? "").trim();
          if (normalized || fallback || !options.required) return true;
          return `${message} is required.`;
        }
      }]);
      return String(value ?? "").trim() || fallback;
    },
    async password(message, fallback = "", options = {}) {
      const { value } = await inquirer.prompt([{
        type: "input",
        name: "value",
        message,
        default: undefined,
        transformer(inputValue) {
          return String(inputValue ?? "").replace(/./g, "*");
        },
        validate(inputValue) {
          const normalized = String(inputValue ?? "").trim();
          if (normalized || fallback || !options.required) return true;
          return `${message} is required.`;
        }
      }]);
      return String(value ?? "").trim() || fallback;
    }
  };
}
function formatAgentSummary(acpDefaultAgent, manifest, localEnv = {}) {
  const agent = String(acpDefaultAgent ?? "").trim();
  if (!agent) return "";
  const authProvider = getAuthBootstrapProviderForAgent(agent);
  if (!authProvider) return agent;

  const authMode = normalizeAuthMode(manifest?.security?.authBootstrapMode);
  if (authMode === "none") return `${authProvider.agentLabel} (auth disabled)`;
  if (authMode !== authProvider.mode) return `${authProvider.agentLabel} (external auth)`;
  return authProvider.authFolderLabel
    ? `${authProvider.agentLabel} (${authProvider.authFolderLabel})`
    : authProvider.agentLabel;
}

async function promptOptional(prompter, label, fallback = "", options = {}) {
  if (typeof prompter?.input === "function" || typeof prompter?.password === "function") {
    return options.secret
      ? await prompter.password(label, fallback, { required: false })
      : await prompter.input(label, fallback, { required: false });
  }

  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await prompter.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

function formatProviderAvailabilityLabels(entries = []) {
  return entries.map((entry) => entry.agentLabel).join(", ");
}

export function buildInitProviderAvailabilityDetails(entries = []) {
  const loadedProviders = entries.filter((entry) => entry.available);
  const unavailableProviders = entries.filter((entry) => !entry.available);
  return [
    `Loaded: ${loadedProviders.length > 0 ? formatProviderAvailabilityLabels(loadedProviders) : "none"}`,
    unavailableProviders.length > 0 ? `Unavailable: ${formatProviderAvailabilityLabels(unavailableProviders)}` : ""
  ].filter(Boolean);
}

export function resolveInitProviderAvailability(defaultAgent, agentIds = ACP_AGENT_IDS, detectedAuthPaths = {}) {
  const entries = resolveProviderAuthAvailability(agentIds, detectedAuthPaths);
  const loadedProviders = entries.filter((entry) => entry.available);
  return {
    entries,
    loadedProviders,
    unavailableProviders: entries.filter((entry) => !entry.available),
    selectedProviderLoaded: loadedProviders.some((entry) => entry.agentId === defaultAgent),
    summaryItems: buildInitProviderAvailabilityDetails(entries)
  };
}

function buildNoProviderAuthError() {
  return `No provider subscription login was detected on this machine. Sign in with Codex, Gemini, or Copilot, then rerun '${PRODUCT_NAME} init'.`;
}

function buildUnavailableDefaultAgentError(defaultAgent, entries = []) {
  const selectedProvider = entries.find((entry) => entry.agentId === defaultAgent);
  const loadedProviders = entries.filter((entry) => entry.available);
  const loadedSummary = formatProviderAvailabilityLabels(loadedProviders);
  return `ACP default agent '${selectedProvider?.agentLabel || defaultAgent}' does not have a detected subscription login.${loadedSummary ? ` Loaded providers: ${loadedSummary}.` : ""} Choose one of the loaded providers or sign in on the host, then rerun '${PRODUCT_NAME} init'.`;
}

export async function promptChoice(prompter, label, choices, fallbackValue) {
  if (typeof prompter?.select === "function") {
    return await prompter.select(label, choices, fallbackValue);
  }

  const defaultIndex = Math.max(choices.findIndex((choice) => choice.value === fallbackValue), 0);
  console.log("");
  console.log(`${renderStatusMarker("info")} ${label}`);
  choices.forEach((choice, index) => {
    console.log(`  ${index + 1}. ${choice.label}${index === defaultIndex ? " (default)" : ""}`);
  });

  while (true) {
    const answer = (await prompter.question(`Choose ${label.toLowerCase()} [${defaultIndex + 1}]: `)).trim();
    if (!answer) return choices[defaultIndex].value;

    const numericIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= choices.length) {
      return choices[numericIndex - 1].value;
    }

    const exact = choices.find((choice) => choice.value === answer);
    if (exact) return exact.value;

    console.log(`${renderStatusMarker("warning")} Enter a number between 1 and ${choices.length}, or one of: ${choices.map((choice) => choice.value).join(", ")}.`);
  }
}

export async function collectInitPromptState(prompter, context, plugin, existingLocalEnv, options, detectedAuthPaths = {}) {
  const projectName = plugin.projectName;
  const toolingProfiles = plugin.toolingProfiles;
  const deploymentProfile = plugin.deploymentProfile;
  const runtimeProfile = plugin.runtimeProfile;
  const queueProfile = plugin.queueProfile;

  const availableProviderChoices = ACP_AGENT_CHOICES.filter((choice) =>
    Boolean(resolveDetectedAuthPathForAgent(choice.value, detectedAuthPaths))
  );
  if (availableProviderChoices.length === 0) {
    throw new Error(buildNoProviderAuthError());
  }
  const fallbackAgent = ACP_AGENT_CHOICES.some((choice) => choice.value === plugin.acp.defaultAgent)
    ? plugin.acp.defaultAgent
    : availableProviderChoices[0].value;
  const acpDefaultAgent = await promptChoice(
    prompter,
    "ACP default agent",
    ACP_AGENT_CHOICES,
    fallbackAgent
  );
  const authProvider = getAuthBootstrapProviderForAgent(acpDefaultAgent);
  const detectedAuthPath = resolveDetectedAuthPathForAgent(acpDefaultAgent, detectedAuthPaths);
  const storedAuthSources = {
    codex: resolveSubscriptionAuthSource("codex", detectedAuthPaths),
    gemini: resolveSubscriptionAuthSource("gemini", detectedAuthPaths),
    copilot: resolveSubscriptionAuthSource("copilot", detectedAuthPaths),
  };
  let authMode = resolvePreferredAuthMode(plugin.security.authBootstrapMode, acpDefaultAgent);
  let selectedAuthSource = resolveSubscriptionAuthSource(acpDefaultAgent, detectedAuthPaths);

  if (authProvider) {
    authMode = authProvider.mode;
  } else {
    authMode = "external";
  }

  const hasTelegramToken = Boolean(existingLocalEnv.TELEGRAM_BOT_TOKEN) && !String(existingLocalEnv.TELEGRAM_BOT_TOKEN).startsWith("replace-with-");
  const telegramBotTokenInput = hasTelegramToken
    ? ""
    : await promptOptional(prompter, "Telegram bot token", "", { secret: true });
  if (authProvider && selectedAuthSource) {
    storedAuthSources[acpDefaultAgent] = selectedAuthSource;
  }

  const acpAllowedAgents = normalizeAllowedAgents(acpDefaultAgent, plugin.acp.allowedAgents);

  const nextPlugin = normalizePluginConfig({
    ...plugin,
    projectName,
    deploymentProfile,
    toolingProfiles,
    stack: plugin.stack,
    runtimeProfile,
    queueProfile,
    acp: {
      ...plugin.acp,
      defaultAgent: acpDefaultAgent,
      allowedAgents: acpAllowedAgents
    },
    security: {
      ...plugin.security,
      authBootstrapMode: authMode
    }
  }, context.repoRoot, context.detection, {
    ...options,
    projectName,
    deploymentProfile,
    toolingProfile: toolingProfiles,
    runtimeProfile,
    queueProfile,
    authMode,
    acpDefaultAgent,
    acpAllowedAgent: acpAllowedAgents
  });

  return {
    plugin: nextPlugin,
    localEnv: {
      TELEGRAM_BOT_TOKEN: telegramBotTokenInput || (hasTelegramToken ? existingLocalEnv.TELEGRAM_BOT_TOKEN : "replace-with-your-botfather-token"),
      OPENCLAW_CODEX_AUTH_SOURCE: storedAuthSources.codex,
      OPENCLAW_GEMINI_AUTH_SOURCE: storedAuthSources.gemini,
      OPENCLAW_COPILOT_AUTH_SOURCE: storedAuthSources.copilot
    }
  };
}

async function promptForInit(context, plugin, existingLocalEnv, options, detectedAuthPaths = {}) {
  if (options.yes || options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { plugin, localEnv: {} };
  }

  return await collectInitPromptState(
    createInteractivePrompter(),
    context,
    plugin,
    existingLocalEnv,
    options,
    detectedAuthPaths
  );
}

function buildInitLocalEnv(existingLocalEnv, initLocalEnv, detectedAuthPaths = {}) {
  const mergedLocalEnv = {
    ...existingLocalEnv,
    ...initLocalEnv
  };
  return {
    TELEGRAM_BOT_TOKEN: initLocalEnv.TELEGRAM_BOT_TOKEN
      ?? existingLocalEnv.TELEGRAM_BOT_TOKEN
      ?? "replace-with-your-botfather-token",
    OPENCLAW_CODEX_AUTH_SOURCE: resolveSubscriptionAuthSource("codex", detectedAuthPaths),
    OPENCLAW_GEMINI_AUTH_SOURCE: resolveSubscriptionAuthSource("gemini", detectedAuthPaths),
    OPENCLAW_COPILOT_AUTH_SOURCE: resolveSubscriptionAuthSource("copilot", detectedAuthPaths),
    OPENCLAW_RUNTIME_CORE_IMAGE: mergedLocalEnv.OPENCLAW_RUNTIME_CORE_IMAGE ?? "",
  };
}

function buildInitSecretsToWrite(localEnv = {}) {
  return {
    TELEGRAM_BOT_TOKEN: localEnv.TELEGRAM_BOT_TOKEN ?? "",
    OPENCLAW_RUNTIME_CORE_IMAGE: localEnv.OPENCLAW_RUNTIME_CORE_IMAGE ?? "",
    OPENCLAW_CODEX_AUTH_SOURCE: localEnv.OPENCLAW_CODEX_AUTH_SOURCE ?? "",
    OPENCLAW_GEMINI_AUTH_SOURCE: localEnv.OPENCLAW_GEMINI_AUTH_SOURCE ?? "",
    OPENCLAW_COPILOT_AUTH_SOURCE: localEnv.OPENCLAW_COPILOT_AUTH_SOURCE ?? ""
  };
}

function stableEnvSignature(values = {}) {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key] == null ? "" : String(values[key])])
  );
}

function hasRemovedManagedSecrets(localEnv = {}) {
  const managedKeys = new Set(Object.keys(buildInitSecretsToWrite({})));
  return Object.keys(localEnv).some((key) => !managedKeys.has(key) && (/_KEY$/.test(key) || /TOKEN$/.test(key)));
}

export async function handleInit(context, options) {
  const eventLogger = options.eventLogger?.child?.({ component: "cli" }) || null;
  await ensureDir(context.paths.openclawDir);
  await ensureDir(context.paths.instanceRoot);
  const existingConfig = await readJsonFile(context.paths.configFile, null);
  const existingSecretsSource = await readSecretsFile(context);
  const existingLocalEnv = existingSecretsSource.values;
  const detectedAuthPaths = await detectDefaultAuthPaths();
  const basePlugin = normalizePluginConfig(existingConfig ?? {}, context.repoRoot, context.detection, options);
  const initState = existingConfig && !options.force
    ? { plugin: basePlugin, localEnv: {} }
    : await promptForInit(context, basePlugin, existingLocalEnv, options, detectedAuthPaths);
  const plugin = initState.plugin;
  const explicitAllowedAgents = resolveExplicitAllowedAgents(existingConfig ?? {}, options, existingLocalEnv);
  if (explicitAllowedAgents.length === 0) {
    plugin.acp.allowedAgents = [];
  }
  const resolvedInitLocalEnv = buildInitLocalEnv(existingLocalEnv, initState.localEnv, detectedAuthPaths);

  if (!plugin.acp.defaultAgent) {
    throw new Error("ACP default agent is required. Pass --acp-default-agent in non-interactive mode or rerun init interactively.");
  }

  const validationState = await withObservedStage(eventLogger, "config.validate", "config.validate", async () => {
    const effectiveAllowedAgents = resolveEffectiveAllowedAgents(existingConfig ?? {}, plugin, resolvedInitLocalEnv, options, detectedAuthPaths);
    const manifest = buildEffectiveManifest(plugin, context.repoRoot, resolvedInitLocalEnv, {
      ...options,
      acpAllowedAgent: effectiveAllowedAgents,
    });
    const validationErrors = validateProjectManifest(manifest);
    if (validationErrors.length > 0) {
      throw new Error(`Cannot initialize workspace: ${validationErrors.join("; ")}`);
    }
    return {
      effectiveAllowedAgents,
      manifest
    };
  }, {
    data: {
      existingConfig: Boolean(existingConfig),
      force: Boolean(options.force),
      interactive: !(options.yes || options.nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY)
    },
    buildSuccessData({ effectiveAllowedAgents, manifest }) {
      return {
        projectName: manifest.projectName,
        defaultAgent: manifest.acp.defaultAgent,
        allowedAgents: effectiveAllowedAgents,
        authBootstrapMode: manifest.security.authBootstrapMode
      };
    }
  });
  const manifest = validationState.manifest;
  const providerAvailability = resolveInitProviderAvailability(plugin.acp.defaultAgent, ACP_AGENT_IDS, detectedAuthPaths);
  const usableProviderAvailability = resolveInitProviderAvailability(
    plugin.acp.defaultAgent,
    validationState.effectiveAllowedAgents,
    detectedAuthPaths
  );
  if (usableProviderAvailability.loadedProviders.length === 0) {
    throw new Error(buildNoProviderAuthError());
  }

  const shouldWriteConfig = !existingConfig || options.force || JSON.stringify(existingConfig) !== JSON.stringify(plugin);
  const configStatus = path.relative(context.repoRoot, context.paths.configFile);
  const shouldWriteInstructions = !(await fileExists(context.paths.instructionsFile)) || options.force;

  const secretsToWrite = buildInitSecretsToWrite(resolvedInitLocalEnv);
  const secretsFileExists = await fileExists(context.paths.secretsEnvFile);
  const shouldWriteSecrets = !secretsFileExists
    || options.force
    || hasRemovedManagedSecrets(existingLocalEnv)
    || stableEnvSignature(buildInitSecretsToWrite(existingLocalEnv)) !== stableEnvSignature(secretsToWrite);

  await withObservedStage(eventLogger, "config.write", "config.write", async () => {
    if (shouldWriteConfig) {
      await writeJsonFile(context.paths.configFile, plugin);
    }

    if (shouldWriteInstructions) {
      await writeTextFile(context.paths.instructionsFile, defaultInstructionsTemplate(plugin.projectName));
    }

    if (shouldWriteSecrets) {
      await writeEnvFile(context.paths.secretsEnvFile, secretsToWrite, SECRETS_ENV_HEADER);
    }

    await ensureGitExcludeEntries(context.repoRoot);
  }, {
    buildSuccessData() {
      return {
        wroteConfig: shouldWriteConfig,
        wroteInstructions: shouldWriteInstructions,
        wroteSecrets: shouldWriteSecrets,
        files: [
          context.paths.configFile,
          context.paths.instructionsFile,
          context.paths.secretsEnvFile
        ]
      };
    }
  });

  const state = await runWithSpinner(
    "Preparing workspace runtime",
    () => withObservedStage(eventLogger, "state.prepare", "state.prepare", () => prepareState(context, options), {
      buildSuccessData(nextState) {
        return {
          gatewayPort: nextState.localEnv.OPENCLAW_GATEWAY_PORT,
          runtimeCoreImage: nextState.runtimeImages?.runtimeCoreImage || "",
          runtimeCoreDigest: nextState.runtimeImages?.runtimeCoreDigest || ""
        };
      }
    }),
    options
  );
  const registeredConflicts = findRegisteredTelegramTokenConflicts(context, state.instanceRegistry, state.localEnv);

  printCommandReport("success", "Init complete", [
    { label: "Repo", value: context.repoRoot },
    { label: "Gateway", value: buildDashboardUrl(state.localEnv.OPENCLAW_GATEWAY_PORT) },
    { label: "Agent", value: formatAgentSummary(plugin.acp.defaultAgent, state.manifest, state.localEnv) }
  ], [
    buildPreparedSection([
      configStatus,
      toDisplayPath(context.repoRoot, context.paths.secretsEnvFile),
      toDisplayPath(context.repoRoot, context.paths.runtimeEnvFile),
      toDisplayPath(context.repoRoot, context.paths.composeFile)
    ]),
    buildStatusSection("Provider availability", "info", providerAvailability.summaryItems),
    buildStatusSection("Warnings", "warning", registeredConflicts.length > 0
      ? [`This Telegram bot token is also configured in ${registeredConflicts.length} other registered repo instance(s).`]
      : []),
    buildNextStepsSection([
      `Run '${PRODUCT_NAME} up' to start the OpenClaw gateway for this repo.`
    ])
  ].filter(Boolean), {
    summaryTitle: "Configuration"
  });
}
