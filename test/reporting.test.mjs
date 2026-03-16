import assert from "node:assert/strict";
import test from "node:test";

import { renderReport } from "../cli/src/reporting.mjs";

test("renderReport formats section-based output without ANSI when color is disabled", () => {
  const output = renderReport({
    status: "success",
    title: "Init complete",
    summaryTitle: "Configuration",
    summary: [
      { label: "Repo", value: "C:/demo/repo" },
      { label: "Gateway", value: "http://127.0.0.1:21230/" },
      { label: "Agent", value: "Codex (OpenAI subscription login)" }
    ],
    sections: [
      {
        title: "Files",
        status: "success",
        items: [
          { status: "success", text: ".openclaw/plugin.json" },
          { status: "success", text: ".openclaw/local.env" }
        ]
      },
      {
        title: "Checks",
        items: [
          { status: "success", text: "Docker CLI is available." },
          { status: "success", text: "Manifest rendered successfully." }
        ]
      },
      {
        title: "Integrations",
        items: [
          { status: "success", text: "Docker MCP: Synced Telegram bot token" }
        ]
      },
      {
        title: "Warnings",
        items: [
          { status: "warning", icon: "▲", text: "Telegram bot token is configured elsewhere." }
        ]
      },
      {
        title: "Next steps",
        items: [
          { status: "info", icon: "»", text: "Run `openclaw-repo-agent up` next." }
        ]
      }
    ]
  }, { color: false });

  assert.match(output, /SUCCESS  Initialization completed/);
  assert.match(output, /⚙️\s+CONFIGURATION/);
  assert.match(output, /Repo:\s+C:\/demo\/repo/);
  assert.match(output, /📁\s+FILES CREATED/);
  assert.match(output, /✔ \.openclaw\/plugin\.json/);
  assert.doesNotMatch(output, /\bWrote \.openclaw\/plugin\.json\b/);
  assert.match(output, /🩺\s+CHECKS/);
  assert.match(output, /✔ Docker CLI is available\./);
  assert.match(output, /✔ Manifest rendered successfully\./);
  assert.match(output, /🔗\s+INTEGRATIONS/);
  assert.match(output, /✔ Docker MCP: Synced Telegram bot token/);
  assert.match(output, /⚠️\s+WARNINGS/);
  assert.match(output, /➡️\s+TO DO NEXT/);
  assert.match(output, /» Run `openclaw-repo-agent up` next\./);
  assert.match(output, /Run `openclaw-repo-agent up` next\./);
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
        items: ["Run `openclaw-repo-agent up` after fixing Unsupported acp.defaultAgent: opencode."]
      }
    ]
  }, { color: true });

  assert.match(output, /\u001b\[/);
  assert.match(output, /COMMAND FAILED/);
  assert.match(output, /[✖×]/);
  assert.match(output, /openclaw-repo-agent up/);
});
