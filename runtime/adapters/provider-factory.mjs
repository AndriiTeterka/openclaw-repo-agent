import { CODEX_PROVIDER_ADAPTER } from "./codex-provider-adapter.mjs";
import { GEMINI_PROVIDER_ADAPTER } from "./gemini-provider-adapter.mjs";
import { COPILOT_PROVIDER_ADAPTER } from "./copilot-provider-adapter.mjs";

const PROVIDER_ADAPTERS = Object.freeze({
  codex: CODEX_PROVIDER_ADAPTER,
  gemini: GEMINI_PROVIDER_ADAPTER,
  copilot: COPILOT_PROVIDER_ADAPTER,
});

export const SUPPORTED_PROVIDER_AGENTS = Object.freeze(Object.keys(PROVIDER_ADAPTERS));

export function getProviderAdapter(agentId) {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  return PROVIDER_ADAPTERS[normalized] ?? null;
}

export function getProviderAdapterMetadata(agentId) {
  return getProviderAdapter(agentId)?.metadata ?? null;
}

function getProviderAdapterForMode(mode) {
  return getProviderAdapter(mode);
}

export function getProviderAdapterMetadataForMode(mode) {
  return getProviderAdapterMetadata(mode);
}

function matchesProviderId(adapter, providerId) {
  const normalizedProviderId = String(providerId ?? "").trim().toLowerCase();
  if (!adapter || !normalizedProviderId) return false;
  const metadata = adapter.metadata ?? {};
  return metadata.defaultModelProvider === normalizedProviderId;
}

export function getProviderAdapterForModelProvider(providerId) {
  const normalizedProviderId = String(providerId ?? "").trim().toLowerCase();
  if (!normalizedProviderId) return null;

  return SUPPORTED_PROVIDER_AGENTS
    .map((agentId) => getProviderAdapter(agentId))
    .find((adapter) => matchesProviderId(adapter, normalizedProviderId)) ?? null;
}

export function resolveAgentForModelProvider(providerId) {
  return getProviderAdapterForModelProvider(providerId)?.metadata?.agentId ?? "";
}

export function resolveProviderLabelForModelProvider(providerId) {
  return getProviderAdapterForModelProvider(providerId)?.metadata?.agentLabel || String(providerId ?? "").trim();
}

export function resolveAuthCliBin(mode, explicit = "") {
  const configured = String(explicit ?? "").trim();
  if (configured) return configured;
  return getProviderAdapterForMode(mode)?.metadata?.authCliBin || "";
}
