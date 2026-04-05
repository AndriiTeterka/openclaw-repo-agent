import {
  getProviderAdapter,
  getProviderAdapterForModelProvider,
  resolveAgentForModelProvider,
  resolveProviderLabelForModelProvider,
} from "./adapters/provider-factory.mjs";
import { uniqueStrings } from "./adapters/model-discovery-shared.mjs";

function normalizeModelRef(value) {
  return String(value ?? "").trim();
}

export function modelProviderPrefix(value) {
  const normalized = normalizeModelRef(value);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0) return "";
  return normalized.slice(0, slashIndex).toLowerCase();
}

function normalizeAgentId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeAuthMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "external";
  if (["external", "none", "codex", "gemini", "copilot"].includes(normalized)) return normalized;
  if (["off", "skip"].includes(normalized)) return "none";
  return normalized;
}

function qualifyProviderModels(provider, modelIds = []) {
  return modelIds.map((modelId) => `${provider}/${modelId}`);
}

export function isSupportedCodexModelId(modelId) {
  return getProviderAdapter("codex")?.isSupportedModelId?.(modelId) ?? false;
}

export function filterSupportedCodexModelIds(modelIds = []) {
  return getProviderAdapter("codex")?.filterModelIds?.(modelIds) ?? [];
}

export function filterSupportedCopilotModelIds(values = []) {
  return getProviderAdapter("copilot")?.filterModelIds?.(values) ?? [];
}

function discoverProviderModelIds(provider, env = process.env) {
  return getProviderAdapterForModelProvider(provider)?.discoverModelIds?.(env) ?? [];
}

export function shouldPreserveConfiguredModelRef(modelRef) {
  const normalized = normalizeModelRef(modelRef);
  if (!normalized) return false;

  const provider = modelProviderPrefix(normalized);
  const modelId = normalized.split("/").slice(1).join("/");
  const adapter = getProviderAdapterForModelProvider(provider);
  if (!adapter) return true;
  return adapter.shouldPreserveConfiguredModelId?.(modelId) ?? true;
}

export function resolveDefaultModelProvider({ defaultAgent = "", authMode = "", env = process.env } = {}) {
  const normalizedAgent = normalizeAgentId(defaultAgent);
  const adapter = getProviderAdapter(normalizedAgent);
  if (!adapter) return "";
  return adapter.resolveModelProvider?.({
    authMode: normalizeAuthMode(authMode),
    env,
  }) ?? "";
}

export function getLatestCurrentProviderModel(provider, env = process.env) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const discoveryEnv = normalizedProvider === "github-copilot"
    ? {
        ...env,
        OPENCLAW_MODEL_DISCOVERY_COPILOT_DEFAULT_ONLY: "1",
        OPENCLAW_MODEL_DISCOVERY_COPILOT_MAX_RESULTS: "1",
        OPENCLAW_MODEL_DISCOVERY_COPILOT_PROBE_CONCURRENCY: "1",
      }
    : env;
  return qualifyProviderModels(provider, discoverProviderModelIds(provider, discoveryEnv))[0] ?? "";
}

export function resolvePrimaryModelRef({
  provider = "",
  defaultAgent = "",
  defaultModel = "",
  authMode = "",
  catalog = {},
  env = process.env,
} = {}) {
  const normalizedDefaultModel = normalizeModelRef(defaultModel);
  const resolvedProvider = String(provider ?? "").trim().toLowerCase()
    || modelProviderPrefix(normalizedDefaultModel)
    || resolveDefaultModelProvider({ defaultAgent, authMode, env });
  const catalogKeys = Object.keys(catalog ?? {});
  const providerCatalogKeys = resolvedProvider
    ? catalogKeys.filter((modelRef) => modelProviderPrefix(modelRef) === resolvedProvider)
    : catalogKeys;

  if (normalizedDefaultModel) {
    const configuredProvider = modelProviderPrefix(normalizedDefaultModel);
    if (
      (!resolvedProvider || !configuredProvider || configuredProvider === resolvedProvider)
      && (
        providerCatalogKeys.includes(normalizedDefaultModel)
        || shouldPreserveConfiguredModelRef(normalizedDefaultModel)
      )
    ) {
      return normalizedDefaultModel;
    }
  }

  return providerCatalogKeys[0] ?? "";
}

export function buildCurrentProviderModelCatalog({
  provider = "",
  defaultAgent = "",
  defaultModel = "",
  authMode = "",
  env = process.env,
} = {}) {
  const normalizedDefaultModel = normalizeModelRef(defaultModel);
  const resolvedProvider = String(provider ?? "").trim().toLowerCase()
    || modelProviderPrefix(normalizedDefaultModel)
    || resolveDefaultModelProvider({ defaultAgent, authMode, env });
  const models = resolvedProvider
    ? qualifyProviderModels(resolvedProvider, discoverProviderModelIds(resolvedProvider, env))
    : [];

  if (normalizedDefaultModel && shouldPreserveConfiguredModelRef(normalizedDefaultModel) && !models.includes(normalizedDefaultModel)) {
    models.push(normalizedDefaultModel);
  }
  return Object.fromEntries(models.map((modelKey) => [modelKey, {}]));
}

export function buildAllProvidersModelCatalog({
  allowedAgents = [],
  defaultAgent = "",
  defaultModel = "",
  authMode = "",
  env = process.env,
} = {}) {
  const agents = allowedAgents.length > 0 ? allowedAgents : defaultAgent ? [defaultAgent] : [];
  const allModels = [];

  for (const agent of agents) {
    const provider = resolveDefaultModelProvider({
      defaultAgent: agent,
      authMode: agent === normalizeAgentId(defaultAgent) ? authMode : agent,
      env,
    });
    if (!provider) continue;
    const providerModels = qualifyProviderModels(provider, discoverProviderModelIds(provider, env));
    allModels.push(...providerModels);
  }

  const normalizedDefaultModel = normalizeModelRef(defaultModel);
  if (normalizedDefaultModel && shouldPreserveConfiguredModelRef(normalizedDefaultModel) && !allModels.includes(normalizedDefaultModel)) {
    allModels.push(normalizedDefaultModel);
  }

  const unique = [...new Set(allModels)];
  return Object.fromEntries(unique.map((modelKey) => [modelKey, {}]));
}

export function describeUnavailableProvider({ agentId = "", providerId = "", env = process.env } = {}) {
  const normalizedAgentId = normalizeAgentId(agentId) || resolveAgentForModelProvider(providerId);
  const adapter = getProviderAdapter(normalizedAgentId) || getProviderAdapterForModelProvider(providerId);
  const metadata = adapter?.metadata ?? {};
  const label = metadata.agentLabel || resolveProviderLabelForModelProvider(providerId) || providerId || normalizedAgentId || "This provider";
  if (typeof adapter?.describeUnavailable === "function") {
    return adapter.describeUnavailable({ label, providerId, env });
  }
  return `${label} is currently unavailable. Sign in on the host, then run /acp doctor.`;
}

export function buildLiveProviderSelectionData({
  allowedAgents = [],
  defaultAgent = "",
  authMode = "",
  env = process.env,
} = {}) {
  const normalizedDefaultAgent = normalizeAgentId(defaultAgent);
  const agents = uniqueStrings(allowedAgents.length > 0 ? allowedAgents : (normalizedDefaultAgent ? [normalizedDefaultAgent] : []))
    .map((agentId) => normalizeAgentId(agentId))
    .filter((agentId) => Boolean(getProviderAdapter(agentId)));
  const availableProviders = [];
  const unavailableProviders = [];
  const seenProviders = new Set();

  for (const agentId of agents) {
    const adapter = getProviderAdapter(agentId);
    const metadata = adapter?.metadata ?? {};
    if (!adapter) continue;

    const providerId = resolveDefaultModelProvider({
      defaultAgent: agentId,
      authMode: agentId === normalizedDefaultAgent ? authMode : agentId,
      env,
    });
    if (!providerId || seenProviders.has(providerId)) continue;
    seenProviders.add(providerId);

    const modelIds = discoverProviderModelIds(providerId, env);
    const entry = {
      agentId,
      providerId,
      label: metadata.agentLabel,
      count: modelIds.length,
      models: modelIds,
      modelRefs: qualifyProviderModels(providerId, modelIds),
      reason: modelIds.length > 0
        ? ""
        : describeUnavailableProvider({ agentId, providerId, env }),
    };

    if (modelIds.length > 0) {
      availableProviders.push(entry);
    } else {
      unavailableProviders.push(entry);
    }
  }

  return {
    defaultProviderId: resolveDefaultModelProvider({ defaultAgent: normalizedDefaultAgent, authMode, env }),
    availableProviders,
    unavailableProviders,
  };
}
