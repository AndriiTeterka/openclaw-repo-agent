import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveAgentPaths } from "../cli/src/state-layout.mjs";
import {
  createProcessEventLogger,
  createEventLogger,
  REDACTED_VALUE,
  resolveEventLogFile,
  sanitizeEventValue,
  withObservedStage
} from "../runtime/observability.mjs";

async function createScratchRepo(label) {
  const tempRoot = path.join(
    path.resolve("test"),
    `.scratch-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const repoRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repoRoot, { recursive: true });
  return { tempRoot, repoRoot };
}

test("resolveAgentPaths exposes the repo-local runtime event log destination", () => {
  const repoRoot = path.join("C:\\", "workspace", "demo-repo");
  const paths = resolveAgentPaths(repoRoot, "demo-1234");

  assert.equal(paths.eventLogFile, path.join(repoRoot, ".openclaw", "runtime", "events.jsonl"));
  assert.equal(resolveEventLogFile(repoRoot), paths.eventLogFile);
});

test("sanitizeEventValue redacts secret-bearing keys and inline tokens", () => {
  const sanitized = sanitizeEventValue({
    githubToken: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    nested: {
      authorizationHeader: "Bearer stage-secret-123",
      note: "token=abc123",
      safe: "hello"
    },
    values: [
      "Bearer inline-secret-456",
      "safe"
    ]
  });

  assert.equal(sanitized.githubToken, REDACTED_VALUE);
  assert.equal(sanitized.nested.authorizationHeader, REDACTED_VALUE);
  assert.equal(sanitized.nested.note, `token=${REDACTED_VALUE}`);
  assert.equal(sanitized.nested.safe, "hello");
  assert.equal(sanitized.values[0], `Bearer ${REDACTED_VALUE}`);
  assert.equal(sanitized.values[1], "safe");
});

test("createEventLogger writes sanitized JSONL records with run and correlation ids", async () => {
  const { tempRoot, repoRoot } = await createScratchRepo("observability");

  try {
    const logger = createEventLogger({
      repoRoot,
      component: "cli",
      runId: "run-123",
      correlationId: "root-456",
      defaults: {
        repo: "demo-repo",
        authorization: "Bearer root-secret"
      },
      clock: () => new Date("2026-01-02T03:04:05.000Z")
    });

    const stageLogger = logger.child({
      component: "runtime",
      correlationId: "stage-789",
      defaults: {
        command: "up",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456"
      }
    });

    const stageRecord = await stageLogger.stage("config.validate", "started", {
      message: "Authorization: Bearer stage-secret-123",
      data: {
        safe: "ok",
        OPENAI_API_KEY: "sk-secret-1234567890",
        nested: {
          note: "token=abc123"
        }
      }
    });

    const eventRecord = await logger.event("command.finished", {
      correlationId: "root-999",
      data: {
        result: "ok"
      }
    });

    const contents = await fs.readFile(resolveEventLogFile(repoRoot), "utf8");
    const records = contents.trim().split(/\r?\n/g).map((line) => JSON.parse(line));

    assert.equal(stageRecord.type, "stage");
    assert.equal(stageRecord.stage, "config.validate");
    assert.equal(stageRecord.component, "runtime");
    assert.equal(stageRecord.runId, "run-123");
    assert.equal(stageRecord.correlationId, "stage-789");
    assert.equal(stageRecord.message, `Authorization: ${REDACTED_VALUE}`);
    assert.equal(stageRecord.data.repo, "demo-repo");
    assert.equal(stageRecord.data.command, "up");
    assert.equal(stageRecord.data.authorization, REDACTED_VALUE);
    assert.equal(stageRecord.data.GITHUB_TOKEN, REDACTED_VALUE);
    assert.equal(stageRecord.data.OPENAI_API_KEY, REDACTED_VALUE);
    assert.equal(stageRecord.data.nested.note, `token=${REDACTED_VALUE}`);

    assert.equal(eventRecord.type, "event");
    assert.equal(eventRecord.event, "command.finished");
    assert.equal(eventRecord.runId, "run-123");
    assert.equal(eventRecord.correlationId, "root-999");

    assert.deepEqual(records, [stageRecord, eventRecord]);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("createProcessEventLogger uses runtime env defaults and explicit event-log destinations", async () => {
  const { tempRoot, repoRoot } = await createScratchRepo("process-observability");
  const destination = path.join(repoRoot, ".openclaw", "runtime", "custom-events.jsonl");

  try {
    const logger = createProcessEventLogger({
      OPENCLAW_REPO_ROOT: repoRoot,
      OPENCLAW_EVENT_LOG_FILE: destination,
      OPENCLAW_PROJECT_NAME: "demo-workspace",
      OPENCLAW_INSTANCE_ID: "demo-1234"
    }, {
      component: "runtime.render"
    });

    await logger.event("runtime.render.started");

    const contents = await fs.readFile(destination, "utf8");
    const [record] = contents.trim().split(/\r?\n/g).map((line) => JSON.parse(line));

    assert.equal(record.component, "runtime.render");
    assert.equal(record.data.projectName, "demo-workspace");
    assert.equal(record.data.instanceId, "demo-1234");
    assert.equal(record.data.processId, process.pid);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("withObservedStage emits started and finished stage records", async () => {
  const { tempRoot, repoRoot } = await createScratchRepo("stage-observability");

  try {
    const logger = createEventLogger({
      repoRoot,
      component: "cli",
      runId: "run-stage",
      correlationId: "root-stage"
    });

    const result = await withObservedStage(logger, "state.prepare", "state.prepare", async () => "ok", {
      data: {
        command: "up"
      },
      successData: {
        gatewayPort: "3456"
      }
    });

    const contents = await fs.readFile(resolveEventLogFile(repoRoot), "utf8");
    const records = contents.trim().split(/\r?\n/g).map((line) => JSON.parse(line));

    assert.equal(result, "ok");
    assert.equal(records.length, 2);
    assert.equal(records[0].event, "state.prepare.started");
    assert.equal(records[0].stage, "state.prepare");
    assert.equal(records[0].data.command, "up");
    assert.equal(records[1].event, "state.prepare.finished");
    assert.equal(records[1].stage, "state.prepare");
    assert.equal(records[1].data.command, "up");
    assert.equal(records[1].data.gatewayPort, "3456");
    assert.equal(typeof records[1].data.durationMs, "number");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
