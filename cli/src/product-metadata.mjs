import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json");

export const PRODUCT_NAME = String(packageJson.name ?? "openclaw-repo-agent");
export const PRODUCT_VERSION = String(packageJson.version ?? "0.0.0");
const RUNTIME_CORE_IMAGE_REPOSITORY = "ghcr.io/andriiteterka/openclaw-repo-agent-runtime-core";
export const DEFAULT_RUNTIME_CORE_IMAGE = `${RUNTIME_CORE_IMAGE_REPOSITORY}:latest`;
