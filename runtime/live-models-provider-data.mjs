#!/usr/bin/env node

import { buildLiveProviderSelectionData } from "./model-catalog.mjs";

function parseArgs(raw = "") {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return {};

  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`Invalid live provider discovery payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const payload = parseArgs(process.argv[2]);
const result = buildLiveProviderSelectionData({
  allowedAgents: Array.isArray(payload.allowedAgents) ? payload.allowedAgents : [],
  defaultAgent: payload.defaultAgent,
  authMode: payload.authMode,
  env: process.env,
});

process.stdout.write(`${JSON.stringify(result)}\n`);
