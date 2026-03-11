#!/bin/sh
set -eu

prepare_runtime_directories() {
  mkdir -p /home/node/.openclaw /home/node/.openclaw/runtime /home/node/.gradle-openclaw
}

export_optional_java_home() {
  if [ -z "${JAVA_HOME:-}" ] && [ -d /usr/lib/jvm/java-17-openjdk-amd64 ]; then
    export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
}

bootstrap_provider_auth() {
  node /opt/openclaw/bootstrap-auth.mjs
}

ensure_acpx_plugin() {
  plugin_manifest="${HOME:-/home/node}/.openclaw/extensions/acpx/openclaw.plugin.json"
  if [ -f "$plugin_manifest" ]; then
    return
  fi

  openclaw plugins install @openclaw/acpx
}

render_openclaw_config() {
  node /opt/openclaw/render-openclaw-config.mjs
}

run_bootstrap() {
  prepare_runtime_directories
  export_optional_java_home
  bootstrap_provider_auth
  render_openclaw_config
  ensure_acpx_plugin
}

run_bootstrap
exec "$@"
