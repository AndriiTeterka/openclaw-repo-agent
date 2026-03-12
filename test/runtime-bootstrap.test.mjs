import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { readTextFile } from "../runtime/shared.mjs";

const repoRoot = path.resolve(".");

test("runtime image preinstalls the acpx plugin", async () => {
  const dockerfile = await readTextFile(path.join(repoRoot, "runtime", "Dockerfile"));

  assert.match(dockerfile, /openclaw plugins install @openclaw\/acpx/);
});

test("runtime entrypoint no longer downloads the acpx plugin at startup", async () => {
  const entrypoint = await readTextFile(path.join(repoRoot, "runtime", "entrypoint.sh"));

  assert.doesNotMatch(entrypoint, /openclaw plugins install @openclaw\/acpx/);
  assert.match(entrypoint, /Missing preinstalled @openclaw\/acpx plugin/);
});
