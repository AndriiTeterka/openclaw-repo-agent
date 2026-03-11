# OpenClaw Repo Agent

`openclaw-repo-agent` turns the OpenClaw + Telegram + ACP repo-agent flow into a standalone public product.

It is designed for end users to run from any repository with:

```bash
npx openclaw-repo-agent init
npx openclaw-repo-agent up
npx openclaw-repo-agent pair
```

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

`init` prompts for:

- project name
- tooling, deployment, runtime, and queue profiles
- ACP default agent and optional allowed agents
- auth mode
- Telegram bot token
- Telegram DM and group policy
- optional Telegram allowlists
- optional verification commands

The CLI writes:

- committed files: `.openclaw/plugin.json`, `.openclaw/instructions.md`, `.openclaw/knowledge.md`, `.openclaw/local.env.example`
- local-only files: `.openclaw/local.env`, `.openclaw/state/`

Configuration precedence:

1. CLI flags
2. `.openclaw/local.env`
3. `.openclaw/plugin.json`
4. built-in defaults

## Defaults

- Runtime profile: `stable-chat`
- Queue profile: `stable-chat`
- ACP backend: `acpx`
- Telegram DM policy: `pairing`
- Telegram group policy: `disabled`
- Auth bootstrap mode: `external`
- Denied tool: `process`

`codex` auth bootstrap remains available as an explicit opt-in mode. When enabled, users must provide their own Codex-compatible runtime install and auth inputs.

## Development

Validate the example and npm package contents:

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
