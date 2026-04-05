import {
  resolveBoolean,
  uniqueStrings
} from "../../../runtime/shared.mjs";

export function parseFlexibleArray(rawValue, fallback = []) {
  if (rawValue == null || rawValue === "") return [...fallback];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) throw new Error("expected array");
    return uniqueStrings(parsed);
  } catch {
    return uniqueStrings(String(rawValue).split(/[\n,]+/g));
  }
}

export function parseBooleanString(rawValue, fallback) {
  return resolveBoolean(rawValue, fallback);
}

export function parseJsonOutput(output, fallback = null) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    return fallback;
  }
}
