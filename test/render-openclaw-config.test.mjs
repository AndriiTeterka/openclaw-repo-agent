import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");

test("render-openclaw-config writes structured status for invalid manifests", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-render-status-"));
  const renderStatusPath = path.join(tempRoot, "render-status.json");

  await assert.rejects(
    execFileAsync(process.execPath, ["runtime/render-openclaw-config.mjs", "--check", "--json"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_RENDER_STATUS_PATH: renderStatusPath
      }
    }),
    () => true
  );

  const status = JSON.parse(await fs.readFile(renderStatusPath, "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.manifestPath, "(env)");
  assert.match(status.validationErrors.join("; "), /acp\.defaultAgent is required/i);
});
