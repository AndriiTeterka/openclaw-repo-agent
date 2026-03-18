# OpenClaw Repo Agent

`openclaw-repo-agent` turns the OpenClaw + Telegram + ACP repo-agent flow into a standalone public product.

It is designed for end users to run from any repository with:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

For Codex/Docker MCP targeting, switch explicitly when needed:

```bash
npx openclaw-repo-agent mcp use
```

## Requirements

- Node.js 20 or newer
- Docker Desktop / Docker Engine with Compose V2 and Docker MCP Toolkit
- Codex installed locally
- A Telegram bot token for pairing flows
- OpenAI or Codex auth inputs only when `authBootstrapMode` is set to `codex`
- Optional: a GitHub personal access token if you want authenticated `github-official` MCP tools

## Package Contents

- An interactive repo bootstrap CLI
- A reusable OpenClaw runtime image source under [`runtime/`](runtime/)
- JSON schemas for repo config and rendered manifests under [`schemas/`](schemas/)

## Repository Extras

These assets are included in the source repository, but they are not part of the published npm tarball:

- A reusable plugin validation action under [`.github/actions/validate-plugin`](.github/actions/validate-plugin)
- A generic example consumer repo under [`test/fixtures/custom`](test/fixtures/custom)
- Release automation for npm under [`.github/workflows`](.github/workflows)

## First-Time User Flow

From a target repo root:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

`init` and `up` now prepare repo-local Docker MCP state and sync configured credentials into Docker MCP secrets, but they no longer repoint Docker MCP/Codex globally. Use `mcp use` explicitly when you want Codex to target the current repo.

`up` now always builds the repo-local runtime image for the current instance and persists that instance-specific tag in the instance registry.

Run `pair` after opening the dashboard or messaging the Telegram bot to approve the latest pending local gateway/device and Telegram pairing requests.

`init` auto-detects repo-derived settings first, including project name, tooling profile, instruction files, knowledge files, and verification commands. The interactive flow mainly asks for user-specific inputs such as:

- ACP default agent
- Codex auth source when the ACP default agent is `codex`
- Telegram bot token when it is not already configured

Telegram defaults remain repo-local and silent during bootstrap:

- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`

You can still override detected repo settings and Telegram policy later in `.openclaw/config.json` or with CLI flags.

The CLI writes everything under `.openclaw/`, and `.openclaw/` is git-ignored by default:

- repo config files: `.openclaw/config.json`, `.openclaw/secrets.env`
- generated runtime files: `.openclaw/state/`

If you want to commit selected `.openclaw` files, remove or narrow the `.openclaw/` entry in your repo’s `.gitignore`.

Each initialized repo also gets a stable isolated runtime identity:

- `OPENCLAW_INSTANCE_ID` is derived from the repo path
- `OPENCLAW_GATEWAY_PORT` is auto-managed from a per-repo range by default
- the runtime uses an instance-specific local image tag
- Docker Compose uses an instance-specific project name

Configuration precedence:

1. CLI flags
2. `.openclaw/config.json`
3. built-in defaults

## Command Reference

- `init`: bootstrap or refresh `.openclaw` files for a repository
- `up`: render runtime state and start the local OpenClaw stack
- `down`: stop the local stack
- `pair`: approve the latest pending local gateway/device and Telegram pairing requests, or switch to external device pairing when `--gateway-url` is supplied
- `status`: show effective runtime settings and optionally check npm for updates
- `doctor`: validate Docker, auth, render status, gateway health, and Telegram readiness
- `verify`: run configured verification commands inside the gateway container
- `update`: rerender state, refresh the runtime image, and rerun doctor checks
- `instances list`: show all registered repo instances on this machine plus live container state when available
- `mcp setup`: prepare or refresh this repo's Docker MCP config and sync Docker MCP secrets
- `mcp use`: activate this repo's Docker MCP config for Codex
- `mcp status`: show whether this repo's Docker MCP config is active and whether Codex is targeting it
- `config validate`: validate `.openclaw/config.json` as rendered into the runtime env
- `config migrate`: rewrite `.openclaw/config.json` using the current CLI defaults

Run `npx openclaw-repo-agent --help` for the current command summary.

## Defaults

- Runtime profile: `stable-chat`
- Queue profile: `stable-chat`
- ACP backend: `acpx`
- ACP default agent: `codex`
- Supported ACP agents: `codex`, `claude`, `gemini`
- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`
- Auth bootstrap mode: `codex`
- Denied tool: `process`

`codex` is the default ACP and bootstrap path now. The CLI prefers an existing Codex login under `CODEX_HOME` or `~/.codex`, and only falls back to prompting for an API key when no local Codex auth path is available.

## Local Configuration Notes

- `.openclaw/` is git-ignored by default; treat it as repo-local OpenClaw state unless you intentionally unignore parts of it.
- `.openclaw/config.json` holds all non-secret configuration (project name, deployment profile, ACP agent, Telegram policy, etc.).
- `.openclaw/secrets.env` holds secrets only: `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `TARGET_AUTH_PATH`. `init`/`up` mirror them into Docker MCP secrets automatically.
- `.openclaw/state/runtime.env` is generated from config + secrets + instance registry and should not be edited directly.
- Instance identity (`OPENCLAW_INSTANCE_ID`, `OPENCLAW_GATEWAY_PORT`) is managed by the instance registry; use `up --reassign-port` or `doctor --fix` to change the gateway port.
- `TARGET_AUTH_PATH` should point at a host path that contains Codex auth when `authBootstrapMode=codex`; it remains in secrets.env because it is a host path, not a keychain secret.
- `OPENCLAW_GATEWAY_BIND=lan` is intentional in the generated Docker setup so bridge traffic can reach the gateway inside the container; the generated Compose file still publishes the host port on `127.0.0.1` only unless you change the port mapping.
- If the ACP default agent is `codex`, the repo agent defaults the workspace model to `openai-codex/gpt-5.4` and automatically reuses `CODEX_HOME` or `~/.codex` when `auth.json` is present there.
- The runtime image installs the official Codex CLI, so container-side auth bootstrap no longer depends on the OpenClaw base image shipping `codex`.
- The runtime image also preinstalls `playwright-cli`, Chromium, and Playwright's Linux browser dependencies, seeds Playwright CLI to use bundled Chromium by default, removes stale `npx playwright` cache state on startup, reroutes both `playwright` and `npx playwright` back to `playwright-cli`, and treats `playwright-cli` as the only supported browser automation entrypoint for this project.
- Playwright CLI workspace config lives under `.openclaw/playwright/`. Normal CLI responses stay on stdout instead of auto-generating page or console files; explicit saved artifacts go under `.openclaw/playwright/artifacts/`.
- Docker container names are Compose-generated from the repo instance project name, for example `openclaw-<instanceId>-openclaw-gateway-1`.
- The generated runtime env lives at `.openclaw/state/runtime.env`; the container receives all config via env vars.
- The generated Docker MCP repo config lives at `.openclaw/state/docker-mcp.config.yaml`.
- Docker MCP secret sync state is tracked in `.openclaw/state/docker-mcp.secrets.json`.
- The runtime relies on the bundled `acpx` plugin shipped in the OpenClaw base image, so normal `up`, `pair`, and health-check flows do not download ACP plugins at container startup.
- Separate Telegram bot tokens are the supported concurrent multi-repo model. `up` now refuses to start two running repo instances with the same bot token.

## Docker MCP

This project now treats Docker MCP as repo-scoped setup plus explicit activation.

Typical setup:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent mcp use
```

What this does:

- enables `docker`, `fetch`, `filesystem`, `github-official`, and `context7`
- prepares `.openclaw/state/docker-mcp.config.yaml` for this repo
- mirrors configured `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, and optional `GITHUB_PERSONAL_ACCESS_TOKEN` into Docker MCP secrets
- activates the repo's Docker MCP config only when you run `mcp use`
- reconnects Codex to `docker mcp gateway run` when you run `mcp use`
- uses `playwright-cli` as the only supported browser automation tool for this project

External pairing:

```bash
npx openclaw-repo-agent pair --gateway-url ws://gateway.example/ws --gateway-token <token>
```

- This path uses the host `openclaw devices ...` commands instead of the repo-local container.
- `--gateway-url` should be the OpenClaw gateway WebSocket URL, not a browser dashboard URL.
- If you omit `--approve`, the CLI approves the latest pending external device request automatically.

Notes:

- `mcp use` changes Docker MCP's active config pointer globally because Codex currently only supports global Docker MCP integration
- `github-official` can be authenticated by setting `GITHUB_PERSONAL_ACCESS_TOKEN` in `.openclaw/secrets.env` and rerunning `init`, `up`, or `mcp setup`
- `context7` is enabled permanently for version-specific documentation lookup
- browser automation in this project should always use `playwright-cli`
- the repo-local Docker MCP config only scopes filesystem access for this repo; the other recommended servers do not need per-repo config
- use `mcp setup` and `mcp use` as repair commands if the repo-local config or Codex connection gets out of sync

## Multi-Repo Runtime

This project now supports running multiple repo-local OpenClaw gateways concurrently on one machine, with these safeguards:

- one Compose project per repo instance
- one managed gateway port per repo instance by default
- one local runtime image tag per repo instance
- one Telegram bot token per running repo instance
- a machine-local instance registry used by `instances list`, `status`, and `doctor`

If you want to switch Codex between repos, do it explicitly:

```bash
npx openclaw-repo-agent mcp use
```

## Development

Run unit tests, validate the example, and inspect the published tarball contents:

```bash
npm test
```

Run the same publish gate explicitly without going through `npm publish`:

```bash
npm run release:check
```

Validate a consumer repo manually:

```bash
node ./cli/bin/openclaw-repo-agent.mjs config validate --repo-root /path/to/repo --product-root .
```

Build and start the local runtime during development:

```bash
node ./cli/bin/openclaw-repo-agent.mjs up --repo-root /path/to/repo --product-root .
```

## Release Model

- npm package: `openclaw-repo-agent`
- release tags: `vX.Y.Z`

npm publishing is configured for GitHub Actions trusted publishing via [`.github/workflows/release.yml`](.github/workflows/release.yml). Before the first release, configure the npm package to trust this repository/workflow on npm. No `NPM_TOKEN` repository secret is needed for package publishing.

Release flow:

1. update `package.json` and `cli/src/builtin-profiles.mjs` to the target version
2. run `npm run release:check`
3. push a matching Git tag such as `v0.4.0`

The release workflow rejects tags that do not match `package.json`, and `npm publish` is guarded by the repo's `prepublishOnly` release checks.

The GitHub Actions workflows in [`.github/workflows`](.github/workflows) are already repo-root ready.

## Optional Consumer Validation

If a consumer repo chooses to commit `.openclaw/config.json`, it can validate that file with the reusable action under [`.github/actions/validate-plugin`](.github/actions/validate-plugin).
