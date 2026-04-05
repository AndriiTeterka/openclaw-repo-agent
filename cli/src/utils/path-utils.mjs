import path from "node:path";

export function toDockerPath(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

export function toHostPath(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return path.resolve(normalized.replace(/\//g, path.sep));
}

export function normalizePortablePath(value) {
  let normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const desktopHostMountMatch = normalized.match(/^\/run\/desktop\/mnt\/host\/([a-z])(?:\/(.*))?$/i)
    || normalized.match(/^\/host_mnt\/([a-z])(?:\/(.*))?$/i)
    || normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (desktopHostMountMatch) {
    const [, driveLetter, remainder = ""] = desktopHostMountMatch;
    normalized = `${driveLetter}:/${remainder}`.replace(/\/+$/g, "");
  }
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
