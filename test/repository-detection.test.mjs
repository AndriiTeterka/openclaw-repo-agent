import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectRepository } from "../cli/src/repository-detection.mjs";

async function withTempRepo(setup, assertion) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-detect-"));
  try {
    await setup(tempDir);
    await assertion(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("detectRepository infers project name and node verification commands from package.json", async () => {
  await withTempRepo(async (repoRoot) => {
    await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({
      name: "@demo/api-service",
      packageManager: "pnpm@9.1.0",
      scripts: {
        build: "tsup",
        test: "vitest"
      }
    }, null, 2));
    await fs.writeFile(path.join(repoRoot, "README.md"), "# API Service\n");
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "api-service");
    assert.equal(detection.toolingProfile, "node20");
    assert.deepEqual(detection.verificationCommands, ["pnpm run build", "pnpm test"]);
    assert.deepEqual(detection.instructionCandidates, ["README.md", ".openclaw/instructions.md"]);
  });
});

test("detectRepository falls back to pyproject metadata for project name", async () => {
  await withTempRepo(async (repoRoot) => {
    await fs.writeFile(path.join(repoRoot, "pyproject.toml"), `
[project]
name = "service-worker"
`);
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "service-worker");
    assert.equal(detection.toolingProfile, "python311");
    assert.deepEqual(detection.verificationCommands, ["python -m pytest"]);
  });
});

test("detectRepository recognizes Gradle Kotlin DSL projects", async () => {
  await withTempRepo(async (repoRoot) => {
    await fs.writeFile(path.join(repoRoot, "settings.gradle.kts"), "rootProject.name = \"kts-service\"\n");
    await fs.writeFile(path.join(repoRoot, "build.gradle.kts"), "plugins { java }\n");
    await fs.writeFile(path.join(repoRoot, "gradlew"), "#!/bin/sh\n");
  }, async (repoRoot) => {
    const detection = await detectRepository(repoRoot);

    assert.equal(detection.projectName, "kts-service");
    assert.equal(detection.toolingProfile, "java17");
    assert.deepEqual(detection.verificationCommands, ["./gradlew build"]);
  });
});
