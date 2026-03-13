import path from "node:path";
import { createRequire } from "node:module";

import {
  ensureDir,
  fileExists,
  readJsonFile,
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

const require = createRequire(import.meta.url);

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function normalizeWorkspaceSkillsDirectory(value) {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  if (normalized.startsWith("/")) return DEFAULT_WORKSPACE_SKILLS_DIRECTORY;
  return normalized;
}

function normalizeWorkspaceSkillEntry(value) {
  if (typeof value === "string") {
    const source = value.startsWith("/") ? value : `/${value}`;
    return {
      slug: source.split("/").filter(Boolean).at(-1) || "",
      source,
      name: source.split("/").filter(Boolean).at(-1) || ""
    };
  }

  const sourceValue = String(value?.source ?? value?.reference ?? "").trim();
  const source = sourceValue
    ? (sourceValue.startsWith("/") ? sourceValue : `/${sourceValue}`)
    : "";
  const slug = String(value?.slug ?? "").trim() || source.split("/").filter(Boolean).at(-1) || "";
  const name = String(value?.name ?? "").trim() || slug;

  return {
    slug,
    source,
    name
  };
}

export function normalizeWorkspaceSkillsConfig(rawConfig = {}) {
  const rawRequired = Array.isArray(rawConfig?.required) && rawConfig.required.length > 0
    ? rawConfig.required
    : DEFAULT_REQUIRED_WORKSPACE_SKILLS;

  const required = [];
  for (const entry of rawRequired) {
    const normalized = normalizeWorkspaceSkillEntry(entry);
    if (!normalized.slug) continue;
    if (required.some((skill) => skill.slug === normalized.slug)) continue;
    required.push(normalized);
  }

  return {
    directory: normalizeWorkspaceSkillsDirectory(rawConfig?.directory),
    required
  };
}

function resolveWorkspaceSkillPath(repoRoot, directory, slug) {
  return path.resolve(repoRoot, directory, slug);
}

function resolveWorkspaceSkillMetaPath(repoRoot, directory, slug) {
  return path.join(resolveWorkspaceSkillPath(repoRoot, directory, slug), "_meta.json");
}

function resolveWorkspaceSkillsLockPath(openclawDir) {
  return path.join(openclawDir, ".clawhub", "lock.json");
}

function buildRequiredSkillMap(skills) {
  return Object.fromEntries(skills.required.map((skill) => [skill.slug, skill]));
}

async function readWorkspaceSkillsLock(openclawDir) {
  const payload = await readJsonFile(resolveWorkspaceSkillsLockPath(openclawDir), {
    version: 1,
    skills: {}
  });
  return payload && typeof payload === "object" ? payload : { version: 1, skills: {} };
}

async function readInstalledSkillState(repoRoot, directory, lockPayload, skill) {
  const skillPath = resolveWorkspaceSkillPath(repoRoot, directory, skill.slug);
  const skillFile = path.join(skillPath, "SKILL.md");
  const installed = await fileExists(skillFile);
  const meta = installed ? await readJsonFile(resolveWorkspaceSkillMetaPath(repoRoot, directory, skill.slug), null) : null;
  const lockEntry = lockPayload?.skills?.[skill.slug];

  return {
    installed,
    path: skillPath,
    version: String(meta?.version ?? lockEntry?.version ?? "").trim() || null,
    installedAt: Number(meta?.publishedAt ?? lockEntry?.installedAt ?? 0) || null
  };
}

function buildSkillStatusEntry(skill, installedState, persistedEntry = {}) {
  const installed = Boolean(installedState.installed);
  return {
    slug: skill.slug,
    source: skill.source,
    name: skill.name,
    installed,
    ready: installed,
    version: installedState.version,
    path: installedState.path,
    installedAt: installedState.installedAt,
    lastError: installed ? "" : String(persistedEntry.lastError ?? "").trim(),
    lastAttemptAt: String(persistedEntry.lastAttemptAt ?? "").trim() || ""
  };
}

export async function readWorkspaceSkillsStatus(context, rawSkillsConfig = {}) {
  const skills = normalizeWorkspaceSkillsConfig(rawSkillsConfig);
  const persisted = await readJsonFile(context.paths.skillsStatusFile, null);
  const persistedBySlug = Object.fromEntries(
    Array.isArray(persisted?.skills)
      ? persisted.skills.map((entry) => [String(entry?.slug ?? "").trim(), entry])
      : []
  );
  const lockPayload = await readWorkspaceSkillsLock(context.paths.openclawDir);
  const entries = [];

  for (const skill of skills.required) {
    const installedState = await readInstalledSkillState(context.repoRoot, skills.directory, lockPayload, skill);
    entries.push(buildSkillStatusEntry(skill, installedState, persistedBySlug[skill.slug]));
  }

  const readyCount = entries.filter((entry) => entry.ready).length;
  return {
    version: 1,
    directory: skills.directory,
    lockFile: resolveWorkspaceSkillsLockPath(context.paths.openclawDir),
    lastSyncAt: String(persisted?.lastSyncAt ?? "").trim() || "",
    configuredCount: entries.length,
    readyCount,
    ready: readyCount === entries.length,
    skills: entries
  };
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

async function installWorkspaceSkill(context, directory, skill) {
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
    cwd: context.repoRoot
  });
}

export async function syncWorkspaceSkills(context, rawSkillsConfig = {}, options = {}) {
  const skills = normalizeWorkspaceSkillsConfig(rawSkillsConfig);
  await ensureDir(context.paths.openclawDir);
  await ensureDir(path.resolve(context.repoRoot, skills.directory));

  const persisted = await readJsonFile(context.paths.skillsStatusFile, null);
  const statusBefore = await readWorkspaceSkillsStatus(context, skills);
  const errorBySlug = Object.fromEntries(
    statusBefore.skills.map((entry) => [entry.slug, entry.lastError])
  );
  const attemptedAt = new Date().toISOString();
  const installResults = [];

  for (const skill of skills.required) {
    const current = statusBefore.skills.find((entry) => entry.slug === skill.slug);
    if (current?.installed) continue;

    const result = options.installSkill
      ? await options.installSkill(skill, {
          context,
          directory: skills.directory
        })
      : await installWorkspaceSkill(context, skills.directory, skill);

    const output = result.code === 0
      ? ""
      : (result.stderr.trim() || result.stdout.trim() || `Failed to install ${skill.slug}.`);

    errorBySlug[skill.slug] = output;
    installResults.push({
      slug: skill.slug,
      ok: result.code === 0,
      output
    });
  }

  const statusAfter = await readWorkspaceSkillsStatus(context, skills);
  const persistedEntries = Object.fromEntries(
    statusAfter.skills.map((entry) => {
      const previous = Array.isArray(persisted?.skills)
        ? persisted.skills.find((item) => String(item?.slug ?? "").trim() === entry.slug)
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
    version: 1,
    directory: skills.directory,
    lastSyncAt: attemptedAt,
    configuredCount: statusAfter.configuredCount,
    readyCount: statusAfter.skills.filter((entry) => persistedEntries[entry.slug]?.installed).length,
    ready: statusAfter.skills.every((entry) => persistedEntries[entry.slug]?.installed),
    skills: statusAfter.skills.map((entry) => persistedEntries[entry.slug])
  };

  await writeJsonFileAtomic(context.paths.skillsStatusFile, payload);

  return {
    status: payload,
    installResults
  };
}

export function summarizeWorkspaceSkillsStatus(status) {
  const missing = status.skills.filter((entry) => !entry.ready);
  return {
    configuredCount: status.configuredCount,
    readyCount: status.readyCount,
    missing,
    ok: missing.length === 0
  };
}

export function summarizeWorkspaceSkillFailures(status) {
  return status.skills
    .filter((entry) => !entry.ready)
    .map((entry) => `${entry.name} (${entry.source || entry.slug})${entry.lastError ? `: ${entry.lastError}` : ""}`);
}
