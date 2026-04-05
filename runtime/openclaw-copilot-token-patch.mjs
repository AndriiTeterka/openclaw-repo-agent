#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const distRoot = process.argv[2];
const PATCH_MARKER = "OPENCLAW_COPILOT_TOKEN_PATCH_V1";

if (!distRoot) {
  throw new Error("Missing OpenClaw dist root path.");
}

async function listJavaScriptFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
    }
  }

  return files;
}

const files = await listJavaScriptFiles(distRoot);
const sources = await Promise.all(files.map((filePath) => fs.readFile(filePath, "utf8")));
if (sources.some((source) => source.includes(PATCH_MARKER))) {
  process.exit(0);
}

const targetIndex = files.findIndex((filePath, index) => (
  /github-copilot-token-.*\.js$/i.test(path.basename(filePath))
  && sources[index].includes('const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";')
));

if (targetIndex === -1) {
  throw new Error("Unable to find the bundled GitHub Copilot token module in OpenClaw dist.");
}

const targetFile = files[targetIndex];
const replacement = `import { _ as resolveStateDir } from "./paths-Y4UT24Of.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-BsUnrt8L.js";
import path from "node:path";
import {
\tDEFAULT_COPILOT_API_BASE_URL,
\tderiveCopilotApiBaseUrlFromToken,
\tisCopilotRuntimeTokenCacheUsable,
\tresolveCopilotRuntimeAuth
} from "/opt/openclaw/copilot-runtime-auth.mjs";
//#region src/agents/github-copilot-token.ts
const ${PATCH_MARKER} = true;
function resolveCopilotTokenCachePath(env = process.env) {
\treturn path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}
async function resolveCopilotApiToken(params) {
\tconst env = params.env ?? process.env;
\tconst cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
\tconst loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
\tconst saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
\tconst cached = loadJsonFileFn(cachePath);
\tif (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
\t\tif (isCopilotRuntimeTokenCacheUsable(cached)) return {
\t\t\ttoken: cached.token,
\t\t\texpiresAt: cached.expiresAt,
\t\t\tsource: \`cache:\${cachePath}\`,
\t\t\tbaseUrl: typeof cached.baseUrl === "string" && cached.baseUrl.trim().length > 0
\t\t\t\t? cached.baseUrl.trim()
\t\t\t\t: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL
\t\t};
\t}
\tconst resolved = await resolveCopilotRuntimeAuth({
\t\tgithubToken: params.githubToken,
\t\tenv,
\t\tfetchImpl: params.fetchImpl ?? fetch
\t});
\tif (!resolved.ok) throw new Error(resolved.errorMessage || "Copilot token exchange failed");
\tconst payload = {
\t\ttoken: resolved.token,
\t\texpiresAt: resolved.expiresAt,
\t\tbaseUrl: resolved.baseUrl,
\t\tupdatedAt: Date.now()
\t};
\tsaveJsonFileFn(cachePath, payload);
\treturn {
\t\ttoken: payload.token,
\t\texpiresAt: payload.expiresAt,
\t\tsource: resolved.source || \`cache:\${cachePath}\`,
\t\tbaseUrl: payload.baseUrl || deriveCopilotApiBaseUrlFromToken(payload.token) || DEFAULT_COPILOT_API_BASE_URL
\t};
}
//#endregion
export { deriveCopilotApiBaseUrlFromToken as n, resolveCopilotApiToken as r, DEFAULT_COPILOT_API_BASE_URL as t };
`;

await fs.writeFile(targetFile, replacement, "utf8");
