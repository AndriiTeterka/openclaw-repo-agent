import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_REQUIRED_WORKSPACE_SKILLS,
  DEFAULT_WORKSPACE_SKILLS_DIRECTORY,
  normalizeWorkspaceSkillsConfig,
  readWorkspaceSkillsStatus,
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
      paths: {
        openclawDir,
        skillsStatusFile: path.join(stateDir, "skills-status.json")
      }
    });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

test("normalizeWorkspaceSkillsConfig provides the mandatory baseline defaults", () => {
  const skills = normalizeWorkspaceSkillsConfig({});

  assert.equal(skills.directory, DEFAULT_WORKSPACE_SKILLS_DIRECTORY);
  assert.deepEqual(skills.required, DEFAULT_REQUIRED_WORKSPACE_SKILLS);
});

test("syncWorkspaceSkills installs missing skills and records readiness", async () => {
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
      installSkill: async (skill) => {
        const skillsRoot = path.join(context.paths.openclawDir, "skills");
        const skillDir = path.join(skillsRoot, skill.slug);
        const lockDir = path.join(context.paths.openclawDir, ".clawhub");
        await fs.mkdir(skillDir, { recursive: true });
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Find Skills\n");
        await fs.writeFile(path.join(skillDir, "_meta.json"), JSON.stringify({
          slug: skill.slug,
          version: "0.1.0"
        }, null, 2));
        await fs.writeFile(path.join(lockDir, "lock.json"), JSON.stringify({
          version: 1,
          skills: {
            [skill.slug]: {
              version: "0.1.0",
              installedAt: 1
            }
          }
        }, null, 2));
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(sync.status.ready, true);
    assert.equal(sync.status.readyCount, 1);

    const status = await readWorkspaceSkillsStatus(context, {
      directory: ".openclaw/skills",
      required: [{ slug: "find-skills", source: "/JimLiuxinghai/find-skills", name: "Find Skills" }]
    });
    assert.equal(status.ready, true);
    assert.equal(status.skills[0].version, "0.1.0");
    assert.equal(status.skills[0].lastError, "");
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
      installSkill: async () => ({
        code: 1,
        stdout: "",
        stderr: "Skill not found"
      })
    });

    assert.equal(sync.status.ready, false);
    assert.equal(sync.status.readyCount, 0);
    assert.equal(sync.status.skills[0].lastError, "Skill not found");
  });
});
