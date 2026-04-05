import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeStack,
  normalizeToolingProfiles,
} from "../../runtime/tooling-stack.mjs";
import { readTextFile, uniqueStrings } from "../../runtime/shared.mjs";

function basenameFallback(repoRoot) {
  return path.basename(path.resolve(repoRoot));
}

function normalizeDetectedProjectName(value, fallback) {
  const normalized = String(value ?? "").trim().replace(/^@[^/]+\//, "");
  if (!normalized) return fallback;
  if (/^[^/\s]+(?:\/[^/\s]+)+$/.test(normalized)) {
    return normalized.split("/").filter(Boolean).pop() || fallback;
  }
  return normalized;
}

function normalizeWorkspacePath(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return normalized || ".";
}

function compareWorkspacePaths(left, right) {
  if (left === "." && right !== ".") return -1;
  if (right === "." && left !== ".") return 1;
  return left.localeCompare(right);
}

function lowerCaseFileSet(files) {
  return new Set([...files].map((entry) => entry.toLowerCase()));
}

function normalizeProfileFamily(profile) {
  return String(profile ?? "").trim().toLowerCase();
}

function parseTomlStringValue(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"));
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
  return [...raw.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, "g"))]
    .map((match) => match[1].trim())
    .filter(Boolean);
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

function parsePackageJsonWorkspaces(packageJson) {
  if (!packageJson || typeof packageJson !== "object") return [];
  if (Array.isArray(packageJson.workspaces)) return packageJson.workspaces.map((entry) => String(entry));
  if (packageJson.workspaces && Array.isArray(packageJson.workspaces.packages)) {
    return packageJson.workspaces.packages.map((entry) => String(entry));
  }
  return [];
}

function parsePnpmWorkspacePatterns(raw) {
  const patterns = [];
  const lines = raw.split(/\r?\n/g);
  let inPackagesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!inPackagesSection) {
      if (trimmed === "packages:" || trimmed === "packages") inPackagesSection = true;
      continue;
    }
    if (!/^\s+-\s+/.test(line)) {
      if (!/^\s/.test(line)) break;
      continue;
    }
    const match = line.match(/^\s+-\s+["']?([^"']+)["']?\s*$/);
    if (match?.[1]) patterns.push(match[1].trim());
  }

  return patterns;
}

function parseCargoWorkspaceMembers(raw) {
  const workspaceMatch = raw.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
  if (!workspaceMatch?.[1]) return [];
  return [...workspaceMatch[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1].trim()).filter(Boolean);
}

function parseGoWorkUses(raw) {
  const results = [];
  const blockMatch = raw.match(/^\s*use\s*\(([\s\S]*?)^\s*\)/m);
  if (blockMatch?.[1]) {
    for (const line of blockMatch[1].split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      results.push(trimmed.replace(/^\.\/+/, ""));
    }
  }

  for (const match of raw.matchAll(/^\s*use\s+([^\s(][^\r\n]*)$/gm)) {
    const value = String(match[1] ?? "").trim();
    if (value) results.push(value.replace(/^\.\/+/, ""));
  }

  return uniqueStrings(results);
}

function parseGradleIncludedModules(raw) {
  const modules = [];
  for (const line of raw.split(/\r?\n/g)) {
    if (!/^\s*include\b/.test(line)) continue;
    for (const quoted of [...line.matchAll(/["']([^"']+)["']/g)]) {
      const modulePath = String(quoted[1] ?? "").trim().replace(/^:/, "").replace(/:/g, "/");
      if (modulePath) modules.push(modulePath);
    }
  }
  return uniqueStrings(modules);
}

function parseYamlStringValue(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`^\\s*${escapedKey}:\\s*["']?([^"'#\\n]+)["']?`, "m"));
  return match?.[1]?.trim() || "";
}

async function safeReadJson(filePath) {
  const raw = await readTextFile(filePath, "");
  if (!raw.trim()) {
    return {
      exists: false,
      value: null,
      raw: "",
      valid: false,
    };
  }

  try {
    return {
      exists: true,
      value: JSON.parse(raw),
      raw,
      valid: true,
    };
  } catch {
    return {
      exists: true,
      value: null,
      raw,
      valid: false,
    };
  }
}

async function readScopeEntries(scopeRoot) {
  try {
    return await fs.readdir(scopeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectRelativeFiles(scopeRoot, maxDepth = 3, currentDepth = 0, prefix = "") {
  if (currentDepth > maxDepth) return [];
  const entries = await readScopeEntries(scopeRoot);
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(scopeRoot, entry.name);
    if (entry.isFile()) {
      files.push(relativePath);
      continue;
    }
    if (entry.isDirectory() && currentDepth < maxDepth) {
      files.push(...await collectRelativeFiles(absolutePath, maxDepth, currentDepth + 1, relativePath));
    }
  }

  return files;
}

async function expandWorkspacePattern(repoRoot, pattern) {
  const normalizedPattern = normalizeWorkspacePath(pattern);
  if (normalizedPattern === ".") return ["."];
  if (!normalizedPattern.includes("*")) {
    const absolutePath = path.join(repoRoot, normalizedPattern);
    try {
      const stats = await fs.stat(absolutePath);
      return stats.isDirectory() ? [normalizedPattern] : [];
    } catch {
      return [];
    }
  }

  const segments = normalizedPattern.split("/");
  const results = new Set();

  async function walk(currentPath, segmentIndex) {
    if (segmentIndex >= segments.length) {
      if (currentPath !== ".") results.add(currentPath);
      return;
    }

    const currentSegment = segments[segmentIndex];
    if (currentSegment === "**") {
      await walk(currentPath, segmentIndex + 1);
      const scopeRoot = currentPath === "." ? repoRoot : path.join(repoRoot, currentPath);
      for (const entry of await readScopeEntries(scopeRoot)) {
        if (!entry.isDirectory()) continue;
        const nextPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
        await walk(nextPath, segmentIndex);
      }
      return;
    }

    const matcher = new RegExp(`^${currentSegment.replace(/\./g, "\\.").replace(/\*/g, "[^/]+")}$`);
    const scopeRoot = currentPath === "." ? repoRoot : path.join(repoRoot, currentPath);
    for (const entry of await readScopeEntries(scopeRoot)) {
      if (!entry.isDirectory() || !matcher.test(entry.name)) continue;
      const nextPath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
      await walk(nextPath, segmentIndex + 1);
    }
  }

  await walk(".", 0);
  return [...results].sort(compareWorkspacePaths);
}

function hasNodeDependency(packageJson, dependencyName) {
  if (!packageJson || typeof packageJson !== "object") return false;
  const dependencyGroups = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ];
  return dependencyGroups.some((group) => group && typeof group === "object" && Object.prototype.hasOwnProperty.call(group, dependencyName));
}

function firstVersionMatch(raw) {
  const match = String(raw ?? "").match(/(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: match[2] != null ? Number.parseInt(match[2], 10) : null,
  };
}

function profileWithMajor(prefix, rawValue) {
  const version = firstVersionMatch(rawValue);
  if (!version?.major) return "";
  return `${prefix}${version.major}`;
}

function profileWithMajorMinor(prefix, rawValue) {
  const version = firstVersionMatch(rawValue);
  if (!version?.major || version.minor == null) return "";
  return `${prefix}${version.major}${version.minor}`;
}

function extractJavaProfile(scopeEvidence) {
  const candidates = [
    ...parseXmlTagValues(scopeEvidence.pomRaw, "maven.compiler.release"),
    ...parseXmlTagValues(scopeEvidence.pomRaw, "maven.compiler.target"),
    ...parseXmlTagValues(scopeEvidence.pomRaw, "maven.compiler.source"),
    ...parseXmlTagValues(scopeEvidence.pomRaw, "java.version"),
  ];
  const gradleMatches = [
    ...scopeEvidence.buildGradleRaw.matchAll(/JavaLanguageVersion\.of\((\d+)\)/g),
    ...scopeEvidence.buildGradleRaw.matchAll(/(?:sourceCompatibility|targetCompatibility)\s*=\s*["']?(\d+)["']?/g),
    ...scopeEvidence.buildGradleRaw.matchAll(/VERSION_(\d+)/g),
  ].map((match) => match[1]);
  return profileWithMajor("java", candidates[0] || gradleMatches[0] || "");
}

function extractNodeProfile(scopeEvidence) {
  const packageJson = scopeEvidence.packageJson.value ?? {};
  const candidates = [
    packageJson.engines?.node,
    packageJson.volta?.node,
    scopeEvidence.nvmrcRaw,
    scopeEvidence.nodeVersionRaw,
  ];
  return profileWithMajor("node", candidates.find(Boolean) || "");
}

function extractPythonProfile(scopeEvidence) {
  const packageCandidate = parseTomlSectionStringValue(scopeEvidence.pyprojectRaw, "project", "requires-python");
  const poetryCandidate = parseTomlSectionStringValue(scopeEvidence.pyprojectRaw, "tool.poetry.dependencies", "python");
  return profileWithMajorMinor("python", scopeEvidence.pythonVersionRaw || packageCandidate || poetryCandidate || "");
}

function extractGoProfile(scopeEvidence) {
  const match = scopeEvidence.goModRaw.match(/^\s*go\s+(\d+)\.(\d+)/m) || scopeEvidence.goWorkRaw.match(/^\s*go\s+(\d+)\.(\d+)/m);
  if (!match) return "";
  return `go${match[1]}${match[2]}`;
}

function extractRustProfile(scopeEvidence) {
  const tomlChannel = parseTomlSectionStringValue(scopeEvidence.rustToolchainTomlRaw, "toolchain", "channel");
  return profileWithMajorMinor("rust", tomlChannel || scopeEvidence.rustToolchainRaw);
}

function extractPhpProfile(scopeEvidence) {
  const composerJson = scopeEvidence.composerJson.value ?? {};
  return profileWithMajorMinor("php", composerJson.config?.platform?.php || composerJson.require?.php || "");
}

function extractRubyProfile(scopeEvidence) {
  const gemfileRuby = scopeEvidence.gemfileRaw.match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1];
  const gemspecRuby = scopeEvidence.gemspecRaw.match(/required_ruby_version\s*=?\s*["']?([^"'\n]+)/m)?.[1];
  return profileWithMajorMinor("ruby", scopeEvidence.rubyVersionRaw || gemfileRuby || gemspecRuby || "");
}

function extractDotnetProfile(scopeEvidence) {
  const globalSdk = scopeEvidence.globalJson.value?.sdk?.version;
  if (globalSdk) return profileWithMajor("dotnet", globalSdk);

  const framework = scopeEvidence.dotnetProjectFiles
    .flatMap((projectFile) => [...projectFile.raw.matchAll(/<TargetFrameworks?>\s*([^<]+)\s*<\/TargetFrameworks?>/g)])
    .map((match) => match[1].split(";")[0].trim())
    .find(Boolean);
  const dotnetMatch = framework?.match(/net(\d+)(?:\.\d+)?/i);
  return dotnetMatch?.[1] ? `dotnet${dotnetMatch[1]}` : "";
}

function extractSwiftProfile(scopeEvidence) {
  const toolsVersion = scopeEvidence.packageSwiftRaw.match(/swift-tools-version:\s*(\d+)\.(\d+)/i);
  if (toolsVersion) return `swift${toolsVersion[1]}${toolsVersion[2]}`;
  return profileWithMajorMinor("swift", scopeEvidence.swiftVersionRaw);
}

function extractDartProfile(scopeEvidence) {
  const sdkConstraint = scopeEvidence.pubspecRaw.match(/^\s*sdk:\s*["']?([^"'#\n]+)/m)?.[1];
  return profileWithMajor("dart", sdkConstraint || "");
}

function extractCProfile(scopeEvidence) {
  const cmakeMatch = scopeEvidence.cmakeRaw.match(/CMAKE_C_STANDARD\s+(\d+)/i);
  if (cmakeMatch?.[1]) return `c${cmakeMatch[1]}`;
  const mesonMatch = scopeEvidence.mesonRaw.match(/c_std\s*[:=]\s*["']c(\d+)["']/i);
  return mesonMatch?.[1] ? `c${mesonMatch[1]}` : "";
}

function extractCppProfile(scopeEvidence) {
  const cmakeMatch = scopeEvidence.cmakeRaw.match(/CMAKE_CXX_STANDARD\s+(\d+)/i);
  if (cmakeMatch?.[1]) return `cpp${cmakeMatch[1]}`;
  const mesonMatch = scopeEvidence.mesonRaw.match(/cpp_std\s*[:=]\s*["'](?:gnu\+\+|c\+\+)?(\d+)["']/i);
  return mesonMatch?.[1] ? `cpp${mesonMatch[1]}` : "";
}

async function collectMarkers(repoRoot) {
  const rootEntries = await readScopeEntries(repoRoot);
  const rootFiles = new Set(rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const workspacePatterns = [];

  if (rootFiles.has("package.json")) {
    const packageJson = await safeReadJson(path.join(repoRoot, "package.json"));
    workspacePatterns.push(...parsePackageJsonWorkspaces(packageJson.value));
  }

  if (rootFiles.has("pnpm-workspace.yaml")) {
    const pnpmWorkspace = await readTextFile(path.join(repoRoot, "pnpm-workspace.yaml"), "");
    workspacePatterns.push(...parsePnpmWorkspacePatterns(pnpmWorkspace));
  }

  if (rootFiles.has("Cargo.toml")) {
    const cargoToml = await readTextFile(path.join(repoRoot, "Cargo.toml"), "");
    workspacePatterns.push(...parseCargoWorkspaceMembers(cargoToml));
  }

  if (rootFiles.has("go.work")) {
    const goWork = await readTextFile(path.join(repoRoot, "go.work"), "");
    workspacePatterns.push(...parseGoWorkUses(goWork));
  }

  const settingsGradleFile = rootFiles.has("settings.gradle")
    ? "settings.gradle"
    : (rootFiles.has("settings.gradle.kts") ? "settings.gradle.kts" : "");
  if (settingsGradleFile) {
    const settingsGradle = await readTextFile(path.join(repoRoot, settingsGradleFile), "");
    workspacePatterns.push(...parseGradleIncludedModules(settingsGradle));
  }

  if (rootFiles.has("pom.xml")) {
    const pomXml = await readTextFile(path.join(repoRoot, "pom.xml"), "");
    workspacePatterns.push(...parseXmlTagValues(pomXml, "module"));
  }

  const expandedWorkspaces = new Set(["."]);
  for (const pattern of uniqueStrings(workspacePatterns)) {
    for (const workspacePath of await expandWorkspacePattern(repoRoot, pattern)) {
      expandedWorkspaces.add(normalizeWorkspacePath(workspacePath));
    }
  }

  return {
    workspaces: [...expandedWorkspaces].sort(compareWorkspacePaths),
  };
}

async function parseEvidence(repoRoot, markers) {
  const scopes = [];

  for (const workspacePath of markers.workspaces) {
    const scopeRoot = workspacePath === "." ? repoRoot : path.join(repoRoot, workspacePath);
    const entries = await readScopeEntries(scopeRoot);
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const trackedFiles = new Set(await collectRelativeFiles(scopeRoot));
    const packageJson = await safeReadJson(path.join(scopeRoot, "package.json"));
    const composerJson = await safeReadJson(path.join(scopeRoot, "composer.json"));
    const globalJson = await safeReadJson(path.join(scopeRoot, "global.json"));
    const dotnetProjectFiles = [...trackedFiles].filter((entry) => /\.(csproj|fsproj|vbproj)$/i.test(entry)).sort();
    const dotnetProjectFileContents = await Promise.all(dotnetProjectFiles.map(async (fileName) => ({
      fileName,
      raw: await readTextFile(path.join(scopeRoot, ...fileName.split("/")), ""),
    })));
    const gemspecFile = [...trackedFiles].find((entry) => /\.gemspec$/i.test(entry)) || "";

    scopes.push({
      workspacePath,
      root: scopeRoot,
      files,
      directories,
      trackedFiles,
      filesLower: lowerCaseFileSet(files),
      packageJson,
      composerJson,
      globalJson,
      dotnetProjectFiles: dotnetProjectFileContents,
      pyprojectRaw: await readTextFile(path.join(scopeRoot, "pyproject.toml"), ""),
      pomRaw: await readTextFile(path.join(scopeRoot, "pom.xml"), ""),
      buildGradleRaw: await readTextFile(path.join(scopeRoot, files.has("build.gradle.kts") ? "build.gradle.kts" : "build.gradle"), ""),
      settingsGradleRaw: await readTextFile(path.join(scopeRoot, files.has("settings.gradle.kts") ? "settings.gradle.kts" : "settings.gradle"), ""),
      buildSbtRaw: await readTextFile(path.join(scopeRoot, "build.sbt"), ""),
      projectBuildPropertiesRaw: await readTextFile(path.join(scopeRoot, "project", "build.properties"), ""),
      goModRaw: await readTextFile(path.join(scopeRoot, "go.mod"), ""),
      goWorkRaw: await readTextFile(path.join(scopeRoot, "go.work"), ""),
      cargoTomlRaw: await readTextFile(path.join(scopeRoot, "Cargo.toml"), ""),
      rustToolchainRaw: await readTextFile(path.join(scopeRoot, "rust-toolchain"), ""),
      rustToolchainTomlRaw: await readTextFile(path.join(scopeRoot, "rust-toolchain.toml"), ""),
      gemfileRaw: await readTextFile(path.join(scopeRoot, "Gemfile"), ""),
      gemspecRaw: gemspecFile ? await readTextFile(path.join(scopeRoot, ...gemspecFile.split("/")), "") : "",
      packageSwiftRaw: await readTextFile(path.join(scopeRoot, "Package.swift"), ""),
      pubspecRaw: await readTextFile(path.join(scopeRoot, "pubspec.yaml"), ""),
      cmakeRaw: await readTextFile(path.join(scopeRoot, "CMakeLists.txt"), ""),
      mesonRaw: await readTextFile(path.join(scopeRoot, "meson.build"), ""),
      pythonVersionRaw: await readTextFile(path.join(scopeRoot, ".python-version"), ""),
      rubyVersionRaw: await readTextFile(path.join(scopeRoot, ".ruby-version"), ""),
      nodeVersionRaw: await readTextFile(path.join(scopeRoot, ".node-version"), ""),
      nvmrcRaw: await readTextFile(path.join(scopeRoot, ".nvmrc"), ""),
      swiftVersionRaw: await readTextFile(path.join(scopeRoot, ".swift-version"), ""),
    });
  }

  return {
    scopes,
    root: scopes.find((scope) => scope.workspacePath === ".") ?? null,
  };
}

function detectProjectName(repoRoot, parsedEvidence) {
  const fallback = basenameFallback(repoRoot);
  const root = parsedEvidence.root;
  if (!root) return fallback;

  if (root.packageJson.valid) {
    return normalizeDetectedProjectName(root.packageJson.value?.name, fallback);
  }

  if (root.pyprojectRaw) {
    const pythonProjectName = parseTomlSectionStringValue(root.pyprojectRaw, "project", "name")
      || parseTomlSectionStringValue(root.pyprojectRaw, "tool.poetry", "name");
    if (pythonProjectName) return normalizeDetectedProjectName(pythonProjectName, fallback);
  }

  if (root.settingsGradleRaw) {
    const gradleProjectName = parseGradleRootProjectName(root.settingsGradleRaw);
    if (gradleProjectName) return normalizeDetectedProjectName(gradleProjectName, fallback);
  }

  if (root.pomRaw) {
    const mavenProjectName = parseXmlTagValues(root.pomRaw, "name")[0] || parseXmlTagValues(root.pomRaw, "artifactId").slice(-1)[0];
    if (mavenProjectName) return normalizeDetectedProjectName(mavenProjectName, fallback);
  }

  if (root.goModRaw) {
    const goProjectName = parseGoModuleName(root.goModRaw);
    if (goProjectName) return normalizeDetectedProjectName(goProjectName, fallback);
  }

  if (root.cargoTomlRaw) {
    const cargoProjectName = parseTomlSectionStringValue(root.cargoTomlRaw, "package", "name");
    if (cargoProjectName) return normalizeDetectedProjectName(cargoProjectName, fallback);
  }

  if (root.composerJson.valid) {
    const composerProjectName = root.composerJson.value?.name;
    if (composerProjectName) return normalizeDetectedProjectName(composerProjectName, fallback);
  }

  if (root.pubspecRaw) {
    const dartProjectName = parseYamlStringValue(root.pubspecRaw, "name");
    if (dartProjectName) return normalizeDetectedProjectName(dartProjectName, fallback);
  }

  if (root.packageSwiftRaw) {
    const swiftProjectName = root.packageSwiftRaw.match(/name:\s*"([^"]+)"/)?.[1];
    if (swiftProjectName) return normalizeDetectedProjectName(swiftProjectName, fallback);
  }

  return fallback;
}

function detectNodePackageManager(scopeEvidence, rootEvidence) {
  const packageJson = scopeEvidence.packageJson.value ?? rootEvidence.packageJson.value ?? {};
  const declaredPackageManager = String(packageJson.packageManager ?? "").trim();
  if (declaredPackageManager.startsWith("pnpm@")) return "pnpm";
  if (declaredPackageManager.startsWith("yarn@")) return "yarn";
  if (declaredPackageManager.startsWith("npm@")) return "npm";
  if (declaredPackageManager.startsWith("bun@")) return "bun";
  if (rootEvidence.files.has("pnpm-lock.yaml")) return "pnpm";
  if (rootEvidence.files.has("yarn.lock")) return "yarn";
  if (rootEvidence.files.has("package-lock.json")) return "npm";
  if (rootEvidence.files.has("bun.lockb") || rootEvidence.files.has("bun.lock")) return "bun";
  if (rootEvidence.files.has("pnpm-workspace.yaml")) return "pnpm";
  if (scopeEvidence.packageJson.exists || rootEvidence.packageJson.exists) return "npm";
  return "";
}

function hasAnySourceFile(files, pattern) {
  return [...files].some((entry) => pattern.test(entry));
}

function detectNodeScope(scopeEvidence, rootEvidence, languages, tools, toolingProfiles) {
  const packageJson = scopeEvidence.packageJson.value ?? {};
  const hasTsConfig = hasAnySourceFile(scopeEvidence.trackedFiles, /(^|\/)tsconfig(?:\..+)?\.json$/i);
  const hasTypeScriptDependency = hasNodeDependency(packageJson, "typescript");
  const hasTypeScriptSources = hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:ts|tsx|mts|cts)$/i);
  const hasJavaScriptSources = hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:js|jsx|mjs|cjs)$/i);
  const hasNodeMarkers = scopeEvidence.packageJson.exists
    || hasTsConfig
    || Boolean(scopeEvidence.nvmrcRaw || scopeEvidence.nodeVersionRaw)
    || rootEvidence.files.has("pnpm-lock.yaml")
    || rootEvidence.files.has("yarn.lock")
    || rootEvidence.files.has("package-lock.json")
    || rootEvidence.files.has("bun.lock")
    || rootEvidence.files.has("bun.lockb");

  if (!hasNodeMarkers && !hasTypeScriptSources && !hasJavaScriptSources) return;

  if (hasJavaScriptSources) languages.add("javascript");
  if (hasTsConfig || hasTypeScriptDependency || hasTypeScriptSources) languages.add("typescript");

  const packageManager = detectNodePackageManager(scopeEvidence, rootEvidence);
  if (packageManager) tools.add(packageManager);

  const nodeProfile = normalizeProfileFamily(extractNodeProfile(scopeEvidence));
  if (nodeProfile) toolingProfiles.add(nodeProfile);
}

function detectPythonScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasPythonMarkers = Boolean(scopeEvidence.pyprojectRaw)
    || scopeEvidence.files.has("Pipfile")
    || scopeEvidence.files.has("Pipfile.lock")
    || scopeEvidence.files.has("setup.py")
    || scopeEvidence.files.has("setup.cfg")
    || [...scopeEvidence.files].some((entry) => /^requirements(?:[-_.].+)?\.txt$/i.test(entry));
  if (!hasPythonMarkers) return;

  languages.add("python");

  if (scopeEvidence.files.has("uv.lock") || /\[tool\.uv/i.test(scopeEvidence.pyprojectRaw)) {
    tools.add("uv");
  } else if (scopeEvidence.files.has("poetry.lock") || /\[tool\.poetry/i.test(scopeEvidence.pyprojectRaw)) {
    tools.add("poetry");
  } else if (scopeEvidence.files.has("Pipfile") || scopeEvidence.files.has("Pipfile.lock")) {
    tools.add("pipenv");
  } else {
    tools.add("pip");
  }

  const pythonProfile = normalizeProfileFamily(extractPythonProfile(scopeEvidence));
  if (pythonProfile) toolingProfiles.add(pythonProfile);
}

function detectJvmScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasGradle = Boolean(scopeEvidence.buildGradleRaw || scopeEvidence.settingsGradleRaw || scopeEvidence.files.has("gradlew") || scopeEvidence.files.has("gradlew.bat"));
  const hasMaven = Boolean(scopeEvidence.pomRaw || scopeEvidence.files.has("mvnw") || scopeEvidence.files.has("mvnw.cmd"));
  const hasSbt = Boolean(scopeEvidence.buildSbtRaw || /sbt\.version/i.test(scopeEvidence.projectBuildPropertiesRaw));
  if (!hasGradle && !hasMaven && !hasSbt && !hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:java|kt|kts|scala)$/i)) return;

  if (hasMaven) tools.add("maven");
  if (hasGradle) tools.add("gradle");
  if (hasSbt) tools.add("sbt");

  if (hasMaven || hasGradle || hasAnySourceFile(scopeEvidence.trackedFiles, /\.java$/i)) languages.add("java");
  if (hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:kt|kts)$/i) || /kotlin/i.test(scopeEvidence.buildGradleRaw) || /kotlin-maven-plugin/i.test(scopeEvidence.pomRaw)) {
    languages.add("kotlin");
  }
  if (hasSbt || hasAnySourceFile(scopeEvidence.trackedFiles, /\.scala$/i) || /scala/i.test(scopeEvidence.buildGradleRaw) || /scala-maven-plugin/i.test(scopeEvidence.pomRaw)) {
    languages.add("scala");
  }

  const javaProfile = normalizeProfileFamily(extractJavaProfile(scopeEvidence));
  if (javaProfile) toolingProfiles.add(javaProfile);
}

function detectGoScope(scopeEvidence, languages, tools, toolingProfiles) {
  if (!scopeEvidence.goModRaw && !scopeEvidence.goWorkRaw) return;
  languages.add("go");
  tools.add("go");

  const goProfile = normalizeProfileFamily(extractGoProfile(scopeEvidence));
  if (goProfile) toolingProfiles.add(goProfile);
}

function detectRustScope(scopeEvidence, languages, tools, toolingProfiles) {
  if (!scopeEvidence.cargoTomlRaw && !scopeEvidence.rustToolchainRaw && !scopeEvidence.rustToolchainTomlRaw) return;
  languages.add("rust");
  if (scopeEvidence.cargoTomlRaw) tools.add("cargo");

  const rustProfile = normalizeProfileFamily(extractRustProfile(scopeEvidence));
  if (rustProfile) toolingProfiles.add(rustProfile);
}

function detectPhpScope(scopeEvidence, languages, tools, toolingProfiles) {
  if (!scopeEvidence.composerJson.exists) return;
  languages.add("php");
  tools.add("composer");

  const phpProfile = normalizeProfileFamily(extractPhpProfile(scopeEvidence));
  if (phpProfile) toolingProfiles.add(phpProfile);
}

function detectRubyScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasRubyMarkers = Boolean(scopeEvidence.gemfileRaw || scopeEvidence.gemspecRaw || scopeEvidence.rubyVersionRaw || scopeEvidence.files.has("Gemfile.lock"));
  if (!hasRubyMarkers) return;
  languages.add("ruby");
  tools.add("bundler");

  const rubyProfile = normalizeProfileFamily(extractRubyProfile(scopeEvidence));
  if (rubyProfile) toolingProfiles.add(rubyProfile);
}

function detectDotnetScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasDotnetProjects = scopeEvidence.dotnetProjectFiles.length > 0 || [...scopeEvidence.trackedFiles].some((entry) => /\.(sln|csproj|fsproj|vbproj)$/i.test(entry));
  if (!hasDotnetProjects) return;

  if (scopeEvidence.dotnetProjectFiles.some((projectFile) => /\.csproj$/i.test(projectFile.fileName)) || hasAnySourceFile(scopeEvidence.trackedFiles, /\.cs$/i)) {
    languages.add("csharp");
  }
  if (scopeEvidence.dotnetProjectFiles.some((projectFile) => /\.fsproj$/i.test(projectFile.fileName)) || hasAnySourceFile(scopeEvidence.trackedFiles, /\.fs$/i)) {
    languages.add("fsharp");
  }
  if (scopeEvidence.dotnetProjectFiles.some((projectFile) => /\.vbproj$/i.test(projectFile.fileName)) || hasAnySourceFile(scopeEvidence.trackedFiles, /\.vb$/i)) {
    languages.add("vbnet");
  }
  tools.add("dotnet");

  const dotnetProfile = normalizeProfileFamily(extractDotnetProfile(scopeEvidence));
  if (dotnetProfile) toolingProfiles.add(dotnetProfile);
}

function detectCScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasCMake = Boolean(scopeEvidence.cmakeRaw);
  const hasMeson = Boolean(scopeEvidence.mesonRaw);
  const hasMake = scopeEvidence.files.has("Makefile");
  const hasCSource = hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:c|h)$/i);
  const hasCppSource = hasAnySourceFile(scopeEvidence.trackedFiles, /\.(?:cc|cpp|cxx|c\+\+|hpp|hh|hxx)$/i);
  const cProfile = normalizeProfileFamily(extractCProfile(scopeEvidence));
  const cppProfile = normalizeProfileFamily(extractCppProfile(scopeEvidence));

  if (!hasCMake && !hasMeson && !hasMake && !hasCSource && !hasCppSource && !cProfile && !cppProfile) return;

  if (hasCSource || cProfile || /project\s*\([^)]+languages[^)]*\bc\b/i.test(scopeEvidence.cmakeRaw)) languages.add("c");
  if (hasCppSource || cppProfile || /project\s*\([^)]+languages[^)]*\bcxx\b/i.test(scopeEvidence.cmakeRaw)) languages.add("cpp");

  if (hasCMake) tools.add("cmake");
  if (hasMeson) tools.add("meson");
  if (hasMake && (hasCSource || hasCppSource || hasCMake || hasMeson)) tools.add("make");

  if (cProfile) toolingProfiles.add(cProfile);
  if (cppProfile) toolingProfiles.add(cppProfile);
}

function detectSwiftScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasSwiftProject = Boolean(scopeEvidence.packageSwiftRaw || scopeEvidence.swiftVersionRaw)
    || hasAnySourceFile(scopeEvidence.trackedFiles, /\.swift$/i)
    || [...scopeEvidence.directories].some((entry) => /\.(xcodeproj|xcworkspace)$/i.test(entry));
  if (!hasSwiftProject) return;

  languages.add("swift");
  if (scopeEvidence.packageSwiftRaw) tools.add("swiftpm");
  if ([...scopeEvidence.directories].some((entry) => /\.(xcodeproj|xcworkspace)$/i.test(entry))) tools.add("xcodebuild");

  const swiftProfile = normalizeProfileFamily(extractSwiftProfile(scopeEvidence));
  if (swiftProfile) toolingProfiles.add(swiftProfile);
}

function detectDartScope(scopeEvidence, languages, tools, toolingProfiles) {
  const hasDartProject = Boolean(scopeEvidence.pubspecRaw)
    || scopeEvidence.directories.has(".dart_tool")
    || hasAnySourceFile(scopeEvidence.trackedFiles, /\.dart$/i);
  if (!hasDartProject) return;

  languages.add("dart");
  if (/^\s*flutter\s*:/m.test(scopeEvidence.pubspecRaw) || scopeEvidence.directories.has("android") || scopeEvidence.directories.has("ios")) {
    tools.add("flutter");
  } else {
    tools.add("dart");
  }

  const dartProfile = normalizeProfileFamily(extractDartProfile(scopeEvidence));
  if (dartProfile) toolingProfiles.add(dartProfile);
}

function deriveRepositoryTooling(parsedEvidence) {
  const languages = new Set();
  const tools = new Set();
  const toolingProfiles = new Set();
  const rootEvidence = parsedEvidence.root ?? parsedEvidence.scopes[0];

  for (const scopeEvidence of parsedEvidence.scopes) {
    detectNodeScope(scopeEvidence, rootEvidence, languages, tools, toolingProfiles);
    detectPythonScope(scopeEvidence, languages, tools, toolingProfiles);
    detectJvmScope(scopeEvidence, languages, tools, toolingProfiles);
    detectGoScope(scopeEvidence, languages, tools, toolingProfiles);
    detectRustScope(scopeEvidence, languages, tools, toolingProfiles);
    detectPhpScope(scopeEvidence, languages, tools, toolingProfiles);
    detectRubyScope(scopeEvidence, languages, tools, toolingProfiles);
    detectDotnetScope(scopeEvidence, languages, tools, toolingProfiles);
    detectCScope(scopeEvidence, languages, tools, toolingProfiles);
    detectSwiftScope(scopeEvidence, languages, tools, toolingProfiles);
    detectDartScope(scopeEvidence, languages, tools, toolingProfiles);
  }

  return {
    toolingProfiles: normalizeToolingProfiles([...toolingProfiles]),
    stack: normalizeStack({
      languages: [...languages],
      tools: [...tools],
    }),
  };
}

export async function detectRepository(repoRoot) {
  const markers = await collectMarkers(repoRoot);
  const parsedEvidence = await parseEvidence(repoRoot, markers);

  return {
    projectName: detectProjectName(repoRoot, parsedEvidence),
    ...deriveRepositoryTooling(parsedEvidence),
  };
}
