import path from "node:path";

import { fileExists, readJsonFile, readTextFile, uniqueStrings } from "../../runtime/shared.mjs";

function basenameFallback(repoRoot) {
  return path.basename(path.resolve(repoRoot));
}

function normalizeDetectedProjectName(value, fallback) {
  const normalized = String(value ?? "").trim().replace(/^@[^/]+\//, "");
  return normalized || fallback;
}

function parseTomlStringValue(raw, key) {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"));
  return match?.[1]?.trim() || "";
}

function parseTomlSectionStringValue(raw, section, key) {
  let inSection = false;
  const sectionHeader = `[${section}]`;
  const sectionLines = [];

  for (const line of raw.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (/^\[.+\]$/.test(trimmed)) {
      if (trimmed === sectionHeader) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (inSection) sectionLines.push(line);
  }

  return parseTomlStringValue(sectionLines.join("\n"), key);
}

function parseXmlTagValues(raw, tag) {
  return [...raw.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "g"))].map((match) => match[1].trim()).filter(Boolean);
}

function parseGradleRootProjectName(raw) {
  const match = raw.match(/rootProject\.name\s*=\s*["']([^"']+)["']/);
  return match?.[1]?.trim() || "";
}

function parseGoModuleName(raw) {
  const match = raw.match(/^\s*module\s+([^\s]+)\s*$/m);
  if (!match?.[1]) return "";
  return match[1].split("/").filter(Boolean).pop() || "";
}

function detectNodePackageManager(markers, packageJson = {}) {
  const declaredPackageManager = String(packageJson.packageManager ?? "").trim();
  if (declaredPackageManager.startsWith("pnpm@")) return "pnpm";
  if (declaredPackageManager.startsWith("yarn@")) return "yarn";
  if (declaredPackageManager.startsWith("npm@")) return "npm";
  if (markers.pnpmLock) return "pnpm";
  if (markers.yarnLock) return "yarn";
  return "npm";
}

function buildNodeVerificationCommands(packageJson = {}, packageManager = "npm") {
  const scripts = packageJson && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const commands = [];

  if (scripts.build) {
    commands.push(packageManager === "yarn" ? "yarn build" : `${packageManager} run build`);
  } else if (packageManager !== "yarn") {
    commands.push(packageManager === "npm" ? "npm run build --if-present" : `${packageManager} run build --if-present`);
  }

  if (scripts.test) {
    commands.push(packageManager === "yarn" ? "yarn test" : `${packageManager} test`);
  } else if (packageManager !== "yarn") {
    commands.push(packageManager === "npm" ? "npm test --if-present" : `${packageManager} test --if-present`);
  }

  return uniqueStrings(commands);
}

async function detectProjectMetadata(repoRoot, markers) {
  const fallback = basenameFallback(repoRoot);
  const metadata = {
    projectName: fallback,
    nodeVerificationCommands: []
  };

  if (markers.packageJson) {
    const packageJson = await readJsonFile(path.join(repoRoot, "package.json"), {});
    metadata.projectName = normalizeDetectedProjectName(packageJson.name, metadata.projectName);
    metadata.nodeVerificationCommands = buildNodeVerificationCommands(packageJson, detectNodePackageManager(markers, packageJson));
    return metadata;
  }

  if (markers.pyproject) {
    const pyproject = await readTextFile(path.join(repoRoot, "pyproject.toml"), "");
    metadata.projectName = normalizeDetectedProjectName(
      parseTomlSectionStringValue(pyproject, "project", "name") || parseTomlSectionStringValue(pyproject, "tool.poetry", "name"),
      metadata.projectName
    );
    return metadata;
  }

  if (markers.settingsGradle || markers.settingsGradleKts) {
    const settingsGradle = await readTextFile(
      path.join(repoRoot, markers.settingsGradle ? "settings.gradle" : "settings.gradle.kts"),
      ""
    );
    metadata.projectName = normalizeDetectedProjectName(parseGradleRootProjectName(settingsGradle), metadata.projectName);
    return metadata;
  }

  if (markers.pomXml) {
    const pomXml = await readTextFile(path.join(repoRoot, "pom.xml"), "");
    metadata.projectName = normalizeDetectedProjectName(
      parseXmlTagValues(pomXml, "name")[0] || parseXmlTagValues(pomXml, "artifactId").slice(-1)[0],
      metadata.projectName
    );
    return metadata;
  }

  if (markers.goMod) {
    const goMod = await readTextFile(path.join(repoRoot, "go.mod"), "");
    metadata.projectName = normalizeDetectedProjectName(parseGoModuleName(goMod), metadata.projectName);
  }

  return metadata;
}

export async function detectRepository(repoRoot) {
  const markerEntries = [
    ["gradlew", "gradlew"],
    ["buildGradle", "build.gradle"],
    ["buildGradleKts", "build.gradle.kts"],
    ["settingsGradle", "settings.gradle"],
    ["settingsGradleKts", "settings.gradle.kts"],
    ["pomXml", "pom.xml"],
    ["packageJson", "package.json"],
    ["packageLock", "package-lock.json"],
    ["pnpmLock", "pnpm-lock.yaml"],
    ["yarnLock", "yarn.lock"],
    ["pyproject", "pyproject.toml"],
    ["requirements", "requirements.txt"],
    ["goMod", "go.mod"]
  ];
  const markers = Object.fromEntries(await Promise.all(markerEntries.map(async ([key, relativePath]) => [
    key,
    await fileExists(path.join(repoRoot, relativePath))
  ])));
  const metadata = await detectProjectMetadata(repoRoot, markers);

  const signals = [];
  if (markers.gradlew || markers.buildGradle || markers.buildGradleKts || markers.settingsGradle || markers.settingsGradleKts || markers.pomXml) signals.push("java17");
  if (markers.packageJson) signals.push("node20");
  if (markers.pyproject || markers.requirements) signals.push("python311");
  if (markers.goMod) signals.push("go122");

  const toolingProfile = signals.length > 1 ? "polyglot" : signals[0] ?? "none";
  const verificationCommands = [];
  if (signals.includes("java17")) {
    if (markers.gradlew) verificationCommands.push("./gradlew build");
    else if (markers.pomXml) verificationCommands.push("mvn test");
  }
  if (signals.includes("node20")) {
    verificationCommands.push(...metadata.nodeVerificationCommands);
  }
  if (signals.includes("python311")) {
    verificationCommands.push("python -m pytest");
  }
  if (signals.includes("go122")) {
    verificationCommands.push("go test ./...");
  }

  return {
    profile: "custom",
    projectName: metadata.projectName,
    toolingProfile,
    verificationCommands: uniqueStrings(verificationCommands)
  };
}
