import assert from "node:assert/strict";
import test from "node:test";

import { safeRunCommand } from "../runtime/shared.mjs";

test("safeRunCommand returns a timeout error for hung commands", async () => {
  const result = await safeRunCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 50
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out/i);
});
