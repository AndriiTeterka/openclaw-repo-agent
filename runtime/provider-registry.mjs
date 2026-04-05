import {
  getProviderAdapterMetadata,
  getProviderAdapterMetadataForMode,
  resolveAgentForModelProvider,
  resolveAuthCliBin,
  resolveProviderLabelForModelProvider,
  SUPPORTED_PROVIDER_AGENTS,
} from "./adapters/provider-factory.mjs";

export const PROVIDER_REGISTRY = Object.freeze(Object.fromEntries(
  SUPPORTED_PROVIDER_AGENTS
    .map((agentId) => [agentId, getProviderAdapterMetadata(agentId)])
    .filter(([, entry]) => Boolean(entry)),
));

export { SUPPORTED_PROVIDER_AGENTS, resolveAgentForModelProvider, resolveAuthCliBin, resolveProviderLabelForModelProvider };

export function getProviderRegistryEntry(agentId) {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  return PROVIDER_REGISTRY[normalized] ?? null;
}

export function getProviderRegistryEntryForMode(mode) {
  return getProviderAdapterMetadataForMode(mode);
}
