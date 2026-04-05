import { printReport } from "../reporting.mjs";

export function pluralize(label, count) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function summarizeOpenClawStatusPayload(payload) {
  const gateway = payload?.gateway ?? {};
  const gatewayUrl = String(gateway.url ?? "").trim();
  const gatewayVersion = String(gateway?.self?.version ?? "").trim();
  const channelCount = Array.isArray(payload?.channelOrder)
    ? payload.channelOrder.length
    : Array.isArray(payload?.channelSummary)
      ? payload.channelSummary.filter((line) => /^[A-Za-z]/.test(String(line ?? "").trim())).length
      : 0;
  const sessionCount = Number.isInteger(payload?.sessions?.count)
    ? payload.sessions.count
    : Number.isInteger(payload?.agents?.totalSessions)
      ? payload.agents.totalSessions
      : 0;

  if (gateway.reachable === false) {
    const errorDetail = String(gateway.error ?? gateway.authWarning ?? "").trim();
    return `Gateway is not reachable at ${gatewayUrl || "the configured URL"}${errorDetail ? ` (${errorDetail})` : ""}.`;
  }

  const parts = [gatewayUrl ? `Gateway reachable at ${gatewayUrl}` : "Gateway is reachable"];
  if (gatewayVersion) parts.push(`OpenClaw ${gatewayVersion}`);
  parts.push(`${pluralize("channel", channelCount)} configured`);
  parts.push(`${pluralize("session", sessionCount)} detected`);
  return `${parts.join("; ")}.`;
}

export function summarizeOpenClawHealthPayload(payload) {
  const telegramProbe = payload?.channels?.telegram?.probe;
  if (payload?.ok) {
    const username = String(telegramProbe?.bot?.username ?? "").trim();
    const elapsedMs = Number.isFinite(telegramProbe?.elapsedMs) ? telegramProbe.elapsedMs : null;
    return `Gateway health RPC succeeded${username ? `; Telegram probe ok for @${username}` : ""}${elapsedMs != null ? ` (${elapsedMs} ms)` : ""}.`;
  }

  const detail = String(telegramProbe?.error ?? "").trim();
  return `Gateway health RPC failed${detail ? ` (${detail})` : ""}.`;
}

export function printCommandReport(status, title, summary = [], sections = [], meta = {}) {
  printReport({
    status,
    title,
    summaryTitle: meta.summaryTitle || "Overview",
    summary,
    sections
  });
}

export function buildStatusSection(title, status, items) {
  const normalizedItems = items.filter(Boolean);
  if (normalizedItems.length === 0) return null;
  return {
    title,
    status,
    items: normalizedItems
  };
}

export function summarizeCommandFailure(command, result, fallbackMessage) {
  const lines = [result?.stderr, result?.stdout]
    .flatMap((value) => String(value ?? "").split(/\r?\n/g))
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningfulLines = lines.filter((line) =>
    !/^\[(warn|info|notice)\]/i.test(line)
    && !/^Image .+\b(Building|Built)\b/i.test(line)
    && !/^#\d+\s+(DONE|CACHED)\b/i.test(line)
  );
  const detail = meaningfulLines.find((line) => /failed to solve|syntax error|error:|error\b|failed\b/i.test(line))
    || meaningfulLines.find((line) => !/^#\d+\s+\[/i.test(line))
    || meaningfulLines[0];
  return detail ? `${fallbackMessage} ${detail}` : fallbackMessage;
}

export function extractDashboardUrl(output) {
  const match = String(output ?? "").match(/https?:\/\/\S+/);
  return match ? match[0].trim() : "";
}

export function capitalizeSentence(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function buildPreparedSection(items) {
  return buildStatusSection("Files", "success", items.map((item) => ({
    status: "success",
    text: item
  })));
}

export function buildNextStepsSection(items) {
  return buildStatusSection("Next steps", "info", items.map((item) => {
    if (typeof item === "string") {
      return {
        status: "info",
        icon: "›",
        text: item
      };
    }
    return {
      status: item?.status || "info",
      icon: item?.icon || "›",
      text: item?.text || ""
    };
  }));
}

export function buildDashboardUrl(port, gatewayToken = "") {
  const normalizedPort = String(port ?? "").trim();
  if (!normalizedPort) return "";
  const url = new URL(`http://127.0.0.1:${normalizedPort}/`);
  const normalizedToken = String(gatewayToken ?? "").trim();
  if (normalizedToken) {
    url.hash = `token=${encodeURIComponent(normalizedToken)}`;
  }
  return url.toString();
}

export function summarizeDoctorResults(results) {
  return results.reduce((summary, result) => {
    if (result.ok) {
      summary.ok += 1;
      return summary;
    }
    if (result.level === "info") summary.info += 1;
    else if (result.level === "warning") summary.warn += 1;
    else summary.fail += 1;
    return summary;
  }, { ok: 0, info: 0, warn: 0, fail: 0 });
}
