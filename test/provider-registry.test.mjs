import assert from "node:assert/strict";
import test from "node:test";

import {
  getProviderAdapterMetadata,
  SUPPORTED_PROVIDER_AGENTS,
} from "../runtime/adapters/provider-factory.mjs";
import { resolveAgentAuthSourceEnvKey } from "../cli/src/auth/foundations.mjs";
import {
  getProviderRegistryEntry,
  getProviderRegistryEntryForMode,
  PROVIDER_REGISTRY,
} from "../runtime/provider-registry.mjs";
import { SUPPORTED_ACP_AGENTS } from "../runtime/supported-acp-agents.mjs";
import {
  getAuthBootstrapProviderForAgent,
  getAuthBootstrapProviderForMode,
} from "../cli/src/plugin-config.mjs";

test("provider registry stays a compatibility shim over adapter metadata", () => {
  for (const agentId of SUPPORTED_PROVIDER_AGENTS) {
    const metadata = getProviderAdapterMetadata(agentId);
    assert.equal(PROVIDER_REGISTRY[agentId], metadata);
    assert.equal(getProviderRegistryEntry(agentId), metadata);
    assert.equal(getProviderRegistryEntryForMode(agentId), metadata);
  }
});

test("plugin config provider lookups read provider metadata from the adapter seam", () => {
  for (const agentId of SUPPORTED_PROVIDER_AGENTS) {
    const metadata = getProviderAdapterMetadata(agentId);
    assert.equal(getAuthBootstrapProviderForAgent(agentId), metadata);
    assert.equal(getAuthBootstrapProviderForMode(agentId), metadata);
  }
});

test("supported ACP agents and auth env keys stay aligned with adapter metadata", () => {
  assert.deepEqual(SUPPORTED_ACP_AGENTS, SUPPORTED_PROVIDER_AGENTS);

  for (const agentId of SUPPORTED_PROVIDER_AGENTS) {
    const metadata = getProviderAdapterMetadata(agentId);
    assert.equal(resolveAgentAuthSourceEnvKey(agentId), metadata?.authSourceEnvKey ?? "");
  }
});
