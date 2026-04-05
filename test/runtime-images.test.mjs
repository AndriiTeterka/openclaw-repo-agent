import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_RUNTIME_CORE_IMAGE } from "../cli/src/product-metadata.mjs";
import {
  deriveFallbackRuntimeCoreImageTag,
  deriveToolingImageTag,
  extractRuntimeCoreDigest,
  resolveRuntimeCoreImageRef
} from "../cli/src/runtime-images.mjs";

test("resolveRuntimeCoreImageRef defaults to the latest runtime-core image", () => {
  assert.equal(resolveRuntimeCoreImageRef(""), DEFAULT_RUNTIME_CORE_IMAGE);
  assert.equal(resolveRuntimeCoreImageRef(undefined), DEFAULT_RUNTIME_CORE_IMAGE);
  assert.equal(
    resolveRuntimeCoreImageRef("ghcr.io/example/custom-runtime-core:dev"),
    "ghcr.io/example/custom-runtime-core:dev"
  );
});

test("deriveToolingImageTag is stable for reordered tooling profiles", () => {
  const first = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay",
    toolingProfiles: ["python3", "node22"],
    toolingInstallCommand: "python3 --version",
    agentInstallCommand: "node --version"
  });
  const second = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay",
    toolingProfiles: ["node22", "python3", "node22"],
    toolingInstallCommand: "python3 --version",
    agentInstallCommand: "node --version"
  });

  assert.equal(first, second);
  assert.match(first, /^openclaw-repo-agent-tooling:v2-[a-f0-9]{24}$/);
});

test("deriveToolingImageTag changes when the core digest, runtime overlay, or tooling spec changes", () => {
  const base = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay-a",
    toolingProfiles: ["node22"]
  });
  const changedDigest = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:5678",
    runtimeOverlayDigest: "sha256:runtime-overlay-a",
    toolingProfiles: ["node22"]
  });
  const changedRuntimeOverlay = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay-b",
    toolingProfiles: ["node22"]
  });
  const changedTooling = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay-a",
    toolingProfiles: ["python3"]
  });
  const changedCommand = deriveToolingImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:1234",
    runtimeOverlayDigest: "sha256:runtime-overlay-a",
    toolingProfiles: ["node22"],
    toolingInstallCommand: "python3 --version"
  });

  assert.notEqual(base, changedDigest);
  assert.notEqual(base, changedRuntimeOverlay);
  assert.notEqual(base, changedTooling);
  assert.notEqual(base, changedCommand);
});

test("deriveFallbackRuntimeCoreImageTag changes when the local source fingerprint changes", () => {
  const first = deriveFallbackRuntimeCoreImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:source-a"
  });
  const second = deriveFallbackRuntimeCoreImageTag({
    runtimeCoreImage: DEFAULT_RUNTIME_CORE_IMAGE,
    runtimeCoreDigest: "sha256:source-b"
  });

  assert.notEqual(first, second);
  assert.match(first, /^openclaw-repo-agent-runtime-core-fallback:v1-[a-f0-9]{24}$/);
});

test("extractRuntimeCoreDigest prefers the matching repo digest and falls back to the image id", () => {
  assert.equal(
    extractRuntimeCoreDigest({
      RepoDigests: [
        "ghcr.io/example/other@sha256:aaaa",
        "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core@sha256:bbbb"
      ],
      Id: "sha256:cccc"
    }, DEFAULT_RUNTIME_CORE_IMAGE),
    "sha256:bbbb"
  );

  assert.equal(
    extractRuntimeCoreDigest({
      RepoDigests: [],
      Id: "sha256:dddd"
    }, DEFAULT_RUNTIME_CORE_IMAGE),
    "sha256:dddd"
  );
});
