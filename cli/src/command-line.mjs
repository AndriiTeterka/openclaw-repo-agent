import { resolveBoolean } from "../../runtime/shared.mjs";

const ARRAY_FLAGS = new Set([
  "verification-command",
  "allow-user",
  "group-allow-user",
  "acp-allowed-agent"
]);

const BOOLEAN_FLAGS = new Set([
  "yes",
  "non-interactive",
  "json",
  "fix",
  "verify",
  "topic-acp",
  "check-updates",
  "reassign-port",
  "force"
]);

const STRING_FLAGS = new Set([
  "repo-root",
  "product-root",
  "profile",
  "project-name",
  "tooling-profile",
  "runtime-profile",
  "queue-profile",
  "deployment-profile",
  "auth-mode",
  "agent-default-model",
  "acp-default-agent",
  "approve",
  "switch-dm-policy",
  "switch-group-policy",
  "dm-policy",
  "group-policy",
  "reply-to-mode",
  "stream-mode",
  "telegram-proxy",
  "auto-select-family",
  "telegram-bot-token",
  "openai-api-key",
  "target-auth-path",
  "gateway-url",
  "gateway-token",
  "gateway-password"
]);

function parseBooleanString(rawValue, fallback) {
  return resolveBoolean(rawValue, fallback);
}

function isBooleanLike(value) {
  return ["true", "false", "yes", "no", "1", "0", "on", "off"].includes(String(value ?? "").toLowerCase());
}

function readOptionValue(argv, index, key, inlineValue) {
  if (inlineValue != null) {
    if (inlineValue === "") throw new Error(`Missing value for --${key}`);
    return {
      value: inlineValue,
      nextIndex: index
    };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("--") || next === "-h" || next === "-v") {
    throw new Error(`Missing value for --${key}`);
  }

  return {
    value: next,
    nextIndex: index + 1
  };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "-v" || token === "--version") {
      options.version = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    const separatorIndex = option.indexOf("=");
    const key = separatorIndex >= 0 ? option.slice(0, separatorIndex) : option;
    const inlineValue = separatorIndex >= 0 ? option.slice(separatorIndex + 1) : null;
    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue != null) {
        options[toCamelCase(key)] = parseBooleanString(inlineValue, true);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && next !== "-h" && next !== "-v" && isBooleanLike(next)) {
        options[toCamelCase(key)] = parseBooleanString(next, true);
        index += 1;
      } else {
        options[toCamelCase(key)] = true;
      }
      continue;
    }

    if (ARRAY_FLAGS.has(key)) {
      const { value, nextIndex } = readOptionValue(argv, index, key, inlineValue);
      const optionKey = toCamelCase(key);
      if (!Array.isArray(options[optionKey])) options[optionKey] = [];
      options[optionKey].push(value);
      index = nextIndex;
      continue;
    }

    if (STRING_FLAGS.has(key)) {
      const { value, nextIndex } = readOptionValue(argv, index, key, inlineValue);
      options[toCamelCase(key)] = value;
      index = nextIndex;
      continue;
    }

    throw new Error(`Unknown option: --${key}`);
  }

  return {
    positionals,
    options
  };
}

export function describeCommandFromArgv(argv = []) {
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    if (!token || token === "-h" || token === "--help" || token === "-v" || token === "--version") {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const option = token.slice(2);
    const separatorIndex = option.indexOf("=");
    const key = separatorIndex >= 0 ? option.slice(0, separatorIndex) : option;
    const inlineValue = separatorIndex >= 0 ? option.slice(separatorIndex + 1) : null;

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue == null) {
        const next = argv[index + 1];
        if (next && !next.startsWith("--") && next !== "-h" && next !== "-v" && isBooleanLike(next)) {
          index += 1;
        }
      }
      continue;
    }

    if ((ARRAY_FLAGS.has(key) || STRING_FLAGS.has(key)) && inlineValue == null) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--") && next !== "-h" && next !== "-v") {
        index += 1;
      }
    }
  }

  if (positionals.length === 0) return "";
  if (["config", "instances"].includes(positionals[0]) && positionals[1]) {
    return `${positionals[0]} ${positionals[1]}`;
  }
  return positionals[0];
}
