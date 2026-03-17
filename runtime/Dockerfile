ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

ARG OPENCLAW_AGENT_NPM_PACKAGES=
ARG OPENCLAW_AGENT_INSTALL_COMMAND=
ARG OPENCLAW_TOOLING_PROFILE=java17
ARG OPENCLAW_TOOLING_INSTALL_COMMAND=

USER root

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
    fd-find \
    jq \
    python3 \
    ripgrep \
    tree \
    zip \
 && case "$OPENCLAW_TOOLING_PROFILE" in \
      ""|none) ;; \
      java17) apt-get install --yes --no-install-recommends openjdk-17-jdk-headless ;; \
      node20) ;; \
      python311) apt-get install --yes --no-install-recommends python3-pip python3-venv ;; \
      go122) apt-get install --yes --no-install-recommends golang-go ;; \
      polyglot) apt-get install --yes --no-install-recommends golang-go openjdk-17-jdk-headless python3-pip python3-venv ;; \
      *) echo "Unsupported OPENCLAW_TOOLING_PROFILE=$OPENCLAW_TOOLING_PROFILE" >&2; exit 1 ;; \
    esac \
 && if [ -n "${OPENCLAW_TOOLING_INSTALL_COMMAND}" ]; then sh -lc "${OPENCLAW_TOOLING_INSTALL_COMMAND}"; fi \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

COPY runtime/playwright-cli-daemon-patch.mjs /opt/openclaw/playwright-cli-daemon-patch.mjs
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global @openai/codex @playwright/cli \
 && node /opt/openclaw/playwright-cli-daemon-patch.mjs "$(npm root -g)" \
 && "$(npm root -g)/@playwright/cli/node_modules/.bin/playwright" install --with-deps chromium \
 && if [ -n "${OPENCLAW_AGENT_NPM_PACKAGES}" ]; then npm install --global ${OPENCLAW_AGENT_NPM_PACKAGES}; fi \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* \
 && if [ -n "${OPENCLAW_AGENT_INSTALL_COMMAND}" ]; then sh -lc "${OPENCLAW_AGENT_INSTALL_COMMAND}"; fi

ENV OPENCLAW_TOOLING_PROFILE=${OPENCLAW_TOOLING_PROFILE}

RUN mkdir -p /home/node/.openclaw /ms-playwright \
 && chown -R node:node /home/node /ms-playwright

COPY runtime/playwright-cli.config.json /app/.playwright/cli.config.json
# Preserve npm's real Playwright CLI symlink before installing the repo wrapper at the public path.
RUN mv /usr/local/bin/playwright-cli /usr/local/bin/playwright-cli-real
COPY runtime/playwright-cli-wrapper.mjs /usr/local/bin/playwright-cli
COPY runtime/playwright-shim.sh /usr/local/bin/playwright
COPY runtime/shared.mjs /opt/openclaw/shared.mjs
COPY runtime/supported-acp-agents.mjs /opt/openclaw/supported-acp-agents.mjs
COPY runtime/manifest-contract.mjs /opt/openclaw/manifest-contract.mjs
COPY runtime/bootstrap-auth.mjs /opt/openclaw/bootstrap-auth.mjs
COPY runtime/doctor.mjs /opt/openclaw/doctor.mjs
COPY runtime/render-openclaw-config.mjs /opt/openclaw/render-openclaw-config.mjs
COPY runtime/extensions/workspace-openclaw /opt/openclaw/plugins/workspace-openclaw
COPY runtime/entrypoint.sh /usr/local/bin/openclaw-entrypoint
RUN mv /usr/local/bin/npx /usr/local/bin/npx-real
COPY runtime/npx-wrapper.mjs /usr/local/bin/npx
RUN sed -i 's/\r$//' /usr/local/bin/openclaw-entrypoint /usr/local/bin/playwright /usr/local/bin/playwright-cli /usr/local/bin/npx \
 && chmod 755 /usr/local/bin/openclaw-entrypoint /usr/local/bin/playwright /usr/local/bin/playwright-cli /usr/local/bin/npx /usr/local/bin/npx-real \
 && chown -R node:node /home/node /opt/openclaw /usr/local/bin/openclaw-entrypoint /usr/local/bin/playwright /usr/local/bin/playwright-cli /usr/local/bin/npx /usr/local/bin/npx-real /app/.playwright

USER node

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint"]
CMD ["node", "dist/index.js", "gateway"]
