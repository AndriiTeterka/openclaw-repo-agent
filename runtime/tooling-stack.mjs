import { isPlainObject, uniqueStrings } from "./shared.mjs";

const STACK_LANGUAGE_ORDER = [
  "java",
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "php",
  "ruby",
  "csharp",
  "fsharp",
  "vbnet",
  "kotlin",
  "scala",
  "c",
  "cpp",
  "swift",
  "dart",
];

const STACK_TOOL_ORDER = [
  "maven",
  "gradle",
  "sbt",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "uv",
  "poetry",
  "pipenv",
  "pip",
  "go",
  "cargo",
  "composer",
  "bundler",
  "dotnet",
  "cmake",
  "make",
  "meson",
  "swiftpm",
  "xcodebuild",
  "dart",
  "flutter",
];

const PROFILE_PATTERNS = [
  /^java\d+$/,
  /^node\d+$/,
  /^python\d{2,3}$/,
  /^go\d{2,3}$/,
  /^rust\d{2,3}$/,
  /^php\d{2,3}$/,
  /^ruby\d{2,3}$/,
  /^dotnet\d+$/,
  /^swift\d{2,3}$/,
  /^dart\d+$/,
  /^c(?:89|99|11|17|23)$/,
  /^cpp(?:98|03|11|14|17|20|23|26)$/,
];

const PROFILE_FAMILY_ORDER = [
  "java",
  "node",
  "python",
  "go",
  "rust",
  "php",
  "ruby",
  "dotnet",
  "swift",
  "dart",
  "c",
  "cpp",
];

function sortByKnownOrder(values, order) {
  const indexMap = new Map(order.map((value, index) => [value, index]));
  return [...values].sort((left, right) => {
    const leftIndex = indexMap.has(left) ? indexMap.get(left) : Number.MAX_SAFE_INTEGER;
    const rightIndex = indexMap.has(right) ? indexMap.get(right) : Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.localeCompare(right);
  });
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return uniqueStrings(values.map((value) => String(value ?? "").trim()).filter(Boolean));
}

function isSupportedProfile(value) {
  return PROFILE_PATTERNS.some((pattern) => pattern.test(value));
}

function profileSortWeight(value) {
  const family = PROFILE_FAMILY_ORDER.find((entry) => value.startsWith(entry));
  return family ? PROFILE_FAMILY_ORDER.indexOf(family) : Number.MAX_SAFE_INTEGER;
}

export function createEmptyStack() {
  return {
    languages: [],
    tools: [],
  };
}

export function normalizeToolingProfiles(values = []) {
  const normalized = normalizeStringArray(values)
    .map((value) => value.toLowerCase())
    .filter((value) => isSupportedProfile(value));
  return uniqueStrings(normalized).sort((left, right) => {
    const leftWeight = profileSortWeight(left);
    const rightWeight = profileSortWeight(right);
    if (leftWeight !== rightWeight) return leftWeight - rightWeight;
    return left.localeCompare(right);
  });
}

export function normalizeStack(rawStack = null) {
  const source = isPlainObject(rawStack) ? rawStack : {};
  const languages = sortByKnownOrder(
    normalizeStringArray(source.languages).map((value) => value.toLowerCase()).filter((value) => STACK_LANGUAGE_ORDER.includes(value)),
    STACK_LANGUAGE_ORDER,
  );
  const tools = sortByKnownOrder(
    normalizeStringArray(source.tools).map((value) => value.toLowerCase()).filter((value) => STACK_TOOL_ORDER.includes(value)),
    STACK_TOOL_ORDER,
  );

  return {
    languages,
    tools,
  };
}

export function parseToolingProfilesEnv(rawValue) {
  if (!rawValue) return [];
  try {
    return normalizeToolingProfiles(JSON.parse(rawValue));
  } catch (error) {
    throw new Error(`Invalid JSON array value "${rawValue}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseStackEnv(rawValue) {
  if (!rawValue) return createEmptyStack();
  try {
    return normalizeStack(JSON.parse(rawValue));
  } catch (error) {
    throw new Error(`Invalid JSON object value "${rawValue}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateToolingProfiles(toolingProfiles = []) {
  return Array.isArray(toolingProfiles)
    && toolingProfiles.every((value) => typeof value === "string" && isSupportedProfile(String(value).trim().toLowerCase()));
}
