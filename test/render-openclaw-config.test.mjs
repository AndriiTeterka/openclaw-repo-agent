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
  const eventLogFile = path.join(tempRoot, "events.jsonl");

  await assert.rejects(
    execFileAsync(process.execPath, ["runtime/render-openclaw-config.mjs", "--check", "--json"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_RENDER_STATUS_PATH: renderStatusPath,
        OPENCLAW_EVENT_LOG_FILE: eventLogFile,
        OPENCLAW_EVENT_RUN_ID: "run-123",
        OPENCLAW_EVENT_CORRELATION_ID: "corr-456"
      }
    }),
    () => true
  );

  const status = JSON.parse(await fs.readFile(renderStatusPath, "utf8"));
  assert.equal(status.ok, false);
  assert.equal(status.manifestPath, "(env)");
  assert.match(status.validationErrors.join("; "), /acp\.defaultAgent is required/i);
  assert.deepEqual(status.observability, {
    eventLogFile,
    runId: "run-123",
    correlationId: "corr-456"
  });

  const records = (await fs.readFile(eventLogFile, "utf8"))
    .trim()
    .split(/\r?\n/g)
    .map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.event === "render.config.started"));
  assert.ok(records.some((record) => record.event === "render.config.validation-failed"));
});
