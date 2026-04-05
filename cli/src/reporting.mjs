import { Chalk } from "chalk";
import stringWidth from "string-width";

const DEFAULT_LABEL_WIDTH = 14;
const SECTION_ICON_WIDTH = 2;
const SUCCESS_ICON = "✔";
const INFO_ICON = "›";
const WARNING_ICON = "▲";
const ERROR_ICON = "✖";
const PLAIN_STATUS_ICONS = {
  success: SUCCESS_ICON,
  warning: WARNING_ICON,
  error: ERROR_ICON,
  info: INFO_ICON
};

const STATUS_META = {
  success: { label: "OK" },
  warning: { label: "WARN" },
  error: { label: "FAIL" },
  info: { label: "INFO" }
};

const REPORT_TITLE_ALIASES = {
  "Init complete": "'init' completed",
  "Up complete": "'up' completed",
  "Down complete": "'down' completed",
  "Update complete": "'update' completed",
  "Pairing complete": "'pair' completed",
  "Pairing settings updated": "'pair' updated"
};

function resolveReportTitle(title, status = "info") {
  const rawTitle = normalizeText(title);
  const aliasedTitle = REPORT_TITLE_ALIASES[rawTitle] ?? rawTitle;
  if (status === "info" && REPORT_TITLE_ALIASES[rawTitle]) {
    return `${aliasedTitle} (no action required)`;
  }
  return aliasedTitle;
}

const SECTION_META = {
  Configuration: { icon: "⚙️", label: "CONFIGURATION" },
  Overview: { icon: "⚙️", label: "OVERVIEW" },
  Files: { icon: "📁", label: "FILES CREATED" },
  Integrations: { icon: "🔗", label: "INTEGRATIONS" },
  Verification: { icon: "✅", label: "VERIFICATION" },
  Checks: { icon: "🩺", label: "CHECKS" },
  Warnings: { icon: "⚠️", label: "WARNINGS" },
  Notes: { icon: "ℹ️", label: "NOTES" },
  "Next steps": { icon: "➡️", label: "TO DO NEXT" },
  Errors: { icon: "❌", label: "ERRORS" },
  Details: { icon: "📄", label: "DETAILS" }
};

function useColor(stream = process.stdout) {
  return Boolean(stream?.isTTY) && !("NO_COLOR" in process.env);
}

function resolvePaint(options = {}) {
  const enabled = options.color ?? useColor(options.stream);
  return new Chalk({ level: enabled ? 3 : 0 });
}

function colorsEnabled(options = {}) {
  return options.color ?? useColor(options.stream);
}

function resolveStatusIcon(status = "info", options = {}) {
  const icon = PLAIN_STATUS_ICONS[status] ?? PLAIN_STATUS_ICONS.info;
  return colorsEnabled(options) ? colorizeStatus(icon, status, options) : icon;
}

function colorizeStatus(text, status, options = {}) {
  const paint = resolvePaint(options);
  switch (status) {
    case "success":
      return paint.greenBright.bold(text);
    case "warning":
      return paint.yellowBright.bold(text);
    case "error":
      return paint.redBright.bold(text);
    default:
      return paint.cyanBright.bold(text);
  }
}

function colorizeAccent(text, options = {}) {
  return resolvePaint(options).cyanBright.bold(text);
}

function colorizeHeading(text, options = {}) {
  return resolvePaint(options).whiteBright.bold(text);
}

function colorizeLabel(text, options = {}) {
  return resolvePaint(options).dim(text);
}

function colorizeContent(text, options = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (!colorsEnabled(options)) return normalized;

  const paint = resolvePaint(options);
  const accentPattern = /(`[^`]+`|'[^']+')/g;
  const segments = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(accentPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push(paint.white(normalized.slice(lastIndex, index)));
    }
    segments.push(colorizeAccent(match[0], options));
    lastIndex = index + match[0].length;
  }

  if (lastIndex < normalized.length) {
    segments.push(paint.white(normalized.slice(lastIndex)));
  }

  return segments.length > 0 ? segments.join("") : paint.white(normalized);
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeLines(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => normalizeLines(entry))
      .filter(Boolean);
  }

  const text = normalizeText(value);
  if (!text) return [];
  return text.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
}

export function renderStatusMarker(status = "info", options = {}) {
  return resolveStatusIcon(status, options);
}

function renderReportHeading(title, status = "info", options = {}) {
  const normalizedTitle = resolveReportTitle(title, status);
  if (status === "success" || status === "error" || status === "info") {
    const paint = resolvePaint(options);
    const badge = colorsEnabled(options)
      ? (status === "success"
        ? paint.bgGreenBright.black.bold(" SUCCESS ")
        : (status === "error"
          ? paint.bgRedBright.whiteBright.bold(" FAIL ")
          : paint.bgCyanBright.black.bold(" INFO ")))
      : (status === "success"
        ? "SUCCESS"
        : (status === "error" ? "FAIL" : "INFO"));
    const titleText = colorsEnabled(options)
      ? paint.whiteBright(normalizedTitle)
      : normalizedTitle;
    return `${badge}  ${titleText}`;
  }
  const icon = resolveStatusIcon(status, options);
  return colorizeHeading(`${icon} ${normalizedTitle.toUpperCase()}`, options);
}

function padIcon(icon, width = SECTION_ICON_WIDTH) {
  const displayWidth = stringWidth(icon);
  return `${icon}${" ".repeat(Math.max(0, width - displayWidth))}`;
}

function resolveSectionMeta(title) {
  const normalizedTitle = normalizeText(title);
  return SECTION_META[normalizedTitle] ?? {
    icon: "•",
    label: normalizedTitle.toUpperCase()
  };
}

function renderSectionHeading(title, options = {}) {
  const meta = resolveSectionMeta(title);
  return colorizeHeading(`${padIcon(meta.icon)}  ${meta.label}`, options);
}

function renderRows(rows = [], options = {}) {
  const normalizedRows = rows.filter((row) => row?.label);
  const labelWidth = Math.min(
    DEFAULT_LABEL_WIDTH,
    Math.max(...normalizedRows.map((row) => normalizeText(row.label).length), 0)
  );
  return normalizedRows.flatMap((row) => renderRow(normalizeText(row.label), row.value, labelWidth, options));
}

function renderRow(label, value, labelWidth = 0, options = {}) {
  const lines = normalizeLines(value);
  const paddedLabel = labelWidth > 0 ? `${label}:`.padEnd(labelWidth + 2) : `${label}:`;
  const renderedLabel = colorizeLabel(paddedLabel, options);
  if (lines.length === 0) return [`    ${renderedLabel}`];
  if (lines.length === 1) return [`    ${renderedLabel} ${colorizeContent(lines[0], options)}`];
  return [
    `    ${renderedLabel}`,
    ...lines.map((line) => `      - ${colorizeContent(line, options)}`)
  ];
}

function renderItemPrefix(status = "info", icon = "", options = {}) {
  if (!icon) return resolveStatusIcon(status, options);
  if (icon === "›" || icon === "»") {
    return colorsEnabled(options) ? colorizeAccent(icon, options) : icon;
  }
  return colorizeStatus(icon, status, options);
}

function renderItemLine(item, options = {}, defaultStatus = "", indent = "    ") {
  const status = item?.status || defaultStatus || "info";
  const prefix = renderItemPrefix(status, item?.icon, options);
  return `${indent}${prefix} ${colorizeContent(item?.text, options)}`;
}

function renderItem(item, options = {}, defaultStatus = "", indent = "    ") {
  if (typeof item === "string") {
    const text = normalizeText(item);
    if (!text) return [];
    if (!defaultStatus) return [`${indent}- ${colorizeContent(text, options)}`];
    return [`${indent}${renderItemPrefix(defaultStatus, "", options)} ${colorizeContent(text, options)}`];
  }

  if (item && typeof item === "object" && item.separator) {
    return [""];
  }

  if (item && typeof item === "object" && item.status && item.text) {
    const lines = [renderItemLine(item, options, defaultStatus, indent)];
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        lines.push(...renderItem(child, options, defaultStatus, `${indent}  `).filter(Boolean));
      }
    }
    return lines;
  }

  if (item && typeof item === "object" && item.label) {
    return renderRow(item.label, item.value, 0, options);
  }

  return normalizeLines(item).map((line) => `${indent}- ${colorizeContent(line, options)}`);
}

function renderSection(section, options = {}) {
  const lines = [];
  const title = normalizeText(section?.title);
  if (!title) return lines;

  lines.push(renderSectionHeading(title, options));

  if (Array.isArray(section.rows)) {
    lines.push(...renderRows(section.rows, options));
  }

  if (Array.isArray(section.items)) {
    for (const item of section.items) {
      lines.push(...renderItem(item, options, section.status).filter(Boolean));
    }
  }

  if (Array.isArray(section.lines)) {
    for (const line of section.lines) {
      const normalized = normalizeText(line);
      if (normalized) lines.push(`    ${normalized}`);
    }
  }

  return lines;
}

export function renderReport(report, options = {}) {
  const lines = [];
  const title = normalizeText(report?.title);
  if (!title) return "";

  lines.push("");
  lines.push(renderReportHeading(title, report.status, options));

  if (Array.isArray(report.body)) {
    const bodyLines = report.body.flatMap((item) => renderItem(item, options, report.status).filter(Boolean));
    if (bodyLines.length > 0) {
      lines.push("");
      lines.push(...bodyLines);
    }
  }

  if (report.summary?.length) {
    lines.push("");
    lines.push(...renderSection({
      title: report.summaryTitle || "Overview",
      rows: report.summary
    }, options));
  }

  for (const section of report.sections ?? []) {
    const rendered = renderSection(section, options);
    if (rendered.length === 0) continue;
    lines.push("");
    lines.push(...rendered);
  }

  return lines.join("\n");
}

export function printReport(report, options = {}) {
  const output = renderReport(report, options);
  if (!output) return;
  console.log(output);
}

export function printFatalError(message, options = {}) {
  const title = normalizeText(options.title) || "command could not be completed";
  const output = renderReport({
    status: "error",
    title,
    body: [
      { status: "error", text: normalizeText(message), icon: "✖" }
    ]
  }, {
    ...options,
    stream: process.stderr
  });
  if (!output) return;
  process.stderr.write(`${output}\n`);
}
