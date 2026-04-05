#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const distRoot = process.argv[2];
const PATCH_MARKER = "OPENCLAW_DISABLE_PLUGIN_AUTO_ENABLE_PATCH";

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

async function replaceRequired(files, matcher, replacement, label) {
  let replacementCount = 0;

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const updated = source.replace(matcher, (...args) => {
      replacementCount += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (updated !== source) {
      await fs.writeFile(filePath, updated);
    }
  }

  if (replacementCount === 0) {
    throw new Error(`Unable to find expected OpenClaw source for ${label}`);
  }
}

const files = await listJavaScriptFiles(distRoot);
if ((await Promise.all(files.map((filePath) => fs.readFile(filePath, "utf8")))).some((source) => source.includes(PATCH_MARKER))) {
  process.exit(0);
}

const autoEnableReplacement = `const ${PATCH_MARKER} = true;
\t\tconst autoEnable = {
\t\t\tconfig: configSnapshot.config,
\t\t\tchanges: []
\t\t};`;

await replaceRequired(
  files,
  /const autoEnable = applyPluginAutoEnable\(\{\s*config: configSnapshot\.config,\s*env: process\.env\s*\}\);/,
  autoEnableReplacement,
  "gateway plugin auto-enable startup hook",
);
