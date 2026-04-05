import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const PATCH_SCRIPT = path.resolve("runtime/openclaw-copilot-token-patch.mjs");
const PATCH_MARKER = "OPENCLAW_COPILOT_TOKEN_PATCH_V1";

const DIST_FIXTURE = `import { _ as resolveStateDir } from "./paths-Y4UT24Of.js";
import { n as saveJsonFile, t as loadJsonFile } from "./json-file-BsUnrt8L.js";
import path from "node:path";
//#region src/agents/github-copilot-token.ts
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
function resolveCopilotTokenCachePath(env = process.env) {
\treturn path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}
function isTokenUsable(cache, now = Date.now()) {
\treturn cache.expiresAt - now > 300 * 1e3;
}
function parseCopilotTokenResponse(value) {
\tif (!value || typeof value !== "object") throw new Error("Unexpected response from GitHub Copilot token endpoint");
\tconst asRecord = value;
\tconst token = asRecord.token;
\tconst expiresAt = asRecord.expires_at;
\tif (typeof token !== "string" || token.trim().length === 0) throw new Error("Copilot token response missing token");
\tlet expiresAtMs;
\tif (typeof expiresAt === "number" && Number.isFinite(expiresAt)) expiresAtMs = expiresAt < 1e11 ? expiresAt * 1e3 : expiresAt;
\telse if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
\t\tconst parsed = Number.parseInt(expiresAt, 10);
\t\tif (!Number.isFinite(parsed)) throw new Error("Copilot token response has invalid expires_at");
\t\texpiresAtMs = parsed < 1e11 ? parsed * 1e3 : parsed;
\t} else throw new Error("Copilot token response missing expires_at");
\treturn {
\t\ttoken,
\t\texpiresAt: expiresAtMs
\t};
}
const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
function deriveCopilotApiBaseUrlFromToken(token) {
\tconst trimmed = token.trim();
\tif (!trimmed) return null;
\tconst proxyEp = trimmed.match(/(?:^|;)\\s*proxy-ep=([^;\\s]+)/i)?.[1]?.trim();
\tif (!proxyEp) return null;
\tconst host = proxyEp.replace(/^https?:\\/\\//, "").replace(/^proxy\\./i, "api.");
\tif (!host) return null;
\treturn \`https://\${host}\`;
}
async function resolveCopilotApiToken(params) {
\tconst env = params.env ?? process.env;
\tconst cachePath = params.cachePath?.trim() || resolveCopilotTokenCachePath(env);
\tconst loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
\tconst saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
\tconst cached = loadJsonFileFn(cachePath);
\tif (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
\t\tif (isTokenUsable(cached)) return {
\t\t\ttoken: cached.token,
\t\t\texpiresAt: cached.expiresAt,
\t\t\tsource: \`cache:\${cachePath}\`,
\t\t\tbaseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? "https://api.individual.githubcopilot.com"
\t\t};
\t}
\tconst res = await (params.fetchImpl ?? fetch)(COPILOT_TOKEN_URL, {
\t\tmethod: "GET",
\t\theaders: {
\t\t\tAccept: "application/json",
\t\t\tAuthorization: \`Bearer \${params.githubToken}\`
\t\t}
\t});
\tif (!res.ok) throw new Error(\`Copilot token exchange failed: HTTP \${res.status}\`);
\tconst json = parseCopilotTokenResponse(await res.json());
\tconst payload = {
\t\ttoken: json.token,
\t\texpiresAt: json.expiresAt,
\t\tupdatedAt: Date.now()
\t};
\tsaveJsonFileFn(cachePath, payload);
\treturn {
\t\ttoken: payload.token,
\t\texpiresAt: payload.expiresAt,
\t\tsource: \`fetched:\${COPILOT_TOKEN_URL}\`,
\t\tbaseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? "https://api.individual.githubcopilot.com"
\t};
}
//#endregion
export { deriveCopilotApiBaseUrlFromToken as n, resolveCopilotApiToken as r, DEFAULT_COPILOT_API_BASE_URL as t };
`;

test("copilot token patch upgrades the bundled token resolver and is idempotent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-token-patch-"));
  const distDir = path.join(tempDir, "dist");
  const distFile = path.join(distDir, "github-copilot-token-Be9GQ0Nm.js");

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(distFile, DIST_FIXTURE);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patched = await fs.readFile(distFile, "utf8");

  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.match(patched, /from "\/opt\/openclaw\/copilot-runtime-auth\.mjs"/);
  assert.match(patched, /resolveCopilotRuntimeAuth/);
  assert.match(patched, /DEFAULT_COPILOT_API_BASE_URL/);
  assert.match(patched, /baseUrl: typeof cached\.baseUrl === "string"/);

  execFileSync(process.execPath, [PATCH_SCRIPT, distDir], { stdio: "pipe" });
  const patchedAgain = await fs.readFile(distFile, "utf8");
  assert.equal(patchedAgain, patched);
});
