import { uniqueStrings } from "./model-discovery-shared.mjs";

const COPILOT_MODEL_PREFIX_PATTERN = /^(gpt-|claude-|gemini-|o\d)/;
const COPILOT_DATED_SNAPSHOT_SUFFIX_PATTERN = /-\d{4}-\d{2}-\d{2}$/;

export function normalizeCopilotModelId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("embedding") || normalized.includes("customtools")) return "";
  if (!COPILOT_MODEL_PREFIX_PATTERN.test(normalized)) return "";

  const stableAlias = normalized.replace(COPILOT_DATED_SNAPSHOT_SUFFIX_PATTERN, "");
  return COPILOT_MODEL_PREFIX_PATTERN.test(stableAlias) ? stableAlias : normalized;
}

export function isSupportedCopilotModelId(value) {
  return Boolean(normalizeCopilotModelId(value));
}

export function filterSupportedCopilotModelIds(values = []) {
  return uniqueStrings(values.map((value) => normalizeCopilotModelId(value)).filter(Boolean));
}
