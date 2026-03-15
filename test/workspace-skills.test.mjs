import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_REQUIRED_WORKSPACE_SKILLS,
  DEFAULT_WORKSPACE_SKILLS_DIRECTORY,
  detectWorkspaceSkillQueries,
  normalizeWorkspaceSkillsConfig,
  parseSkillsFindResults,
  readWorkspaceSkillsStatus,
  summarizeWorkspaceSkillsStatus,
  syncWorkspaceSkills
} from "../cli/src/workspace-skills.mjs";

async function withTempWorkspace(assertion) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-"));
  const openclawDir = path.join(repoRoot, ".openclaw");
  const stateDir = path.join(openclawDir, "state");
  await fs.mkdir(stateDir, { recursive: true });
  try {
    await assertion({
      repoRoot,
      detection: {
        projectName: path.basename(repoRoot),
        toolingProfile: "none",
        instructionCandidates: [],
        knowledgeCandidates: [],
        verificationCommands: []
      },
      paths: {
        openclawDir,
        stateDir,
        skillsStatusFile: path.join(stateDir, "skills-status.json")
      }
    });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeInstalledSkill(context, skill, version = "0.1.0") {
  const skillsRoot = path.join(context.paths.openclawDir, "skills");
  const skillDir = path.join(skillsRoot, skill.slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${skill.name}\n`);
  await fs.writeFile(path.join(skillDir, "_meta.json"), JSON.stringify({
    slug: skill.slug,
    version
  }, null, 2));
}

test("normalizeWorkspaceSkillsConfig provides the mandatory baseline defaults", () => {
  const skills = normalizeWorkspaceSkillsConfig({});

  assert.equal(skills.directory, DEFAULT_WORKSPACE_SKILLS_DIRECTORY);
  assert.deepEqual(skills.required, DEFAULT_REQUIRED_WORKSPACE_SKILLS.map((skill) => ({
    ...skill,
    category: "required",
    query: ""
  })));
});

test("normalizeWorkspaceSkillsConfig rejects absolute host paths for the skills directory", () => {
  assert.equal(
    normalizeWorkspaceSkillsConfig({ directory: "C:/Users/demo/skills" }).directory,
    DEFAULT_WORKSPACE_SKILLS_DIRECTORY
  );
  assert.equal(
    normalizeWorkspaceSkillsConfig({ directory: "\\\\server\\share\\skills" }).directory,
    DEFAULT_WORKSPACE_SKILLS_DIRECTORY
  );
  assert.equal(
    normalizeWorkspaceSkillsConfig({ directory: "../shared-skills" }).directory,
    DEFAULT_WORKSPACE_SKILLS_DIRECTORY
  );
});

test("parseSkillsFindResults parses plain and ANSI-styled search output", () => {
  const results = parseSkillsFindResults(`
Install with npx skills add <owner/repo@skill>
\u001b[38;5;145mteachingai/full-stack-skills@appium\u001b[0m 56 installs
\u001b[38;5;145mlambdatest/agent-skills@appium-skill\u001b[0m 12 installs
`);

  assert.deepEqual(results, [
    {
      slug: "appium",
      source: "/teachingai/full-stack-skills",
      name: "Appium",
      query: ""
    },
    {
      slug: "appium-skill",
      source: "/lambdatest/agent-skills",
      name: "Appium Skill",
      query: ""
    }
  ]);
});

test("detectWorkspaceSkillQueries finds repo-specific skill queries from nested project markers", async () => {
  await withTempWorkspace(async (context) => {
    await fs.writeFile(path.join(context.repoRoot, "AGENTS.md"), "Appium and Selenium flows live here.\n");
    await fs.mkdir(path.join(context.repoRoot, "automated-tests"), { recursive: true });
    await fs.mkdir(path.join(context.repoRoot, "automated-tests-pw"), { recursive: true });
    await fs.writeFile(path.join(context.repoRoot, "automated-tests", "pom.xml"), "<project><artifactId>selenide-appium</artifactId></project>\n");
    await fs.writeFile(path.join(context.repoRoot, "automated-tests-pw", "package.json"), JSON.stringify({
      dependencies: {
        "@playwright/test": "^1.52.0"
      }
    }, null, 2));

    const queries = await detectWorkspaceSkillQueries(context);

    assert.ok(queries.includes("appium"));
    assert.ok(queries.includes("selenium"));
    assert.ok(queries.includes("playwright"));
    assert.ok(queries.includes("java"));
  });
});

test("syncWorkspaceSkills installs missing required skills and records readiness", async () => {
  await withTempWorkspace(async (context) => {
    const sync = await syncWorkspaceSkills(context, {
      directory: ".openclaw/skills",
      required: [
        {
          slug: "find-skills",
          source: "/JimLiuxinghai/find-skills",
          name: "Find Skills"
        }
      ]
    }, {
      discoverSkills: async () => [],
      installSkill: async (skill) => {
        await writeInstalledSkill(context, skill);
        await fs.writeFile(path.join(context.paths.openclawDir, ".clawhub", "lock.json"), JSON.stringify({
          version: 1,
          skills: {
            [skill.slug]: {
              version: "0.1.0",
              installedAt: 1
            }
          }
        }, null, 2), { encoding: "utf8", flag: "w" }).catch(async () => {
          await fs.mkdir(path.join(context.paths.openclawDir, ".clawhub"), { recursive: true });
          await fs.writeFile(path.join(context.paths.openclawDir, ".clawhub", "lock.json"), JSON.stringify({
            version: 1,
            skills: {
              [skill.slug]: {
                version: "0.1.0",
                installedAt: 1
              }
            }
          }, null, 2));
        });
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(sync.status.ready, true);
    assert.equal(sync.status.requiredReadyCount, 1);
    assert.equal(sync.status.discoveredCount, 0);

    const status = await readWorkspaceSkillsStatus(context, {
      directory: ".openclaw/skills",
      required: [{ slug: "find-skills", source: "/JimLiuxinghai/find-skills", name: "Find Skills" }]
    });
    assert.equal(status.ready, true);
    assert.equal(status.skills[0].version, "0.1.0");
    assert.equal(status.skills[0].lastError, "");
    assert.equal(status.requiredCount, 1);
    assert.equal(status.discoveredCount, 0);
  });
});

test("syncWorkspaceSkills records discovered repo skills as recommendations without auto-installing them", async () => {
  await withTempWorkspace(async (context) => {
    const installCalls = [];
    const sync = await syncWorkspaceSkills(context, {
      directory: ".openclaw/skills",
      required: [
        {
          slug: "find-skills",
          source: "/JimLiuxinghai/find-skills",
          name: "Find Skills"
        }
      ]
    }, {
      discoverSkills: async () => ([
        {
          slug: "appium",
          source: "/teachingai/full-stack-skills",
          name: "Appium",
          category: "discovered",
          query: "appium"
        }
      ]),
      installSkill: async (skill) => {
        installCalls.push(skill.slug);
        await writeInstalledSkill(context, skill);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(sync.status.ready, true);
    assert.equal(sync.status.requiredReadyCount, 1);
    assert.equal(sync.status.discoveredReadyCount, 0);
    assert.equal(sync.status.configuredCount, 2);
    assert.equal(sync.status.discoveryQueries.length, 0);
    assert.deepEqual(installCalls, ["find-skills"]);

    const status = await readWorkspaceSkillsStatus(context, {
      directory: ".openclaw/skills",
      required: [{ slug: "find-skills", source: "/JimLiuxinghai/find-skills", name: "Find Skills" }]
    });
    assert.equal(status.discoveredCount, 1);
    assert.equal(status.skills.some((entry) => entry.slug === "appium" && entry.category === "discovered" && entry.ready === false), true);
    const summary = summarizeWorkspaceSkillsStatus(status);
    assert.equal(summary.pendingRecommendations.length, 1);
  });
});

test("syncWorkspaceSkills records non-blocking install failures", async () => {
  await withTempWorkspace(async (context) => {
    const sync = await syncWorkspaceSkills(context, {
      directory: ".openclaw/skills",
      required: [
        {
          slug: "self-improving-agent",
          source: "/pskoett/self-improving-agent",
          name: "Self-Improving Agent"
        }
      ]
    }, {
      discoverSkills: async () => [],
      installSkill: async () => ({
        code: 1,
        stdout: "",
        stderr: "Skill not found"
      })
    });

    assert.equal(sync.status.ready, false);
    assert.equal(sync.status.requiredReadyCount, 0);
    assert.equal(sync.status.skills[0].lastError, "Skill not found");

    const status = await readWorkspaceSkillsStatus(context, {
      directory: ".openclaw/skills",
      required: [{ slug: "self-improving-agent", source: "/pskoett/self-improving-agent", name: "Self-Improving Agent" }]
    });
    assert.equal(status.skills[0].lastError, "Skill not found");
  });
});

test("syncWorkspaceSkills persists discovery errors for later status and doctor reporting", async () => {
  await withTempWorkspace(async (context) => {
    const sync = await syncWorkspaceSkills(context, {
      directory: ".openclaw/skills",
      required: [
        {
          slug: "find-skills",
          source: "/JimLiuxinghai/find-skills",
          name: "Find Skills"
        }
      ]
    }, {
      discoverSkills: async () => ({
        discovered: [],
        errors: [
          {
            query: "playwright",
            error: "Registry unavailable"
          }
        ]
      }),
      installSkill: async (skill) => {
        await writeInstalledSkill(context, skill);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(sync.status.discoveryErrors.length, 1);
    assert.equal(sync.status.discoveryErrors[0].query, "playwright");

    const status = await readWorkspaceSkillsStatus(context, {
      directory: ".openclaw/skills",
      required: [{ slug: "find-skills", source: "/JimLiuxinghai/find-skills", name: "Find Skills" }]
    });
    assert.equal(status.discoveryErrors.length, 1);
    assert.equal(status.discoveryErrors[0].error, "Registry unavailable");
  });
});
