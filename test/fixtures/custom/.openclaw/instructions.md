# Repo Agent Instructions

- This workspace is managed by `openclaw-repo-agent`.
- Use the repo's configured ACP default agent when ACP-backed inspection, edits, or verification are needed.
- Use `playwright-cli` as the only browser automation tool in this workspace.
- Never use `npx playwright`; route browser automation through `playwright-cli` only.
- Save screenshots and other Playwright artifacts under `.openclaw/playwright/artifacts/`; do not create root-level folders such as `tmp-playwright/`.
- In Telegram or ACP runs, avoid parallel tool calls unless there is a clear need; prefer one short command at a time so command output does not stall.
- Keep replies concise in Telegram-style channels and use the detected stack and tooling profiles as the source of truth for repo setup.
- Treat standalone cancellation messages such as `stop`, `cancel`, or `dont fix` as cancellation at the next tool boundary.
- `.openclaw/` is git-ignored by default; do not commit local-only OpenClaw state or secrets unless you intentionally unignore selected files.
- Project name: custom-example
