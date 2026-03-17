#!/bin/sh
set -eu

prepare_runtime_directories() {
  mkdir -p /home/node/.openclaw /home/node/.openclaw/runtime /home/node/.gradle-openclaw
  chmod 700 /home/node/.openclaw /home/node/.openclaw/runtime 2>/dev/null || true
}

cleanup_stale_playwright_installs() {
  home_dir="${HOME:-/home/node}"
  npx_root="$home_dir/.npm/_npx"

  if [ -d "$npx_root" ]; then
    find "$npx_root" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r dir; do
      package_json="$dir/package.json"
      if [ -f "$package_json" ] && grep -q '"playwright"' "$package_json"; then
        rm -rf "$dir"
      fi
    done
  fi

  rm -rf "$home_dir/.cache/ms-playwright"
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
  bundled_manifest="/app/extensions/acpx/openclaw.plugin.json"
  if [ -f "$plugin_manifest" ] || [ -f "$bundled_manifest" ]; then
    return
  fi

  echo "Missing ACPX plugin. Checked $plugin_manifest and $bundled_manifest." >&2
  echo "Update the OpenClaw base image or rebuild the runtime image before starting OpenClaw." >&2
  exit 1
}

render_openclaw_config() {
  node /opt/openclaw/render-openclaw-config.mjs
}

run_bootstrap() {
  prepare_runtime_directories
  cleanup_stale_playwright_installs
  export_optional_java_home
  bootstrap_provider_auth
  render_openclaw_config
  ensure_acpx_plugin
}

run_bootstrap
exec "$@"
