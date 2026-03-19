import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json");

export const PRODUCT_NAME = String(packageJson.name ?? "openclaw-repo-agent");
export const PRODUCT_VERSION = String(packageJson.version ?? "0.0.0");
