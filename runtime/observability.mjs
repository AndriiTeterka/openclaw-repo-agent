import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { deepMerge, ensureDir, isPlainObject } from "./shared.mjs";

const EVENT_LOG_SCHEMA_VERSION = 1;
export const DEFAULT_EVENT_LOG_FILE = "events.jsonl";
export const REDACTED_VALUE = "[REDACTED]";

const INLINE_SECRET_VALUE_PATTERN = /(\b(?:api(?:[_-]?key)?|authorization|client(?:[_-]?secret)?|cookie|pass(?:word)?|private(?:[_-]?key)?|secret|token)\b)(\s*[:=]\s*)([^\s,;]+(?:\s+[^\s,;]+)?)/gi;
const SECRET_TEXT_PATTERNS = [
  {
    pattern: /(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: `$1 ${REDACTED_VALUE}`
  },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: REDACTED_VALUE
  },
  {
    pattern: /(https?:\/\/)([^@\s/]+)@/gi,
    replacement: `$1${REDACTED_VALUE}@`
  }
];

function createIdentifier() {
  return crypto.randomUUID();
}

function normalizeOptionalText(value) {
  return String(value ?? "").trim();
}

function normalizeRequiredText(value, label) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) throw new Error(`Structured event ${label} is required.`);
  return normalized;
}

function normalizeTimestamp(value) {
  const candidate = value instanceof Date ? value : (value ? new Date(value) : new Date());
  return Number.isNaN(candidate.getTime()) ? new Date().toISOString() : candidate.toISOString();
}

function normalizeKeyName(value) {
  return String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizeKeyName(key);
  return /(?:^|_)(api_key|authorization|client_secret|cookie|credential|passphrase|password|private_key|secret|token|session(?:_(?:id|key|token))?)(?:$|_)/.test(normalized);
}

function sanitizeText(value) {
  let sanitized = String(value ?? "");
  if (!sanitized) return "";

  for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized.replace(INLINE_SECRET_VALUE_PATTERN, (_, key, separator) => `${key}${separator}${REDACTED_VALUE}`);
}

function sanitizeError(value, visited = new WeakSet()) {
  if (!value) return undefined;

  if (value instanceof Error) {
    const payload = {
      name: sanitizeText(value.name || "Error"),
      message: sanitizeText(value.message || "")
    };
    if (value.code != null && value.code !== "") {
      payload.code = sanitizeText(String(value.code));
    }
    if (value.cause != null) {
      payload.cause = sanitizeEventValue(value.cause, visited);
    }
    return payload;
  }

  if (isPlainObject(value)) return sanitizeEventValue(value, visited);
  return { message: sanitizeText(String(value)) };
}

export function sanitizeEventValue(value, visited = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof URL) return sanitizeText(value.toString());
  if (value instanceof Error) return sanitizeError(value, visited);

  if (Array.isArray(value)) {
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
    try {
      return value.map((entry) => sanitizeEventValue(entry, visited));
    } finally {
      visited.delete(value);
    }
  }

  if (value instanceof Map) {
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
    try {
      return Object.fromEntries(
        [...value.entries()].map(([key, entry]) => [
          String(key),
          isSensitiveKey(key) ? REDACTED_VALUE : sanitizeEventValue(entry, visited)
        ])
      );
    } finally {
      visited.delete(value);
    }
  }

  if (value instanceof Set) {
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
    try {
      return [...value].map((entry) => sanitizeEventValue(entry, visited));
    } finally {
      visited.delete(value);
    }
  }

  if (typeof value === "object") {
    if (visited.has(value)) return "[Circular]";
    visited.add(value);
    try {
      const payload = {};
      for (const [key, entry] of Object.entries(value)) {
        payload[key] = isSensitiveKey(key) ? REDACTED_VALUE : sanitizeEventValue(entry, visited);
      }
      return payload;
    } finally {
      visited.delete(value);
    }
  }

  return value;
}

function resolvePayloadData(defaults, data) {
  const normalizedDefaults = isPlainObject(defaults) ? defaults : {};
  const hasDefaults = Object.keys(normalizedDefaults).length > 0;

  if (!hasDefaults && data === undefined) return undefined;
  if (hasDefaults && data === undefined) return sanitizeEventValue(normalizedDefaults);
  if (hasDefaults && isPlainObject(data)) return sanitizeEventValue(deepMerge(normalizedDefaults, data));
  if (hasDefaults) return sanitizeEventValue({ ...normalizedDefaults, value: data });
  return sanitizeEventValue(data);
}

export function resolveEventLogFile(repoRoot = process.cwd()) {
  const resolvedRepoRoot = path.resolve(normalizeOptionalText(repoRoot) || process.cwd());
  return path.join(resolvedRepoRoot, ".openclaw", "runtime", DEFAULT_EVENT_LOG_FILE);
}

function buildEventRecord(record = {}) {
  const requestedType = normalizeOptionalText(record.type);
  const stage = requestedType === "stage" ? normalizeRequiredText(record.stage, "stage") : normalizeOptionalText(record.stage);
  const type = stage ? "stage" : (requestedType || "event");
  const runId = normalizeOptionalText(record.runId) || createIdentifier();

  const payload = {
    schemaVersion: EVENT_LOG_SCHEMA_VERSION,
    timestamp: normalizeTimestamp(record.timestamp),
    type,
    component: normalizeOptionalText(record.component) || "openclaw",
    event: normalizeRequiredText(record.event, "name"),
    runId,
    correlationId: normalizeOptionalText(record.correlationId) || runId,
    level: normalizeOptionalText(record.level) || (record.error ? "error" : "info")
  };

  if (stage) payload.stage = stage;

  const message = sanitizeText(record.message);
  if (message) payload.message = message;

  const data = resolvePayloadData(record.defaults, record.data);
  if (data !== undefined) payload.data = data;

  const error = sanitizeError(record.error);
  if (error) payload.error = error;

  return payload;
}

async function writeEventRecord(destination, record = {}) {
  const target = path.resolve(normalizeRequiredText(destination, "destination"));
  const payload = buildEventRecord(record);
  await ensureDir(path.dirname(target));
  await fs.appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function createEventLogger(options = {}) {
  const repoRoot = path.resolve(normalizeOptionalText(options.repoRoot) || process.cwd());
  const destination = path.resolve(normalizeOptionalText(options.destination) || resolveEventLogFile(repoRoot));
  const component = normalizeOptionalText(options.component) || "openclaw";
  const runId = normalizeOptionalText(options.runId) || createIdentifier();
  const correlationId = normalizeOptionalText(options.correlationId) || runId;
  const defaults = isPlainObject(options.defaults) ? sanitizeEventValue(options.defaults) : {};
  const clock = typeof options.clock === "function" ? options.clock : (() => new Date());

  return {
    repoRoot,
    destination,
    component,
    runId,
    correlationId,
    child(bindings = {}) {
      return createEventLogger({
        repoRoot,
        destination,
        component: normalizeOptionalText(bindings.component) || component,
        runId,
        correlationId: normalizeOptionalText(bindings.correlationId) || correlationId,
        defaults: deepMerge(defaults, isPlainObject(bindings.defaults) ? bindings.defaults : {}),
        clock
      });
    },
    async event(event, entry = {}) {
      return await writeEventRecord(destination, {
        ...entry,
        component,
        runId,
        correlationId: normalizeOptionalText(entry.correlationId) || correlationId,
        defaults,
        event,
        timestamp: entry.timestamp ?? clock()
      });
    },
    async stage(stageName, event, entry = {}) {
      return await writeEventRecord(destination, {
        ...entry,
        component,
        runId,
        correlationId: normalizeOptionalText(entry.correlationId) || correlationId,
        defaults,
        stage: stageName,
        event,
        type: "stage",
        timestamp: entry.timestamp ?? clock()
      });
    }
  };
}

export function createProcessEventLogger(env = process.env, options = {}) {
  const destinationValue = normalizeOptionalText(options.destination)
    || normalizeOptionalText(env.OPENCLAW_EVENT_LOG_FILE);
  if (!destinationValue) return null;

  const repoRoot = path.resolve(
    normalizeOptionalText(options.repoRoot)
      || normalizeOptionalText(env.OPENCLAW_REPO_ROOT)
      || process.cwd()
  );
  const destination = path.resolve(
    destinationValue
  );
  const defaults = {};
  const projectName = normalizeOptionalText(env.OPENCLAW_PROJECT_NAME);
  const instanceId = normalizeOptionalText(env.OPENCLAW_INSTANCE_ID);

  defaults.processId = process.pid;
  if (projectName) defaults.projectName = projectName;
  if (instanceId) defaults.instanceId = instanceId;

  return createEventLogger({
    repoRoot,
    destination,
    component: normalizeOptionalText(options.component) || "runtime",
    runId: normalizeOptionalText(options.runId) || normalizeOptionalText(env.OPENCLAW_EVENT_RUN_ID),
    correlationId: normalizeOptionalText(options.correlationId) || normalizeOptionalText(env.OPENCLAW_EVENT_CORRELATION_ID),
    defaults: deepMerge(defaults, isPlainObject(options.defaults) ? options.defaults : {}),
    clock: options.clock
  });
}

async function safelyObserve(action) {
  try {
    return await action();
  } catch {
    return null;
  }
}

export async function emitObservedEvent(logger, event, entry = {}) {
  if (!logger?.event) return null;
  return await safelyObserve(() => logger.event(event, entry));
}

export async function emitObservedStage(logger, stageName, event, entry = {}) {
  if (!logger?.stage) return null;
  return await safelyObserve(() => logger.stage(stageName, event, entry));
}

function normalizeObservedData(value) {
  if (value === undefined) return {};
  if (isPlainObject(value)) return value;
  return { value };
}

export async function withObservedStage(logger, stageName, eventPrefix, task, options = {}) {
  if (typeof task !== "function") {
    throw new TypeError("withObservedStage requires a task function.");
  }

  if (!logger?.stage) {
    return await task(logger);
  }

  const startData = normalizeObservedData(options.data);
  const startedAt = Date.now();
  const stageLogger = logger.child({
    component: normalizeOptionalText(options.component) || logger.component,
    correlationId: normalizeOptionalText(options.correlationId) || undefined,
    defaults: isPlainObject(options.defaults) ? options.defaults : {}
  });

  await emitObservedStage(stageLogger, stageName, `${eventPrefix}.started`, {
    message: normalizeOptionalText(options.startMessage),
    data: startData
  });

  try {
    const result = await task(stageLogger);
    const successData = typeof options.buildSuccessData === "function"
      ? normalizeObservedData(options.buildSuccessData(result))
      : normalizeObservedData(options.successData);
    await emitObservedStage(stageLogger, stageName, `${eventPrefix}.finished`, {
      message: normalizeOptionalText(options.successMessage),
      data: {
        ...startData,
        durationMs: Date.now() - startedAt,
        ...successData
      }
    });
    return result;
  } catch (error) {
    await emitObservedStage(stageLogger, stageName, `${eventPrefix}.failed`, {
      level: "error",
      message: normalizeOptionalText(options.errorMessage),
      error,
      data: {
        ...startData,
        durationMs: Date.now() - startedAt
      }
    });
    throw error;
  }
}
