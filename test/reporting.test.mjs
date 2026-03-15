import assert from "node:assert/strict";
import test from "node:test";

import { renderReport } from "../cli/src/reporting.mjs";

test("renderReport formats section-based output without ANSI when color is disabled", () => {
  const output = renderReport({
    status: "success",
    title: "Init complete",
    summary: [
      { label: "Repo", value: "C:/demo/repo" },
      { label: "Skills", value: "0/3 mandatory ready, 3 recommendations" }
    ],
    sections: [
      {
        title: "Warnings",
        status: "warning",
        items: ["Workspace skill not ready: Skill Vetter: repository authentication/access failed"]
      },
      {
        title: "Prepared",
        status: "info",
        items: [".openclaw/plugin.json", ".openclaw/local.env"]
      }
    ]
  }, { color: false });

  assert.match(output, /^\[OK\] Init complete/m);
  assert.match(output, /Summary/);
  assert.match(output, /  Repo: C:\/demo\/repo/);
  assert.match(output, /\[WARN\] Warnings/);
  assert.match(output, /repository authentication\/access failed/);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("renderReport emits ANSI colors when enabled", () => {
  const output = renderReport({
    status: "error",
    title: "Command failed",
    sections: [
      {
        title: "Details",
        status: "error",
        items: ["Unsupported acp.defaultAgent: opencode."]
      }
    ]
  }, { color: true });

  assert.match(output, /\u001b\[/);
  assert.match(output, /Command failed/);
  assert.match(output, /\[FAIL\]/);
});
