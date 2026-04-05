export const WORKSPACE_AUTOMATION_GUIDANCE_LINES = Object.freeze([
  "For browser automation in this workspace, use `playwright-cli` only. Do not use `npx playwright`.",
  "Save screenshots and other Playwright artifacts under `.openclaw/playwright/artifacts/`. Do not create root-level folders such as `tmp-playwright/`.",
  "In Telegram or ACP runs, avoid parallel tool calls unless they are clearly necessary; prefer one short command at a time so tool output does not stall."
]);

export const TEMPLATE_WORKSPACE_GUIDANCE_LINES = Object.freeze([
  ...WORKSPACE_AUTOMATION_GUIDANCE_LINES,
  "Keep replies concise in Telegram-style channels and use the detected stack and tooling profiles as the source of truth for repo setup.",
  "Treat standalone cancellation messages such as `stop`, `cancel`, or `dont fix` as cancellation at the next tool boundary."
]);
