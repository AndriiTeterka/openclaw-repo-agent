import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const cliPath = path.resolve("cli/bin/openclaw-repo-agent.mjs");

test("global help prints usage", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /Commands:/);
  assert.match(stdout, /mcp setup/);
  assert.equal(stderr, "");
});

test("subcommand help prints usage instead of failing", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "init", "--help"], {
    cwd: repoRoot
  });

  assert.match(stdout, /Usage:/);
});

test("version flag prints product version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--version"], {
    cwd: repoRoot
  });

  assert.equal(stdout.trim(), "0.1.3");
});

test("inline option syntax works for config validation", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "config",
    "validate",
    "--repo-root=./examples/custom",
    "--product-root=.",
    "--json=true"
  ], {
    cwd: repoRoot
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.productVersion, "0.1.3");
});
