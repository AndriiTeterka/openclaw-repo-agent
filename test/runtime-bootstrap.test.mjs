import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readTextFile } from "../runtime/shared.mjs";

const repoRoot = path.resolve(".");

test("openclaw base image ships the bundled acpx plugin", async () => {
  const dockerfile = await readTextFile(path.join(repoRoot, "runtime", "Dockerfile"));

  assert.doesNotMatch(dockerfile, /openclaw plugins install @openclaw\/acpx/);
});

test("runtime entrypoint accepts either a local or bundled acpx plugin", async () => {
  const entrypoint = await readTextFile(path.join(repoRoot, "runtime", "entrypoint.sh"));

  assert.doesNotMatch(entrypoint, /openclaw plugins install @openclaw\/acpx/);
  assert.match(entrypoint, /bundled_manifest="\/app\/extensions\/acpx\/openclaw.plugin.json"/);
  assert.match(entrypoint, /chmod 700 \/home\/node\/\.openclaw \/home\/node\/\.openclaw\/runtime/);
});
