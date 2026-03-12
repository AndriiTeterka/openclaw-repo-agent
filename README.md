# OpenClaw Repo Agent

`openclaw-repo-agent` turns the OpenClaw + Telegram + ACP repo-agent flow into a standalone public product.

It is designed for end users to run from any repository with:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

## Requirements

- Node.js 20 or newer
- Docker Desktop / Docker Engine with Compose V2 and Docker MCP Toolkit
- Codex installed locally
- A Telegram bot token for pairing flows
- OpenAI or Codex auth inputs only when `authBootstrapMode` is set to `codex`
- Optional: a GitHub personal access token if you want authenticated `github-official` MCP tools

## What It Ships

- An interactive repo bootstrap CLI
- A reusable OpenClaw runtime image source under [`runtime/`](runtime/)
- JSON schemas for repo config and rendered manifests under [`schemas/`](schemas/)
- A reusable plugin validation action under [`.github/actions/validate-plugin`](.github/actions/validate-plugin)
- A generic example consumer repo under [`examples/custom`](examples/custom)
- Release automation for npm and GHCR

## First-Time User Flow

From a target repo root:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

`init` and `up` now automatically enforce the required Docker MCP setup for the current repo, reconnect Codex if needed, and sync configured credentials into Docker MCP secrets.

`init` auto-detects repo-derived settings first, including project name, tooling profile, instruction files, knowledge files, and verification commands. The interactive flow mainly asks for user-specific inputs such as:

- ACP default agent
- auth mode
- Telegram bot token when it is not already configured
- Telegram DM and group policy
- Telegram allowlists only when the chosen policy needs them

You can still override the detected repo settings interactively or later in `.openclaw/plugin.json`.

The CLI writes:

- committed files: `.openclaw/plugin.json`, `.openclaw/instructions.md`, `.openclaw/knowledge.md`, `.openclaw/local.env.example`
- local-only files: `.openclaw/local.env`, `.openclaw/state/`

Configuration precedence:

1. CLI flags
2. `.openclaw/local.env`
3. `.openclaw/plugin.json`
4. built-in defaults

## Command Reference

- `init`: bootstrap or refresh `.openclaw` files for a repository
- `up`: render runtime state and start the local OpenClaw stack
- `down`: stop the local stack
- `pair`: list or approve Telegram pairing requests and update local allowlists
- `status`: show effective runtime settings and optionally check npm for updates
- `doctor`: validate Docker, auth, render status, gateway health, and Telegram readiness
- `verify`: run configured verification commands inside the gateway container
- `update`: rerender state, refresh the runtime image, and rerun doctor checks
- `mcp setup`: repair or reapply the required Docker MCP setup for the current repo
- `mcp status`: show whether Docker MCP is pointed at this repo's generated config and whether Codex is connected
- `mcp connect`: reconnect Codex globally to Docker MCP's gateway (`~/.codex/config.toml`)
- `config validate`: validate `.openclaw/plugin.json` as rendered into the project manifest
- `config migrate`: rewrite `.openclaw/plugin.json` using the current CLI defaults

Run `npx openclaw-repo-agent --help` for the current command summary.

## Defaults

- Runtime profile: `stable-chat`
- Queue profile: `stable-chat`
- ACP backend: `acpx`
- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`
- Auth bootstrap mode: `external`
- Denied tool: `process`

`codex` auth bootstrap remains available as an explicit opt-in mode. When enabled, users must provide their own Codex-compatible runtime install and auth inputs.

## Local Configuration Notes

- `.openclaw/local.env` is the user-editable local override file; `.openclaw/state/runtime.env` is generated and should not be edited directly.
- `TELEGRAM_BOT_TOKEN` and `OPENAI_API_KEY` still live in `.openclaw/local.env` for the OpenClaw runtime, but `init`/`up` mirror them into Docker MCP secrets automatically.
- `GITHUB_PERSONAL_ACCESS_TOKEN` is optional in `.openclaw/local.env`; when present it is synced to Docker MCP as `github.personal_access_token` for `github-official`.
- Telegram stream mode is configured with `OPENCLAW_TELEGRAM_STREAM_MODE` in `.openclaw/local.env`.
- `TARGET_AUTH_PATH` should point at a host path that contains Codex auth when `authBootstrapMode=codex`; it remains local because it is a host path, not a keychain secret.
- The generated runtime manifest lives at `.openclaw/state/project-manifest.json`.
- The generated Docker MCP repo config lives at `.openclaw/state/docker-mcp.config.yaml`.
- Docker MCP secret sync state is tracked in `.openclaw/state/docker-mcp.secrets.json`.

## Docker MCP

This project now treats Docker MCP as part of the default runtime workflow. `init` and `up` automatically keep Docker MCP pointed at the current repo and make sure Codex is connected to the Docker MCP gateway.

Typical setup:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
```

What this does:

- enables `docker`, `fetch`, `filesystem`, `github-official`, `playwright`, and `context7`
- points Docker MCP at `.openclaw/state/docker-mcp.config.yaml`
- connects Codex to `docker mcp gateway run`
- mirrors configured `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, and optional `GITHUB_PERSONAL_ACCESS_TOKEN` into Docker MCP secrets

Notes:

- `mcp setup` updates Docker MCP's active config pointer globally; rerun it in the repo you want Docker MCP to target
- `mcp connect` changes Codex's global config, not just the current repo
- `github-official` can be authenticated by setting `GITHUB_PERSONAL_ACCESS_TOKEN` in `.openclaw/local.env` and rerunning `init`, `up`, or `mcp setup`
- `context7` is enabled permanently for version-specific documentation lookup
- the repo-local Docker MCP config only scopes filesystem access for this repo; the other recommended servers do not need per-repo config
- use `mcp setup` and `mcp connect` as repair commands if the automatic enforcement ever gets out of sync

## Development

Run unit tests, validate the example, and inspect the published tarball contents:

```bash
npm test
```

Validate a consumer repo manually:

```bash
node ./cli/bin/openclaw-repo-agent.mjs config validate --repo-root /path/to/repo --product-root .
```

Build the runtime locally during development:

```bash
node ./cli/bin/openclaw-repo-agent.mjs init --repo-root /path/to/repo --product-root . --use-local-build
```

## Release Model

- npm package: `openclaw-repo-agent`
- runtime images: `ghcr.io/<owner>/openclaw-repo-agent-runtime`
- release tags: `vX.Y.Z`

The GitHub Actions workflows in [`.github/workflows`](.github/workflows) are already repo-root ready.

## Optional Consumer Validation

Consumer repos can validate `.openclaw/plugin.json` with the reusable action under [`.github/actions/validate-plugin`](.github/actions/validate-plugin).
