import assert from "node:assert/strict";
import test from "node:test";

import {
  COPILOT_TOKEN_EXCHANGE_URL,
  DEFAULT_COPILOT_API_BASE_URL,
  deriveCopilotApiBaseUrlFromToken,
  isCopilotRuntimeTokenCacheUsable,
  resolveCopilotRuntimeAuth,
} from "../runtime/copilot-runtime-auth.mjs";

test("deriveCopilotApiBaseUrlFromToken resolves proxy endpoints", () => {
  assert.equal(
    deriveCopilotApiBaseUrlFromToken("abc;proxy-ep=proxy.example.githubcopilot.com;def"),
    "https://api.example.githubcopilot.com",
  );
});

test("isCopilotRuntimeTokenCacheUsable requires more than five minutes of validity", () => {
  const now = 1_000_000;
  assert.equal(isCopilotRuntimeTokenCacheUsable({ expiresAt: now + 301_000 }, now), true);
  assert.equal(isCopilotRuntimeTokenCacheUsable({ expiresAt: now + 300_000 }, now), false);
});

test("resolveCopilotRuntimeAuth prefers a directly usable Copilot token", async () => {
  const requests = [];
  const result = await resolveCopilotRuntimeAuth({
    githubToken: "github_pat_test_token_1234567890",
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url) === `${DEFAULT_COPILOT_API_BASE_URL}/models`) {
        return { ok: true, status: 200 };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, DEFAULT_COPILOT_API_BASE_URL);
  assert.match(result.source, /^direct:/);
  assert.deepEqual(requests, [`${DEFAULT_COPILOT_API_BASE_URL}/models`]);
});

test("resolveCopilotRuntimeAuth falls back to the GitHub exchange when direct probing fails", async () => {
  const calls = [];
  const result = await resolveCopilotRuntimeAuth({
    githubToken: "github_pat_test_token_1234567890",
    fetchImpl: async (url) => {
      const normalizedUrl = String(url);
      calls.push(normalizedUrl);
      if (normalizedUrl.endsWith("/models")) {
        return { ok: false, status: normalizedUrl.includes("api.githubcopilot.com") ? 401 : 421 };
      }
      if (normalizedUrl === COPILOT_TOKEN_EXCHANGE_URL) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              token: "copilot_session_token_value",
              expires_at: 1_900_000_000,
            };
          },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, DEFAULT_COPILOT_API_BASE_URL);
  assert.equal(result.source, `fetched:${COPILOT_TOKEN_EXCHANGE_URL}`);
  assert.ok(calls.includes(COPILOT_TOKEN_EXCHANGE_URL));
});
