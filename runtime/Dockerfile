ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

ARG OPENCLAW_AGENT_NPM_PACKAGES=
ARG OPENCLAW_AGENT_INSTALL_COMMAND=
ARG OPENCLAW_TOOLING_PROFILE=java17
ARG OPENCLAW_TOOLING_INSTALL_COMMAND=

USER root

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

RUN npm install --global @openai/codex \
 && if [ -n "${OPENCLAW_AGENT_NPM_PACKAGES}" ]; then npm install --global ${OPENCLAW_AGENT_NPM_PACKAGES}; fi \
 && npm cache clean --force \
 && if [ -n "${OPENCLAW_AGENT_INSTALL_COMMAND}" ]; then sh -lc "${OPENCLAW_AGENT_INSTALL_COMMAND}"; fi

ENV OPENCLAW_TOOLING_PROFILE=${OPENCLAW_TOOLING_PROFILE}

RUN mkdir -p /home/node/.openclaw \
 && chown -R node:node /home/node

COPY runtime/shared.mjs /opt/openclaw/shared.mjs
COPY runtime/supported-acp-agents.mjs /opt/openclaw/supported-acp-agents.mjs
COPY runtime/manifest-contract.mjs /opt/openclaw/manifest-contract.mjs
COPY runtime/bootstrap-auth.mjs /opt/openclaw/bootstrap-auth.mjs
COPY runtime/doctor.mjs /opt/openclaw/doctor.mjs
COPY runtime/render-openclaw-config.mjs /opt/openclaw/render-openclaw-config.mjs
COPY runtime/extensions/workspace-openclaw /opt/openclaw/plugins/workspace-openclaw
COPY runtime/entrypoint.sh /usr/local/bin/openclaw-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/openclaw-entrypoint \
 && chmod 755 /usr/local/bin/openclaw-entrypoint \
 && chown -R node:node /home/node /opt/openclaw /usr/local/bin/openclaw-entrypoint

USER node

ENTRYPOINT ["/usr/local/bin/openclaw-entrypoint"]
CMD ["node", "dist/index.js", "gateway"]
