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
- Docker Desktop / Docker Engine with Compose V2
- A Telegram bot token for pairing flows
- OpenAI/Codex auth inputs when `authBootstrapMode=codex`, or Gemini auth inputs when `authBootstrapMode=gemini`, or GitHub CLI auth when `authBootstrapMode=copilot`

## Package Contents

- An interactive repo bootstrap CLI
- A reusable `runtime-core` image definition and local tooling-layer Dockerfiles under [`runtime/`](runtime/)

## Repository Extras

These assets are included in the source repository, but they are not part of the published npm tarball:

- A consumer-repo test fixture under [`test/fixtures/custom`](test/fixtures/custom)
- Release automation for npm and GHCR under [`.github/workflows`](.github/workflows)

## First-Time User Flow

From a target repo root:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

`up` pulls the published `runtime-core:latest` image, records the resolved digest per workspace, derives a deterministic local tooling-layer image from that digest plus the repo tooling spec, and reuses that tooling image whenever the same core digest and tooling inputs are already cached on the machine.

Run `pair` after opening the dashboard or messaging the Telegram bot to approve the latest pending local gateway/device and Telegram pairing requests.

When a workspace has more than one ACP agent enabled, use `/models` in Telegram to pick a provider first and then pick a live model from that provider for the current conversation.

`init` auto-detects repo-derived settings first, including project name, tooling profiles, stack languages, stack tools, instruction files, and knowledge files. The interactive flow mainly asks for user-specific inputs such as:

- ACP default agent
- Codex auth source when the ACP default agent is `codex`
- Gemini auth source when the ACP default agent is `gemini`
- Copilot auth source when the ACP default agent is `copilot`
- Telegram bot token when it is not already configured

Telegram defaults remain repo-local and silent during bootstrap:

- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`

You can still override detected repo settings and Telegram policy later in `.openclaw/config.json` or with CLI flags.

The repo-local surface is intentionally small. In Git repos, `init` adds `.openclaw/` to `.git/info/exclude` by default:

- repo-owned config and guidance: `.openclaw/config.json`, `.openclaw/instructions.md`
- repo-local rendered runtime surface: `.openclaw/runtime/` and `.openclaw/playwright/`
- machine-local runtime-owned state: secrets, tooling build context, provider-home mount metadata, and per-instance state live outside the repo under the agent state home

The repo-local runtime surface now includes a sanitized JSONL event log at `.openclaw/runtime/events.jsonl` for command/runtime lifecycle tracing.

Use `npx openclaw-repo-agent paths --json` to discover the canonical machine-local state paths for the current repo instance.

Each initialized repo also gets a stable isolated runtime identity:

- `OPENCLAW_INSTANCE_ID` is derived from the repo path
- `OPENCLAW_GATEWAY_PORT` is auto-managed from a per-repo range by default
- the runtime uses a shared local tooling image tag derived from the runtime-core digest and tooling spec
- Docker Compose uses an instance-specific project name

Configuration precedence:

1. CLI flags
2. `.openclaw/config.json`
3. built-in defaults

## Command Reference

- `init`: bootstrap or refresh repo config plus machine-local runtime state for a repository
- `up`: pull the latest runtime-core image, record its digest, render runtime files, build the local tooling layer when needed, and start the local OpenClaw stack
- `down`: stop the local stack
- `pair`: approve the latest pending local gateway/device and Telegram pairing requests, or switch to external device pairing when `--gateway-url` is supplied
- `status`: show effective runtime settings without mutating Docker or runtime state by default
- `doctor`: validate Docker, auth, render status, gateway health, and Telegram readiness without mutating runtime state by default
- `update`: repull the latest runtime-core image, rerender runtime files, rebuild the local tooling layer when needed, recreate the stack, and rerun doctor checks
- `paths [--json]`: show repo-local and machine-local paths for the current instance
- `instances list`: show all registered repo instances on this machine plus live container state when available
- `config validate`: validate `.openclaw/config.json` as rendered into the runtime env

Run `npx openclaw-repo-agent --help` for the current command summary.

## Defaults

- Runtime profile: `stable-chat`
- Queue profile: `stable-chat`
- Default queue mode: `steer`
- ACP backend: `acpx`
- ACP default agent: `codex`
- Supported ACP agents: `codex`, `gemini`, `copilot`
- Workspace verbose default: `on`
- Workspace thinking default: `adaptive`
- Workspace typing mode: `message`
- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`
- Telegram reply-to mode: `all`
- Telegram ACP thread bindings: `disabled`
- Auth bootstrap mode: `codex`
- Denied tool: `process`

`codex` is the default ACP and bootstrap path now. `init` is subscription-login-only: it detects existing host logins under `CODEX_HOME`/`~/.codex`, `GEMINI_CLI_HOME`/`~/.gemini`, and `COPILOT_HOME`/`~/.copilot`, then keeps the selected providers mounted into the runtime as read-only home directories. If no provider subscription login is available, `init` fails instead of prompting for API keys or tokens.

## Local Configuration Notes

- In Git repos, `.openclaw/` is added to `.git/info/exclude` during `init`; the supported steady state is `.openclaw/config.json` plus repo guidance only.
- Secrets, tooling build context, provider-home mount metadata, and per-instance `state.json` are stored outside the repo under the agent state home.
- Rendered runtime files live under `.openclaw/runtime/` and Playwright config/artifacts live under `.openclaw/playwright/`.
- `.openclaw/runtime/events.jsonl` is a repo-local structured event log for command and runtime lifecycle stages; it is sanitized before write.
- Use `paths --json` instead of hard-coding file discovery in scripts.
- Instance identity (`OPENCLAW_INSTANCE_ID`, `OPENCLAW_GATEWAY_PORT`) is managed by the instance registry; use `up --reassign-port` or `doctor --fix` to change the gateway port.
- Provider subscription auth is detected on the host and mounted into the runtime directly as read-only provider homes (`.codex`, `.gemini`, `.copilot`), so host settings and MCP configuration stay available inside the container.
- `OPENCLAW_GATEWAY_BIND=lan` is intentional in the generated Docker setup so bridge traffic can reach the gateway inside the container; the generated Compose file still publishes the host port on `127.0.0.1` only unless you change the port mapping.
- If the ACP default agent is `codex`, the repo agent discovers the available `openai-codex` models from the installed Codex CLI at runtime and uses the newest discovered model when `agent.defaultModel` is not explicitly set.
- If the ACP default agent is `gemini`, the repo agent discovers available Gemini models from the installed Gemini CLI at runtime and uses the newest discovered `google-gemini-cli` model when `agent.defaultModel` is not explicitly set. Set `.openclaw/config.json` `agent.defaultModel` if you want to pin a different model.
- The runtime-core image is pulled from GHCR as `:latest`, and the pulled digest is recorded per workspace for traceability and support.
- The local tooling layer installs repo-specific tooling profiles plus repo-owned install scripts rendered into `tooling.manifest.json`. Inline shell commands remain opt-in through `tooling.allowUnsafeCommands`.
- `playwright-cli` is the only supported browser automation entrypoint for this project. Workspace config and artifacts are rendered under `.openclaw/playwright/`.
- Docker container names are Compose-generated from the repo instance project name, for example `openclaw-<instanceId>-openclaw-gateway-1`.
- The generated runtime env and Compose file live under `.openclaw/runtime/`; the container receives config via env vars, the repo workspace bind, and runtime-owned volumes only.
- `doctor --json` includes an `observability` block with the event-log path plus run/correlation ids for the current check.
- The runtime relies on the bundled `acpx` plugin shipped in the OpenClaw base image, so normal `up`, `pair`, and health-check flows do not download ACP plugins at container startup.
- If the ACP default agent is `copilot`, the repo agent uses GitHub Copilot for ACP operations. The CLI discovers existing Copilot auth under `COPILOT_HOME` or `~/.copilot`, mounts that home read-only into the runtime, and derives the internal runtime token bridge from the host login.
- Separate Telegram bot tokens are the supported concurrent multi-repo model. `up` now refuses to start two running repo instances with the same bot token.
- `OPENCLAW_RUNTIME_CORE_IMAGE` remains a hidden maintainer override, and `OPENCLAW_ALLOW_LOCAL_RUNTIME_CORE_BUILD=true` enables a local fallback build for maintainers only.

## Multi-Agent Runtime

When multiple ACP agents are configured in `acp.allowedAgents`, the runtime bootstraps each supported provider and builds a combined model catalog for the configured set.

You can pin the provider list explicitly in `.openclaw/config.json`:

```json
{
  "acp": {
    "defaultAgent": "codex",
    "allowedAgents": ["codex", "copilot", "gemini"]
  }
}
```

If `acp.allowedAgents` is omitted or left empty, the CLI auto-detects Codex, Gemini, and Copilot from available tokens and auth homes.

Each allowed provider's auth credentials must be configured in the machine-local secrets file for the repo instance. The runtime preserves non-default provider creds during `init`, bootstraps every allowed provider on startup, and builds the model catalog for all available providers.

In Telegram, `/models` is the provider-and-model selection surface for the current conversation. The selection is session-local; changing the workspace default still requires updating `.openclaw/config.json`.

## Multi-Repo Runtime

This project now supports running multiple repo-local OpenClaw gateways concurrently on one machine, with these safeguards:

- one Compose project per repo instance
- one managed gateway port per repo instance by default
- one shared local tooling image tag per unique runtime-core digest plus tooling spec
- one Telegram bot token per running repo instance
- a machine-local instance registry used by `instances list`, `status`, and `doctor`

## Development

Run unit tests, validate the example, and inspect the published tarball contents:

```bash
npm test
```

Run the same publish gate explicitly without going through `npm publish`:

```bash
npm run release:check
```

Run the structural cleanup checks directly:

```bash
npm run check:unused
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
- runtime-core image: `ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core`
- release tags: `vX.Y.Z`

npm publishing is configured for GitHub Actions trusted publishing via [`.github/workflows/release.yml`](.github/workflows/release.yml). The same workflow publishes the multi-arch `runtime-core` image to GHCR as `:latest`. Before the first release, configure the npm package to trust this repository/workflow on npm. No `NPM_TOKEN` repository secret is needed for package publishing.

Release flow:

1. update `package.json` to the target version
2. run `npm run release:check`
3. push a matching Git tag such as `vX.Y.Z`

The release workflow rejects tags that do not match `package.json`, and `npm publish` is guarded by the repo's `prepublishOnly` release checks.

The GitHub Actions workflows in [`.github/workflows`](.github/workflows) are already repo-root ready.
