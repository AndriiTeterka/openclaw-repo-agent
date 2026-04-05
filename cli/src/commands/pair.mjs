import {
  gatewayRunning,
  openclawGatewayCommand,
  openclawHostCommand,
  prepareReadOnlyState
} from "../command-runtime.mjs";
import {
  buildStatusSection,
  capitalizeSentence,
  printCommandReport,
  summarizeCommandFailure
} from "../ui/report-helpers.mjs";
import { parseJsonOutput } from "../utils/parse-utils.mjs";

function isExternalGatewayPairMode(options) {
  return Boolean(String(options.gatewayUrl ?? "").trim());
}

function validateExternalGatewayPairOptions(options) {
  if (!options.gatewayUrl && (options.gatewayToken || options.gatewayPassword)) {
    throw new Error("--gateway-token and --gateway-password require --gateway-url.");
  }
}

function buildExternalGatewayAuthArgs(options) {
  const url = String(options.gatewayUrl ?? "").trim();
  const token = String(options.gatewayToken ?? "").trim();
  const password = String(options.gatewayPassword ?? "").trim();
  const args = [];
  if (url) args.push("--url", url);
  if (token) args.push("--token", token);
  if (password) args.push("--password", password);
  return args;
}

function normalizePendingPairingRequests(payload) {
  const visited = new Set();

  function collect(value) {
    if (!value || typeof value !== "object") return [];
    if (visited.has(value)) return [];
    visited.add(value);

    if (Array.isArray(value)) {
      return value.flatMap((entry) => collect(entry));
    }

    const code = String(value.code ?? value.pairingCode ?? value.pairing_code ?? "").trim();
    if (code) {
      return [{
        code,
        requestedAt: String(value.requestedAt ?? value.requested ?? value.createdAt ?? value.created_at ?? "").trim(),
        raw: value
      }];
    }

    return Object.values(value).flatMap((entry) => collect(entry));
  }

  return collect(payload);
}

export function selectLatestPendingPairingRequest(payload) {
  const requests = normalizePendingPairingRequests(payload);
  if (requests.length === 0) return null;

  let bestIndex = 0;
  let bestTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < requests.length; index += 1) {
    const timestamp = Date.parse(requests[index].requestedAt);
    if (!Number.isNaN(timestamp) && timestamp >= bestTimestamp) {
      bestIndex = index;
      bestTimestamp = timestamp;
      continue;
    }
    if (Number.isNaN(timestamp) && bestTimestamp === Number.NEGATIVE_INFINITY) {
      bestIndex = index;
    }
  }

  return requests[bestIndex];
}
function normalizePendingDeviceRequests(payload) {
  const pending = Array.isArray(payload?.pending) ? payload.pending : [];
  return pending
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      requestId: String(entry.requestId ?? entry.request_id ?? "").trim(),
      clientId: String(entry.clientId ?? entry.client_id ?? "").trim(),
      clientMode: String(entry.clientMode ?? entry.client_mode ?? "").trim(),
      role: String(entry.role ?? "").trim(),
      ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : 0
    }))
    .filter((entry) => entry.requestId);
}

export function selectLatestPendingDeviceRequest(payload) {
  const requests = normalizePendingDeviceRequests(payload);
  if (requests.length === 0) return null;
  return requests.reduce((latest, current) => current.ts >= latest.ts ? current : latest);
}
function createPairTargetResult(target, action, approved, requestCode, detail) {
  return {
    target,
    action,
    approved,
    requestCode,
    detail
  };
}

function pairTargetLabel(target) {
  switch (target) {
    case "gateway-device":
      return "Gateway device";
    case "telegram":
      return "Telegram DM";
    case "external-device":
      return "External device";
    default:
      return capitalizeSentence(String(target ?? "").replace(/-/g, " "));
  }
}

function summarizePairTargets(mode, targets = []) {
  const normalizedTargets = targets.filter(Boolean);
  const approvedCount = normalizedTargets.filter((target) => target.approved).length;
  const requestCodes = normalizedTargets.map((target) => target.requestCode).filter(Boolean);

  return {
    mode,
    action: approvedCount === 0
      ? "listed"
      : normalizedTargets.some((target) => target.action === "approved")
        ? `approved ${approvedCount} request${approvedCount === 1 ? "" : "s"}`
        : `auto-approved ${approvedCount} request${approvedCount === 1 ? "" : "s"}`,
    approved: approvedCount > 0,
    requestCode: requestCodes.join(", "),
    detail: approvedCount > 0
      ? `Approved ${approvedCount} pending pairing request${approvedCount === 1 ? "" : "s"}.`
      : "No pending pairing request was approved.",
    targets: normalizedTargets
  };
}

function buildPairDetailsSection(targets = []) {
  return buildStatusSection("Details", "info", targets.map((target) => `${pairTargetLabel(target.target)}: ${target.detail}`));
}

function isUnknownLocalPairRequest(result) {
  const message = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`;
  return /unknown requestid|not found|no pending|invalid request/i.test(message);
}

async function approveLocalDevicePair(context, requestId, options = {}) {
  const approveResult = await openclawGatewayCommand(context, ["devices", "approve", requestId], { capture: true });
  if (approveResult.code !== 0) {
    if (options.allowMissing && isUnknownLocalPairRequest(approveResult)) return null;
    throw new Error(summarizeCommandFailure(
      "openclaw devices approve",
      approveResult,
      `Failed to approve local gateway device pairing request ${requestId}.`
    ));
  }

  return createPairTargetResult(
    "gateway-device",
    "approved",
    true,
    requestId,
    `Approved gateway device pairing request ${requestId}.`
  );
}

async function autoApproveLocalDevicePair(context) {
  const pendingResult = await openclawGatewayCommand(context, ["devices", "list", "--json"], { capture: true });
  if (pendingResult.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw devices list",
      pendingResult,
      "Failed to read gateway device pairing requests."
    ));
  }

  const request = selectLatestPendingDeviceRequest(parseJsonOutput(pendingResult.stdout, null));
  if (!request?.requestId) {
    return createPairTargetResult(
      "gateway-device",
      "listed",
      false,
      "",
      "No pending gateway device pairing request was found."
    );
  }

  const approved = await approveLocalDevicePair(context, request.requestId);
  return {
    ...approved,
    action: "auto-approved"
  };
}

async function approveLocalTelegramPair(context, requestCode, options = {}) {
  const approveResult = await openclawGatewayCommand(context, ["pairing", "approve", "telegram", requestCode], { capture: true });
  if (approveResult.code !== 0) {
    if (options.allowMissing && isUnknownLocalPairRequest(approveResult)) return null;
    throw new Error(summarizeCommandFailure(
      "openclaw pairing approve telegram",
      approveResult,
      `Failed to approve local Telegram pairing request ${requestCode}.`
    ));
  }

  return createPairTargetResult(
    "telegram",
    "approved",
    true,
    requestCode,
    `Approved Telegram pairing request ${requestCode}.`
  );
}

async function autoApproveLocalTelegramPair(context) {
  const pendingResult = await openclawGatewayCommand(context, ["pairing", "list", "telegram", "--json"], { capture: true });
  if (pendingResult.code !== 0) {
    throw new Error(summarizeCommandFailure(
      "openclaw pairing list telegram",
      pendingResult,
      "Failed to read Telegram pairing requests."
    ));
  }

  let payload = null;
  try {
    payload = JSON.parse(pendingResult.stdout || "null");
  } catch {
    payload = null;
  }

  const request = selectLatestPendingPairingRequest(payload);
  if (!request?.code) {
    return createPairTargetResult(
      "telegram",
      "listed",
      false,
      "",
      "No pending Telegram pairing request was found."
    );
  }

  const approved = await approveLocalTelegramPair(context, request.code);
  return {
    ...approved,
    action: "auto-approved"
  };
}

async function handleExternalGatewayPair(context, options) {
  const gatewayArgs = buildExternalGatewayAuthArgs(options);
  if (options.approve) {
    await openclawHostCommand(context, ["devices", "approve", options.approve, ...gatewayArgs]);
    return createPairTargetResult(
      "external-device",
      "approved",
      true,
      options.approve,
      `Approved external device pairing request ${options.approve}.`
    );
  }

  const approveLatest = await openclawHostCommand(context, ["devices", "approve", "--latest", ...gatewayArgs], { capture: true });
  if (approveLatest.code === 0) {
    return createPairTargetResult(
      "external-device",
      "auto-approved",
      true,
      "",
      "Approved the latest pending external device pairing request."
    );
  }

  const list = await openclawHostCommand(context, ["devices", "list", ...(options.json ? ["--json"] : []), ...gatewayArgs], { capture: true });
  if (list.code === 0) {
    return createPairTargetResult(
      "external-device",
      "listed",
      false,
      "",
      "No external device pairing request was auto-approved."
    );
  }

  const reason = summarizeCommandFailure(
    "openclaw devices approve --latest",
    approveLatest.code !== 0 ? approveLatest : list,
    "Failed to pair against the external OpenClaw gateway."
  );
  if (/not found|is not recognized|ENOENT/i.test(reason)) {
    throw new Error("Host OpenClaw CLI is required for --gateway-url pairing. Install `openclaw` locally and retry.");
  }
  throw new Error(reason);
}

export async function handlePair(context, options) {
  validateExternalGatewayPairOptions(options);
  const state = await prepareReadOnlyState(context, options);
  let pairResult = summarizePairTargets(isExternalGatewayPairMode(options) ? "external" : "local", []);

  if (isExternalGatewayPairMode(options)) {
    pairResult = summarizePairTargets("external", [await handleExternalGatewayPair(context, options)]);
  } else {
    if (!(await gatewayRunning(context))) {
      throw new Error("OpenClaw gateway is not running. Start it with openclaw-repo-agent up first.");
    }

    if (options.approve) {
      const devicePairResult = await approveLocalDevicePair(context, options.approve, { allowMissing: true });
      pairResult = summarizePairTargets("local", [
        devicePairResult || await approveLocalTelegramPair(context, options.approve)
      ]);
    } else {
      pairResult = summarizePairTargets("local", [
        await autoApproveLocalDevicePair(context),
        await autoApproveLocalTelegramPair(context)
      ]);
    }
  }

  printCommandReport(pairResult.approved ? "success" : "info", "Pairing complete", [
    { label: "Action", value: pairResult.action },
    { label: "Request", value: pairResult.requestCode || "(latest or none)" },
    { label: "Result", value: pairResult.detail }
  ], [
    buildPairDetailsSection(pairResult.targets)
  ].filter(Boolean));
}
