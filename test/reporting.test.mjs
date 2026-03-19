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
          { status: "success", text: ".openclaw/config.json" },
          { status: "success", text: ".openclaw/secrets.env" }
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
          { status: "success", text: "Telegram pairing is ready" }
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
          { status: "info", icon: "›", text: "Run 'openclaw-repo-agent up' next." }
        ]
      }
    ]
  }, { color: false });

  assert.match(output, /SUCCESS  'init' completed/);
  assert.match(output, /⚙️\s+CONFIGURATION/);
  assert.match(output, /Repo:\s+C:\/demo\/repo/);
  assert.match(output, /📁\s+FILES CREATED/);
  assert.match(output, /✔ \.openclaw\/config\.json/);
  assert.doesNotMatch(output, /\bWrote \.openclaw\/plugin\.json\b/);
  assert.match(output, /🩺\s+CHECKS/);
  assert.match(output, /✔ Docker CLI is available\./);
  assert.match(output, /✔ Manifest rendered successfully\./);
  assert.match(output, /🔗\s+INTEGRATIONS/);
  assert.match(output, /✔ Telegram pairing is ready/);
  assert.match(output, /⚠️\s+WARNINGS/);
  assert.match(output, /➡️\s+TO DO NEXT/);
  assert.match(output, /› Run 'openclaw-repo-agent up' next\./);
  assert.match(output, /Run 'openclaw-repo-agent up' next\./);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("renderReport formats fatal-style error headings with the same badge layout as success", () => {
  const output = renderReport({
    status: "error",
    title: "'up' could not be completed",
    body: [
      { status: "error", text: "Run `openclaw-repo-agent up` after fixing Unsupported acp.defaultAgent: opencode.", icon: "✖" }
    ]
  }, { color: false });

  assert.match(output, /FAIL  'up' could not be completed/);
  assert.doesNotMatch(output, /COMMAND FAILED/);
  assert.doesNotMatch(output, /📄\s+DETAILS/);
  assert.match(output, /[✖×] Run `openclaw-repo-agent up` after fixing Unsupported acp\.defaultAgent: opencode\./);
  assert.match(output, /openclaw-repo-agent up/);
});

test("renderReport aliases pair settings updates to the command-style success heading", () => {
  const output = renderReport({
    status: "success",
    title: "Pairing settings updated",
    summary: [
      { label: "Action", value: "approved" }
    ]
  }, { color: false });

  assert.match(output, /SUCCESS  'pair' updated/);
});

test("renderReport uses the info badge and no-action suffix for aliased command titles", () => {
  const output = renderReport({
    status: "info",
    title: "Pairing complete",
    summary: [
      { label: "Action", value: "listed" }
    ]
  }, { color: false });

  assert.match(output, /INFO  'pair' completed \(no action required\)/);
});

test("renderReport emits ANSI colors when enabled", () => {
  const output = renderReport({
    status: "error",
    title: "'up' could not be completed",
    body: [
      { status: "error", text: "Run `openclaw-repo-agent up` after fixing Unsupported acp.defaultAgent: opencode.", icon: "✖" }
    ]
  }, { color: true });

  assert.match(output, /\u001b\[/);
  assert.match(output, /FAIL/);
  assert.match(output, /'up' could not be completed/);
  assert.match(output, /openclaw-repo-agent up/);
});
