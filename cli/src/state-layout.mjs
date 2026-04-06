import os from "node:os";
import path from "node:path";

import { PRODUCT_NAME } from "./product-metadata.mjs";

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_INSTRUCTIONS_FILE = "instructions.md";
const DEFAULT_SECRETS_ENV_FILE = "secrets.env";
const DEFAULT_RUNTIME_ENV_FILE = "runtime.env";
const DEFAULT_RUNTIME_COMPOSE_FILE = "docker-compose.openclaw.yml";
const DEFAULT_EVENT_LOG_FILE = "events.jsonl";

export const PROVIDER_HOME_LAYOUT = Object.freeze({
  codex: Object.freeze({
    envKey: "CODEX_HOME",
    mountPathEnvKey: "OPENCLAW_CODEX_HOME_MOUNT_PATH",
    defaultDirName: ".codex",
    runtimePath: "/home/node/.codex"
  }),
  gemini: Object.freeze({
    envKey: "GEMINI_CLI_HOME",
    mountPathEnvKey: "OPENCLAW_GEMINI_CLI_HOME_MOUNT_PATH",
    defaultDirName: ".gemini",
    runtimePath: "/home/node/.gemini"
  }),
  copilot: Object.freeze({
    envKey: "COPILOT_HOME",
    mountPathEnvKey: "OPENCLAW_COPILOT_HOME_MOUNT_PATH",
    defaultDirName: ".copilot",
    runtimePath: "/home/node/.copilot"
  })
});

export const COPILOT_SUPPORT_HOME_LAYOUT = Object.freeze({
  agents: Object.freeze({
    envKey: "OPENCLAW_AGENTS_HOME",
    mountPathEnvKey: "OPENCLAW_AGENTS_HOME_MOUNT_PATH",
    defaultDirName: ".agents",
    runtimePath: "/home/node/.agents"
  }),
  claude: Object.freeze({
    envKey: "OPENCLAW_CLAUDE_HOME",
    mountPathEnvKey: "OPENCLAW_CLAUDE_HOME_MOUNT_PATH",
    defaultDirName: ".claude",
    runtimePath: "/home/node/.claude"
  })
});

function resolveStateRoot(env = process.env) {
  const overrideRoot = String(env.OPENCLAW_REPO_AGENT_STATE_HOME ?? "").trim();
  if (overrideRoot) return path.join(path.resolve(overrideRoot), PRODUCT_NAME);

  if (process.platform === "win32") {
    const localAppData = String(env.LOCALAPPDATA ?? "").trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, PRODUCT_NAME);
  }

  const xdgStateHome = String(env.XDG_STATE_HOME ?? "").trim();
  const stateRoot = xdgStateHome ? path.resolve(xdgStateHome) : path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, PRODUCT_NAME);
}

function resolveMountRoot(env = process.env) {
  const overrideRoot = String(env.OPENCLAW_REPO_AGENT_MOUNT_HOME ?? "").trim();
  if (overrideRoot) return path.join(path.resolve(overrideRoot), PRODUCT_NAME);

  if (process.platform === "win32") {
    const userProfile = String(env.USERPROFILE ?? "").trim() || os.homedir();
    return path.join(userProfile, ".openclaw-repo-agent-mounts");
  }

  return resolveStateRoot(env);
}

function resolveRepoPaths(repoRoot) {
  const openclawDir = path.join(repoRoot, ".openclaw");
  const runtimeDir = path.join(openclawDir, "runtime");
  const playwrightDir = path.join(openclawDir, "playwright");
  return {
    openclawDir,
    configFile: path.join(openclawDir, DEFAULT_CONFIG_FILE),
    instructionsFile: path.join(openclawDir, DEFAULT_INSTRUCTIONS_FILE),
    runtimeDir,
    runtimeEnvFile: path.join(runtimeDir, DEFAULT_RUNTIME_ENV_FILE),
    composeFile: path.join(runtimeDir, DEFAULT_RUNTIME_COMPOSE_FILE),
    eventLogFile: path.join(runtimeDir, DEFAULT_EVENT_LOG_FILE),
    renderStatusFile: path.join(runtimeDir, "render-status.json"),
    playwrightDir,
    playwrightArtifactsDir: path.join(playwrightDir, "artifacts"),
    playwrightConfigFile: path.join(playwrightDir, "cli.config.json"),
  };
}

function resolveProviderHomeRoot(definition, env = process.env) {
  const overrideRoot = String(env[definition.envKey] ?? "").trim();
  const resolvedRoot = overrideRoot || path.join(os.homedir(), definition.defaultDirName);
  return path.resolve(resolvedRoot);
}

export function resolveProviderHomes(env = process.env) {
  return Object.fromEntries(
    Object.entries(PROVIDER_HOME_LAYOUT).map(([agentId, definition]) => [
      agentId,
      resolveProviderHomeRoot(definition, env)
    ])
  );
}

export function resolveCopilotSupportHomes(env = process.env) {
  return Object.fromEntries(
    Object.entries(COPILOT_SUPPORT_HOME_LAYOUT).map(([homeId, definition]) => [
      homeId,
      resolveProviderHomeRoot(definition, env)
    ])
  );
}

export function resolveAgentPaths(repoRoot, instanceId, env = process.env) {
  const repoPaths = resolveRepoPaths(repoRoot);
  const stateRoot = resolveStateRoot(env);
  const mountRoot = resolveMountRoot(env);
  const instanceRoot = path.join(stateRoot, "instances", instanceId);
  const mountInstanceRoot = path.join(mountRoot, "instances", instanceId);
  const toolingDir = path.join(instanceRoot, "tooling");
  const providerHomes = resolveProviderHomes(env);
  const copilotSupportHomes = resolveCopilotSupportHomes(env);

  return {
    ...repoPaths,
    stateRoot,
    mountRoot,
    instanceRoot,
    mountInstanceRoot,
    stateFile: path.join(instanceRoot, "state.json"),
    instanceLockFile: path.join(instanceRoot, "instance.lock"),
    secretsEnvFile: path.join(instanceRoot, DEFAULT_SECRETS_ENV_FILE),
    copilotSessionStateDir: path.join(mountInstanceRoot, "copilot-session-state"),
    toolingDir,
    toolingManifestFile: path.join(toolingDir, "tooling.manifest.json"),
    toolingContextDir: path.join(toolingDir, "context"),
    toolingScriptsDir: path.join(toolingDir, "scripts"),
    providerHomes,
    copilotSupportHomes,
    pathsManifestFile: path.join(instanceRoot, "paths.json")
  };
}

export function toDisplayPath(basePath, targetPath) {
  const relative = path.relative(basePath, targetPath);
  return relative && !relative.startsWith("..") ? relative : targetPath;
}
