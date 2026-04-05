#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const distRoot = process.argv[2];
const EXTENSION_PATCH_MARKER = "OPENCLAW_COPILOT_SDK_PROVIDER_PATCH_V1";
const AUTH_PROFILES_PATCH_MARKER = "OPENCLAW_COPILOT_SDK_PROVIDER_RUNTIME_PATCH_V1";
const SDK_WRAPPER_IMPORT = 'import { createCopilotSdkProviderStreamWrapper } from "/opt/openclaw/copilot-sdk-provider.mjs";';
const EXTENSION_TARGET_RELATIVE_PATH = path.join("extensions", "github-copilot", "index.js");

if (!distRoot) {
  throw new Error("Missing OpenClaw dist root path.");
}

async function findAuthProfilesTarget(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && /^auth-profiles-.*\.js$/i.test(entry.name));
  return match ? path.join(rootDir, match.name) : "";
}

function injectMarkerAfterImport(source, marker) {
  if (source.includes(marker)) return source;
  return source.replace(
    SDK_WRAPPER_IMPORT,
    `${SDK_WRAPPER_IMPORT}
const ${marker} = true;`,
  );
}

function patchExtensionSource(source) {
  let patched = source;

  const importNeedle = 'import { t as fetchCopilotUsage } from "../../usage-DLRV_xyV.js";';
  if (!patched.includes(importNeedle)) {
    throw new Error("Unable to find the bundled GitHub Copilot provider imports in OpenClaw dist.");
  }
  if (!patched.includes(SDK_WRAPPER_IMPORT)) {
    patched = patched.replace(
      importNeedle,
      `${importNeedle}
${SDK_WRAPPER_IMPORT}
const ${EXTENSION_PATCH_MARKER} = true;`,
    );
  } else {
    patched = injectMarkerAfterImport(patched, EXTENSION_PATCH_MARKER);
  }

  const wrapNeedle = "resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),";
  if (!patched.includes(wrapNeedle)) {
    throw new Error("Unable to find the bundled GitHub Copilot provider runtime-auth block in OpenClaw dist.");
  }
  if (!patched.includes('wrapStreamFn: (ctx) => createCopilotSdkProviderStreamWrapper(ctx),')) {
    patched = patched.replace(
      wrapNeedle,
      `wrapStreamFn: (ctx) => createCopilotSdkProviderStreamWrapper(ctx),${wrapNeedle}`,
    );
  }

  return patched;
}

function patchAuthProfilesSource(source) {
  let patched = source;
  if (!patched.includes(SDK_WRAPPER_IMPORT)) {
    patched = `${SDK_WRAPPER_IMPORT}
const ${AUTH_PROFILES_PATCH_MARKER} = true;
${patched}`;
  } else {
    patched = injectMarkerAfterImport(patched, AUTH_PROFILES_PATCH_MARKER);
  }

  const wrapRegex = /function wrapProviderStreamFn\(params\) \{\s*return resolveProviderRuntimePlugin\(params\)\?\.wrapStreamFn\?\.\(params\.context\) \?\? void 0;\s*\}/;
  if (!wrapRegex.test(patched)) {
    if (!patched.includes('params?.provider === "github-copilot"')) {
      throw new Error("Unable to find wrapProviderStreamFn() in the bundled auth-profiles module.");
    }
    return patched;
  }

  return patched.replace(
    wrapRegex,
    `function wrapProviderStreamFn(params) {
        if (params?.provider === "github-copilot") return createCopilotSdkProviderStreamWrapper({
                ...params.context,
                provider: params.provider
        });
        return resolveProviderRuntimePlugin(params)?.wrapStreamFn?.(params.context) ?? void 0;
}`,
  );
}

const extensionTargetFile = path.join(distRoot, EXTENSION_TARGET_RELATIVE_PATH);
const authProfilesTargetFile = await findAuthProfilesTarget(distRoot);
if (!authProfilesTargetFile) {
  throw new Error("Unable to find the bundled auth-profiles module in OpenClaw dist.");
}

const extensionSource = await fs.readFile(extensionTargetFile, "utf8");
const authProfilesSource = await fs.readFile(authProfilesTargetFile, "utf8");
const patchedExtensionSource = patchExtensionSource(extensionSource);
const patchedAuthProfilesSource = patchAuthProfilesSource(authProfilesSource);

if (patchedExtensionSource !== extensionSource) {
  await fs.writeFile(extensionTargetFile, patchedExtensionSource, "utf8");
}
if (patchedAuthProfilesSource !== authProfilesSource) {
  await fs.writeFile(authProfilesTargetFile, patchedAuthProfilesSource, "utf8");
}
