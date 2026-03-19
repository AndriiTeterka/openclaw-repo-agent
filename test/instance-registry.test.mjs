import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  allocateGatewayPort,
  deriveComposeProjectName,
  deriveInstanceId,
  deriveLocalRuntimeImage,
  fingerprintTelegramBotToken,
  readInstanceRegistry,
  shouldManageGatewayPort,
  upsertInstanceRegistryEntry
} from "../cli/src/instance-registry.mjs";
import { PRODUCT_VERSION } from "../cli/src/product-metadata.mjs";

test("deriveInstanceId is stable across slash variants and distinct across parent paths", () => {
  const left = deriveInstanceId("C:\\Users\\demo\\workspace\\repo");
  const right = deriveInstanceId("C:/Users/demo/workspace/repo");
  const other = deriveInstanceId("C:/Users/demo/another/repo");

  assert.equal(left, right);
  assert.notEqual(left, other);
});

test("deriveComposeProjectName prefixes the repo instance id", () => {
  const project = deriveComposeProjectName("C:/Users/demo/workspace/repo");

  assert.match(project, /^openclaw-repo-[a-f0-9]{8}$/);
});

test("allocateGatewayPort is deterministic and skips already-assigned ports", async () => {
  const instanceId = "repo-deadbeef";
  const first = await allocateGatewayPort({
    instanceId,
    registryEntries: [],
    isPortAvailable: async () => true
  });
  const second = await allocateGatewayPort({
    instanceId,
    registryEntries: [],
    isPortAvailable: async () => true
  });
  const next = await allocateGatewayPort({
    instanceId,
    registryEntries: [{ instanceId: "other-feedface", gatewayPort: String(first) }],
    isPortAvailable: async () => true
  });

  assert.equal(first, second);
  assert.notEqual(next, first);
});

test("deriveLocalRuntimeImage scopes local builds to the instance id", () => {
  assert.equal(
    deriveLocalRuntimeImage("repo-deadbeef"),
    `openclaw-repo-agent-runtime:${PRODUCT_VERSION}-repo-deadbeef`
  );
});

test("fingerprintTelegramBotToken ignores placeholders", () => {
  assert.equal(fingerprintTelegramBotToken("replace-with-your-botfather-token"), "");
  assert.match(fingerprintTelegramBotToken("123:abc"), /^[a-f0-9]{64}$/);
});

test("shouldManageGatewayPort preserves explicit non-default ports", () => {
  assert.equal(shouldManageGatewayPort({ OPENCLAW_GATEWAY_PORT: "18789" }), true);
  assert.equal(shouldManageGatewayPort({ OPENCLAW_GATEWAY_PORT: "24567" }), false);
  assert.equal(shouldManageGatewayPort({ OPENCLAW_GATEWAY_PORT: "24567", OPENCLAW_PORT_MANAGED: "true" }), true);
});

test("instance registry stores entries atomically", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-instance-registry-"));
  const registryPath = path.join(tempRoot, "instances.json");

  await upsertInstanceRegistryEntry(registryPath, {
    instanceId: "repo-one",
    repoRoot: "C:/repo-one",
    repoSlug: "repo-one",
    composeProjectName: "openclaw-repo-one",
    gatewayPort: "20001",
    portManaged: true,
    telegramTokenHash: "",
    localRuntimeImage: `openclaw-repo-agent-runtime:${PRODUCT_VERSION}-repo-one`,
    lastSeenAt: "2026-03-12T00:00:00.000Z"
  });
  await upsertInstanceRegistryEntry(registryPath, {
    instanceId: "repo-two",
    repoRoot: "C:/repo-two",
    repoSlug: "repo-two",
    composeProjectName: "openclaw-repo-two",
    gatewayPort: "20002",
    portManaged: true,
    telegramTokenHash: "",
    localRuntimeImage: `openclaw-repo-agent-runtime:${PRODUCT_VERSION}-repo-two`,
    lastSeenAt: "2026-03-12T00:00:01.000Z"
  });

  const registry = await readInstanceRegistry(registryPath);
  assert.deepEqual(Object.keys(registry.instances).sort(), ["repo-one", "repo-two"]);
});
