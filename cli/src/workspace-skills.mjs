import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import {
  ensureDir,
  fileExists,
  readJsonFile,
  readTextFile,
  safeRunCommand,
  writeJsonFileAtomic
} from "../../runtime/shared.mjs";

export const DEFAULT_WORKSPACE_SKILLS_DIRECTORY = ".openclaw/skills";

export const DEFAULT_REQUIRED_WORKSPACE_SKILLS = [
  {
    slug: "skill-vetter",
    source: "/spclaudehome/skill-vetter",
    name: "Skill Vetter"
  },
  {
    slug: "find-skills",
    source: "/JimLiuxinghai/find-skills",
    name: "Find Skills"
  },
  {
    slug: "self-improving-agent",
    source: "/pskoett/self-improving-agent",
    name: "Self-Improving Agent"
  }
];

const WORKSPACE_SKILLS_STATUS_VERSION = 2;
const DISCOVERY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_DISCOVERED_WORKSPACE_SKILLS = 3;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERY_FILES = 24;
const WORKSPACE_SKILLS_DISCOVERY_TIMEOUT_MS = 60_000;
const WORKSPACE_SKILLS_INSTALL_TIMEOUT_MS = 300_000;
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".idea",
  ".next",
  ".openclaw",
  ".svn",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target"
]);
const DISCOVERY_FILE_NAMES = new Set([
  "agents.md",
  "build.gradle",
  "build.gradle.kts",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "dockerfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "readme.md",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts"
]);
const DISCOVERY_RULES = [
  { key: "appium", query: "appium", patterns: [/appium/i, /selenide-appium/i] },
  { key: "playwright", query: "playwright", patterns: [/playwright/i] },
  { key: "selenium", query: "selenium", patterns: [/selenium/i, /webdriver/i, /selenide/i] },
  { key: "docker", query: "docker", patterns: [/docker/i, /docker-compose/i, /compose\.ya?ml/i] },
  { key: "github", query: "github", patterns: [/github/i, /\.github[\\/]+workflows/i] },
  { key: "java", query: "java", patterns: [/pom\.xml/i, /build\.gradle/i, /settings\.gradle/i, /\bmaven\b/i, /\bgradle\b/i, /\bjava\b/i] },
  { key: "python", query: "python", patterns: [/pyproject\.toml/i, /requirements\.txt/i, /\bpytest\b/i, /\bpython\b/i] },
  { key: "node", query: "node", patterns: [/package\.json/i, /\bnpm\b/i, /\bpnpm\b/i, /\byarn\b/i, /\bnode\b/i] }
];

const require = createRequire(import.meta.url);

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function normalizeWorkspaceSkillsDirectory(value) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  if (normalized.startsWith("/")) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  if (/^[A-Za-z]:\//.test(normalized)) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  if (normalized.split("/").some((segment) => segment === "..")) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  return normalized;
}

function normalizeWorkspaceSkillEntry(value) {
  if (typeof value === "string") {
    const source = value.startsWith("/") ? value : `/${value}`;
    return {
      slug: source.split("/").filter(Boolean).at(-1) || "",
      source,
      name: source.split("/").filter(Boolean).at(-1) || "",
      category: "required",
      query: ""
    };
  }

  const sourceValue = String(value?.source ?? value?.reference ?? "").trim();
  const source = sourceValue
    ? (sourceValue.startsWith("/") ? sourceValue : `/${sourceValue}`)
    : "";
  const slug = String(value?.slug ?? "").trim() || source.split("/").filter(Boolean).at(-1) || "";
  const name = String(value?.name ?? "").trim() || slug;
  const category = String(value?.category ?? "required").trim() || "required";
  const query = String(value?.query ?? value?.discoveredByQuery ?? "").trim();

  return {
    slug,
    source,
    name,
    category,
    query
  };
}

function dedupeWorkspaceSkills(skills) {
  const seen = new Set();
  const entries = [];
  for (const skill of skills) {
    const normalized = normalizeWorkspaceSkillEntry(skill);
    if (!normalized.slug) continue;
    const key = normalized.slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(normalized);
  }
  return entries;
}

function humanizeSkillSlug(slug) {
  return String(slug ?? "")
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || String(slug ?? "");
}

function normalizeDiscoveredSkills(rawDiscovered, requiredSkills = []) {
  const requiredSlugs = new Set(requiredSkills.map((skill) => String(skill.slug ?? "").trim().toLowerCase()));
  const normalized = [];

  for (const entry of Array.isArray(rawDiscovered) ? rawDiscovered : []) {
    const skill = normalizeWorkspaceSkillEntry({
      ...entry,
      category: "discovered",
      name: entry?.name || humanizeSkillSlug(entry?.slug)
    });
    if (!skill.slug) continue;
    if (normalizeDiscoveredSkillSource(skill.source).toLowerCase() === "owner/repo" && skill.slug.toLowerCase() === "skill") continue;
    if (requiredSlugs.has(skill.slug.toLowerCase())) continue;
    if (normalized.some((item) => item.slug.toLowerCase() === skill.slug.toLowerCase())) continue;
    normalized.push(skill);
  }

  return normalized;
}

function normalizePersistedWorkspaceSkillsStatus(rawStatus = {}) {
  const rawSkills = Array.isArray(rawStatus?.skills) ? rawStatus.skills : [];
  const required = [];
  const discovered = [];

  for (const entry of rawSkills) {
    const normalized = {
      ...normalizeWorkspaceSkillEntry(entry),
      lastError: String(entry?.lastError ?? "").trim(),
      lastAttemptAt: String(entry?.lastAttemptAt ?? "").trim() || ""
    };
    if (!normalized.slug) continue;
    if (normalized.category === "discovered") discovered.push(normalized);
    else required.push(normalized);
  }

  return {
    version: Number(rawStatus?.version ?? 0) || 0,
    lastSyncAt: String(rawStatus?.lastSyncAt ?? "").trim() || "",
    lastDiscoveryAt: String(rawStatus?.lastDiscoveryAt ?? "").trim() || "",
    discoveryQueries: uniqueStrings(rawStatus?.discoveryQueries ?? []),
    discoveryErrors: normalizeDiscoveryErrors(rawStatus?.discoveryErrors ?? []),
    required,
    discovered
  };
}

function normalizeDiscoveryErrors(rawErrors = []) {
  const normalized = [];
  for (const entry of Array.isArray(rawErrors) ? rawErrors : []) {
    const query = String(entry?.query ?? "").trim();
    const error = String(entry?.error ?? entry?.message ?? "").trim();
    if (!query || !error) continue;
    if (normalized.some((item) => item.query === query && item.error === error)) continue;
    normalized.push({ query, error });
  }
  return normalized;
}

export function normalizeWorkspaceSkillsConfig(rawConfig = {}) {
  const rawRequired = Array.isArray(rawConfig?.required) && rawConfig.required.length > 0
    ? rawConfig.required
    : DEFAULT_REQUIRED_WORKSPACE_SKILLS;

  return {
    directory: normalizeWorkspaceSkillsDirectory(rawConfig?.directory),
    required: dedupeWorkspaceSkills(rawRequired).map((skill) => ({
      ...skill,
      category: "required",
      query: ""
    }))
  };
}

function resolveWorkspaceSkillPath(repoRoot, directory, slug) {
  return path.resolve(repoRoot, directory, slug);
}

function resolveWorkspaceSkillMetaPath(repoRoot, directory, slug) {
  return path.join(resolveWorkspaceSkillPath(repoRoot, directory, slug), "_meta.json");
}

function resolveClawhubLockPath(openclawDir) {
  return path.join(openclawDir, ".clawhub", "lock.json");
}

function resolveSkillsCliLockPath(openclawDir) {
  return path.join(openclawDir, "skills-lock.json");
}

async function readClawhubLock(openclawDir) {
  const payload = await readJsonFile(resolveClawhubLockPath(openclawDir), {
    version: 1,
    skills: {}
  });
  return payload && typeof payload === "object" ? payload : { version: 1, skills: {} };
}

async function readSkillsCliLock(openclawDir) {
  const payload = await readJsonFile(resolveSkillsCliLockPath(openclawDir), {
    version: 1,
    skills: {}
  });
  return payload && typeof payload === "object" ? payload : { version: 1, skills: {} };
}

async function readInstalledSkillState(repoRoot, directory, locks, skill) {
  const skillPath = resolveWorkspaceSkillPath(repoRoot, directory, skill.slug);
  const skillFile = path.join(skillPath, "SKILL.md");
  const installed = await fileExists(skillFile);
  const meta = installed ? await readJsonFile(resolveWorkspaceSkillMetaPath(repoRoot, directory, skill.slug), null) : null;
  const clawhubLockEntry = locks.clawhub?.skills?.[skill.slug];
  const skillsCliLockEntry = locks.skillsCli?.skills?.[skill.slug];

  return {
    installed,
    path: skillPath,
    version: String(meta?.version ?? clawhubLockEntry?.version ?? "").trim() || null,
    installedAt: Number(meta?.installedAt ?? meta?.publishedAt ?? clawhubLockEntry?.installedAt ?? 0) || null,
    source: String(meta?.source ?? skill.source ?? skillsCliLockEntry?.source ?? "").trim() || null
  };
}

function buildSkillStatusEntry(skill, installedState, persistedEntry = {}) {
  const installed = Boolean(installedState.installed);
  return {
    slug: skill.slug,
    source: installedState.source || skill.source,
    name: skill.name,
    category: skill.category || "required",
    query: skill.query || "",
    installed,
    ready: installed,
    version: installedState.version,
    path: installedState.path,
    installedAt: installedState.installedAt,
    lastError: installed ? "" : String(persistedEntry.lastError ?? "").trim(),
    lastAttemptAt: String(persistedEntry.lastAttemptAt ?? "").trim() || ""
  };
}

async function buildWorkspaceSkillsStatus(context, directory, skills, persistedState) {
  const persistedBySlug = Object.fromEntries(
    [
      ...(Array.isArray(persistedState?.required) ? persistedState.required : []),
      ...(Array.isArray(persistedState?.discovered) ? persistedState.discovered : [])
    ].map((entry) => [String(entry?.slug ?? "").trim(), entry])
  );
  const locks = {
    clawhub: await readClawhubLock(context.paths.openclawDir),
    skillsCli: await readSkillsCliLock(context.paths.openclawDir)
  };
  const entries = [];

  for (const skill of skills) {
    const installedState = await readInstalledSkillState(context.repoRoot, directory, locks, skill);
    entries.push(buildSkillStatusEntry(skill, installedState, persistedBySlug[skill.slug]));
  }

  const requiredEntries = entries.filter((entry) => entry.category === "required");
  const discoveredEntries = entries.filter((entry) => entry.category === "discovered");
  const readyCount = entries.filter((entry) => entry.ready).length;
  const requiredReadyCount = requiredEntries.filter((entry) => entry.ready).length;
  const discoveredReadyCount = discoveredEntries.filter((entry) => entry.ready).length;

  return {
    version: WORKSPACE_SKILLS_STATUS_VERSION,
    directory,
    clawhubLockFile: resolveClawhubLockPath(context.paths.openclawDir),
    skillsLockFile: resolveSkillsCliLockPath(context.paths.openclawDir),
    lastSyncAt: String(persistedState?.lastSyncAt ?? "").trim() || "",
    lastDiscoveryAt: String(persistedState?.lastDiscoveryAt ?? "").trim() || "",
    discoveryQueries: uniqueStrings(persistedState?.discoveryQueries ?? []),
    discoveryErrors: normalizeDiscoveryErrors(persistedState?.discoveryErrors ?? []),
    configuredCount: entries.length,
    readyCount,
    requiredCount: requiredEntries.length,
    requiredReadyCount,
    discoveredCount: discoveredEntries.length,
    discoveredReadyCount,
    ready: requiredReadyCount === requiredEntries.length,
    allReady: readyCount === entries.length,
    skills: entries
  };
}

export async function readWorkspaceSkillsStatus(context, rawSkillsConfig = {}) {
  const skills = normalizeWorkspaceSkillsConfig(rawSkillsConfig);
  const persisted = normalizePersistedWorkspaceSkillsStatus(await readJsonFile(context.paths.skillsStatusFile, null));
  const discovered = normalizeDiscoveredSkills(persisted.discovered, skills.required);
  const entries = [
    ...skills.required,
    ...discovered
  ];

  return await buildWorkspaceSkillsStatus(context, skills.directory, entries, persisted);
}

function resolveClawhubInvocation() {
  try {
    const binPath = require.resolve("clawhub/bin/clawdhub.js");
    return {
      command: process.execPath,
      args: [binPath]
    };
  } catch {
    return {
      command: "npx",
      args: ["--yes", "clawhub"]
    };
  }
}

function resolveSkillsCliInvocation() {
  try {
    const packageJsonPath = require.resolve("skills/package.json");
    const packageJson = require(packageJsonPath);
    const packageRoot = path.dirname(packageJsonPath);
    const binEntry = typeof packageJson?.bin === "string"
      ? packageJson.bin
      : Object.values(packageJson?.bin ?? {})[0];
    if (typeof binEntry === "string" && binEntry.trim()) {
      return {
        command: process.execPath,
        args: [path.resolve(packageRoot, binEntry)]
      };
    }
  } catch {}

  return {
    command: "npx",
    args: ["--yes", "skills"]
  };
}

function buildSkillsCommandEnv(context) {
  const gitConfigPath = path.join(context.paths.stateDir, "gitconfig");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_TERMINAL_PROMPT: "0"
  };
}

async function ensureSkillsCommandEnv(context) {
  await ensureDir(context.paths.stateDir);
  const gitConfigPath = path.join(context.paths.stateDir, "gitconfig");
  if (!(await fileExists(gitConfigPath))) {
    await fs.writeFile(gitConfigPath, "[init]\n\tdefaultBranch = main\n", "utf8");
  }
  return buildSkillsCommandEnv(context);
}

async function installWorkspaceSkill(context, directory, skill) {
  if (String(skill.source ?? "").trim()) {
    return await installWorkspaceSkillFromSource(context, directory, skill);
  }

  const installRoot = path.resolve(context.repoRoot, directory);
  const clawhubDir = path.relative(context.paths.openclawDir, installRoot) || ".";
  const invocation = resolveClawhubInvocation();

  return await safeRunCommand(invocation.command, [
    ...invocation.args,
    "install",
    skill.slug,
    "--workdir",
    context.paths.openclawDir,
    "--dir",
    clawhubDir,
    "--no-input"
  ], {
    cwd: context.repoRoot,
    timeoutMs: WORKSPACE_SKILLS_INSTALL_TIMEOUT_MS
  });
}

function normalizeDiscoveredSkillSource(source) {
  return String(source ?? "").trim().replace(/^\/+/, "");
}

async function installWorkspaceSkillFromSource(context, directory, skill) {
  const invocation = resolveSkillsCliInvocation();
  const source = normalizeDiscoveredSkillSource(skill.source);
  if (!source) {
    return {
      code: 1,
      stdout: "",
      stderr: `Missing source repository for skill ${skill.slug}.`
    };
  }

  const installStageRoot = path.join(
    context.paths.stateDir,
    "skills-stage",
    `${skill.slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  const stagedSkillPath = path.join(installStageRoot, "skills", skill.slug);
  const targetSkillPath = resolveWorkspaceSkillPath(context.repoRoot, directory, skill.slug);

  try {
    await ensureDir(installStageRoot);
    const result = await safeRunCommand(invocation.command, [
      ...invocation.args,
      "add",
      source,
      "--skill",
      skill.slug,
      "--agent",
      "openclaw",
      "--copy",
      "-y"
    ], {
      cwd: installStageRoot,
      env: await ensureSkillsCommandEnv(context),
      timeoutMs: WORKSPACE_SKILLS_INSTALL_TIMEOUT_MS
    });
    if (result.code !== 0) return result;

    const stagedSkillFile = path.join(stagedSkillPath, "SKILL.md");
    if (!(await fileExists(stagedSkillFile))) {
      return {
        code: 1,
        stdout: result.stdout,
        stderr: result.stderr.trim() || `Installed skill ${skill.slug}, but no SKILL.md was produced.`
      };
    }

    await ensureDir(path.dirname(targetSkillPath));
    await fs.rm(targetSkillPath, { recursive: true, force: true });
    await fs.cp(stagedSkillPath, targetSkillPath, { recursive: true, force: true });

    const metaPath = path.join(targetSkillPath, "_meta.json");
    if (!(await fileExists(metaPath))) {
      await writeJsonFileAtomic(metaPath, {
        slug: skill.slug,
        source: skill.source,
        installedAt: Date.now()
      });
    }

    return result;
  } finally {
    await fs.rm(installStageRoot, { recursive: true, force: true });
  }
}

export function parseSkillsFindResults(output) {
  const text = stripAnsi(output);
  const matches = [...text.matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/g)];
  const seen = new Set();
  const results = [];

  for (const match of matches) {
    const repository = String(match[1] ?? "").trim();
    const slug = String(match[2] ?? "").trim();
    if (!repository || !slug) continue;
    if (repository.toLowerCase() === "owner/repo" && slug.toLowerCase() === "skill") continue;
    const key = `${repository.toLowerCase()}@${slug.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      slug,
      source: `/${repository}`,
      name: humanizeSkillSlug(slug),
      query: ""
    });
  }

  return results;
}

async function runSkillsFindQuery(context, query) {
  const invocation = resolveSkillsCliInvocation();
  const result = await safeRunCommand(invocation.command, [
    ...invocation.args,
    "find",
    query
  ], {
    cwd: context.paths.openclawDir,
    env: await ensureSkillsCommandEnv(context),
    timeoutMs: WORKSPACE_SKILLS_DISCOVERY_TIMEOUT_MS
  });

  if (result.code !== 0) return { query, results: [], error: result.stderr.trim() || result.stdout.trim() || `Failed to search skills for ${query}.` };

  return {
    query,
    results: parseSkillsFindResults(result.stdout).map((entry) => ({
      ...entry,
      query
    })),
    error: ""
  };
}

async function collectDiscoveryFiles(rootDir, currentDir, depth, files) {
  if (files.length >= MAX_DISCOVERY_FILES || depth > MAX_DISCOVERY_DEPTH) return;

  let entries = [];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (files.length >= MAX_DISCOVERY_FILES) break;
    const nameLower = entry.name.toLowerCase();
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DISCOVERY_DIRECTORIES.has(nameLower)) continue;
      await collectDiscoveryFiles(rootDir, fullPath, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (DISCOVERY_FILE_NAMES.has(nameLower) || /(appium|playwright|selenium|docker|github)/i.test(entry.name)) {
      files.push({
        fullPath,
        relativePath: path.relative(rootDir, fullPath).replace(/\\/g, "/")
      });
    }
  }
}

async function detectWorkspaceSkillSignals(context) {
  const tags = new Set();
  const repoName = path.basename(path.resolve(context.repoRoot));
  const files = [];
  await collectDiscoveryFiles(context.repoRoot, context.repoRoot, 0, files);

  function tagText(value) {
    for (const rule of DISCOVERY_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(value))) tags.add(rule.key);
    }
  }

  tagText(repoName);
  for (const file of files) {
    tagText(file.relativePath);
    const fileName = path.basename(file.fullPath).toLowerCase();

    if (fileName === "package.json") {
      const packageJson = await readJsonFile(file.fullPath, {});
      const dependencies = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
        ...packageJson.optionalDependencies,
        ...packageJson.scripts
      };
      tagText(JSON.stringify(dependencies));
      continue;
    }

    const raw = await readTextFile(file.fullPath, "");
    if (raw) tagText(raw.slice(0, 200_000));
  }

  return tags;
}

export async function detectWorkspaceSkillQueries(context) {
  const tags = await detectWorkspaceSkillSignals(context);
  return DISCOVERY_RULES
    .filter((rule) => tags.has(rule.key))
    .map((rule) => rule.query);
}

function shouldRefreshDiscoveredSkills(persisted, options = {}) {
  if (options.forceDiscovery) return true;
  const lastDiscoveryAt = Date.parse(String(persisted?.lastDiscoveryAt ?? ""));
  if (!Number.isFinite(lastDiscoveryAt)) return true;
  if (!Array.isArray(persisted?.discovered) || persisted.discovered.length === 0) return true;
  return (Date.now() - lastDiscoveryAt) >= DISCOVERY_COOLDOWN_MS;
}

async function resolveDiscoveredWorkspaceSkills(context, requiredSkills, persisted, options = {}) {
  const persistedDiscovered = normalizeDiscoveredSkills(persisted.discovered, requiredSkills);
  const queries = uniqueStrings(
    Array.isArray(options.discoveryQueries) && options.discoveryQueries.length > 0
      ? options.discoveryQueries
      : await detectWorkspaceSkillQueries(context)
  );

  if (!shouldRefreshDiscoveredSkills(persisted, options)) {
    return {
      discovered: persistedDiscovered,
      queries: persisted.discoveryQueries.length > 0 ? persisted.discoveryQueries : queries,
      refreshed: false,
      errors: normalizeDiscoveryErrors(persisted.discoveryErrors)
    };
  }

  let discovered = [...persistedDiscovered];
  if (typeof options.discoverSkills === "function") {
    const result = await options.discoverSkills({
      context,
      queries,
      requiredSkills,
      persistedDiscovered
    });
    const rawDiscovered = Array.isArray(result) ? result : result?.discovered;
    discovered = normalizeDiscoveredSkills(rawDiscovered, requiredSkills);
    return {
      discovered,
      queries,
      refreshed: true,
      errors: normalizeDiscoveryErrors(Array.isArray(result) ? [] : result?.errors)
    };
  }

  const errors = [];
  for (const query of queries) {
    if (discovered.length >= MAX_DISCOVERED_WORKSPACE_SKILLS) break;
    const search = await runSkillsFindQuery(context, query);
    if (search.error) {
      errors.push({ query, error: search.error });
      continue;
    }
    const candidate = search.results.find((entry) => {
      const slug = entry.slug.toLowerCase();
      return !requiredSkills.some((skill) => skill.slug.toLowerCase() === slug)
        && !discovered.some((skill) => skill.slug.toLowerCase() === slug);
    });
    if (!candidate) continue;
    discovered.push({
      ...candidate,
      category: "discovered",
      query
    });
  }

  return {
    discovered,
    queries,
    refreshed: true,
    errors
  };
}

export async function syncWorkspaceSkills(context, rawSkillsConfig = {}, options = {}) {
  const skills = normalizeWorkspaceSkillsConfig(rawSkillsConfig);
  await ensureDir(context.paths.openclawDir);
  await ensureDir(path.resolve(context.repoRoot, skills.directory));

  const persisted = normalizePersistedWorkspaceSkillsStatus(await readJsonFile(context.paths.skillsStatusFile, null));
  const discovery = await resolveDiscoveredWorkspaceSkills(context, skills.required, persisted, options);
  const entries = [
    ...skills.required,
    ...normalizeDiscoveredSkills(discovery.discovered, skills.required)
  ];
  const statusBefore = await buildWorkspaceSkillsStatus(context, skills.directory, entries, {
    ...persisted,
    discoveryQueries: discovery.queries,
    discoveryErrors: discovery.errors
  });
  const errorBySlug = Object.fromEntries(
    statusBefore.skills.map((entry) => [entry.slug, entry.lastError])
  );
  const attemptedAt = new Date().toISOString();
  const installResults = [];

  for (const skill of entries) {
    const current = statusBefore.skills.find((entry) => entry.slug === skill.slug);
    if (current?.installed) continue;
    if (skill.category === "discovered") continue;

    const result = typeof options.installSkill === "function"
      ? await options.installSkill(skill, {
          context,
          directory: skills.directory,
          category: skill.category
        })
      : await installWorkspaceSkill(context, skills.directory, skill);

    const output = result.code === 0
      ? ""
      : (result.stderr.trim() || result.stdout.trim() || `Failed to install ${skill.slug}.`);

    errorBySlug[skill.slug] = output;
    installResults.push({
      slug: skill.slug,
      category: skill.category,
      ok: result.code === 0,
      output
    });
  }

  const statusAfter = await buildWorkspaceSkillsStatus(context, skills.directory, entries, {
    ...persisted,
    discoveryQueries: discovery.queries,
    discoveryErrors: discovery.errors
  });
  const persistedEntries = Object.fromEntries(
    statusAfter.skills.map((entry) => {
      const previous = Array.isArray(persisted?.required) || Array.isArray(persisted?.discovered)
        ? [...persisted.required, ...persisted.discovered].find((item) => String(item?.slug ?? "").trim() === entry.slug)
        : null;
      return [entry.slug, {
        ...entry,
        lastError: entry.installed ? "" : errorBySlug[entry.slug] || String(previous?.lastError ?? "").trim(),
        lastAttemptAt: installResults.some((result) => result.slug === entry.slug)
          ? attemptedAt
          : String(previous?.lastAttemptAt ?? "").trim()
      }];
    })
  );

  const payload = {
    version: WORKSPACE_SKILLS_STATUS_VERSION,
    directory: skills.directory,
    lastSyncAt: attemptedAt,
    lastDiscoveryAt: discovery.refreshed ? attemptedAt : persisted.lastDiscoveryAt,
    discoveryQueries: discovery.queries,
    discoveryErrors: discovery.errors,
    configuredCount: statusAfter.configuredCount,
    readyCount: statusAfter.skills.filter((entry) => persistedEntries[entry.slug]?.installed).length,
    requiredCount: statusAfter.requiredCount,
    requiredReadyCount: statusAfter.skills
      .filter((entry) => entry.category === "required" && persistedEntries[entry.slug]?.installed)
      .length,
    discoveredCount: statusAfter.discoveredCount,
    discoveredReadyCount: statusAfter.skills
      .filter((entry) => entry.category === "discovered" && persistedEntries[entry.slug]?.installed)
      .length,
    ready: statusAfter.skills
      .filter((entry) => entry.category === "required")
      .every((entry) => persistedEntries[entry.slug]?.installed),
    allReady: statusAfter.skills.every((entry) => persistedEntries[entry.slug]?.installed),
    skills: statusAfter.skills.map((entry) => persistedEntries[entry.slug])
  };

  await writeJsonFileAtomic(context.paths.skillsStatusFile, payload);

  return {
    status: payload,
    installResults
  };
}

export function summarizeWorkspaceSkillsStatus(status) {
  const missing = status.skills.filter((entry) => entry.category === "required" && !entry.ready);
  const recommendations = status.skills.filter((entry) => entry.category === "discovered");
  const pendingRecommendations = recommendations.filter((entry) => !entry.ready);
  const discoveryErrors = normalizeDiscoveryErrors(status.discoveryErrors);
  return {
    configuredCount: status.configuredCount,
    readyCount: status.readyCount,
    requiredCount: status.requiredCount,
    requiredReadyCount: status.requiredReadyCount,
    discoveredCount: status.discoveredCount,
    discoveredReadyCount: status.discoveredReadyCount,
    missing,
    recommendations,
    pendingRecommendations,
    discoveryErrors,
    ok: missing.length === 0,
    allReady: missing.length === 0 && discoveryErrors.length === 0
  };
}

export function summarizeWorkspaceSkillFailures(status) {
  return status.skills
    .filter((entry) => (entry.category === "required" && !entry.ready) || Boolean(String(entry.lastError ?? "").trim()))
    .map((entry) => `${entry.name} (${entry.source || entry.slug})${entry.lastError ? `: ${entry.lastError}` : ""}`);
}
