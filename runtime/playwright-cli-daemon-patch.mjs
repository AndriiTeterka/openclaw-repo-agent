#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const npmRoot = process.argv[2];

if (!npmRoot) {
  throw new Error("Missing npm global root path.");
}

const daemonProgram = path.join(
  npmRoot,
  "@playwright",
  "cli",
  "node_modules",
  "playwright",
  "lib",
  "cli",
  "daemon",
  "program.js"
);
const browserTab = path.join(
  npmRoot,
  "@playwright",
  "cli",
  "node_modules",
  "playwright",
  "lib",
  "mcp",
  "browser",
  "tab.js"
);

function replaceRequired(source, from, to, filePath) {
  if (!source.includes(from)) {
    throw new Error(`Unable to find expected Playwright CLI source in ${filePath}`);
  }
  return source.replace(from, to);
}

const daemonSource = await fs.readFile(daemonProgram, "utf8");
const daemonFrom = `    outputMode: "file",
    snapshotMode: "full"`;
const daemonTo = `    outputMode: "stdout",
    snapshotMode: "incremental"`;

await fs.writeFile(
  daemonProgram,
  replaceRequired(daemonSource, daemonFrom, daemonTo, daemonProgram)
);

const tabSource = await fs.readFile(browserTab, "utf8");
const tabFrom = `    const level = consoleLevelForMessageType(message.type);
    if (level === "error" || level === "warning")
      this._consoleLog.appendLine(wallTime, () => message.toString());`;
const tabTo = `    const level = consoleLevelForMessageType(message.type);
    if (this.context.config.outputMode === "file" && (level === "error" || level === "warning"))
      this._consoleLog.appendLine(wallTime, () => message.toString());`;

await fs.writeFile(
  browserTab,
  replaceRequired(tabSource, tabFrom, tabTo, browserTab)
);
