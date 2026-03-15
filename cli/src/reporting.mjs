const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
};

const STATUS_META = {
  success: { label: "OK", color: ANSI.green },
  warning: { label: "WARN", color: ANSI.yellow },
  error: { label: "FAIL", color: ANSI.red },
  info: { label: "INFO", color: ANSI.cyan }
};

function useColor(stream = process.stdout) {
  return Boolean(stream?.isTTY) && !("NO_COLOR" in process.env);
}

function colorize(text, color, enabled, modifiers = []) {
  if (!enabled) return text;
  return `${modifiers.join("")}${color}${text}${ANSI.reset}`;
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
  const meta = STATUS_META[status] ?? STATUS_META.info;
  const enabled = options.color ?? useColor(options.stream);
  return colorize(`[${meta.label}]`, meta.color, enabled, [ANSI.bold]);
}

function renderRow(label, value) {
  const lines = normalizeLines(value);
  if (lines.length === 0) return [`  ${label}:`];
  if (lines.length === 1) return [`  ${label}: ${lines[0]}`];
  return [
    `  ${label}:`,
    ...lines.map((line) => `    - ${line}`)
  ];
}

function renderItem(item, options = {}) {
  if (typeof item === "string") {
    return [`  - ${normalizeText(item)}`];
  }

  if (item && typeof item === "object" && item.status && item.text) {
    return [`  ${renderStatusMarker(item.status, options)} ${normalizeText(item.text)}`];
  }

  if (item && typeof item === "object" && item.label) {
    return renderRow(item.label, item.value);
  }

  return normalizeLines(item).map((line) => `  - ${line}`);
}

function renderSection(section, options = {}) {
  const lines = [];
  const title = normalizeText(section?.title);
  if (!title) return lines;

  const heading = section.status
    ? `${renderStatusMarker(section.status, options)} ${title}`
    : title;
  lines.push(heading);

  if (Array.isArray(section.rows)) {
    for (const row of section.rows) {
      if (!row?.label) continue;
      lines.push(...renderRow(normalizeText(row.label), row.value));
    }
  }

  if (Array.isArray(section.items)) {
    for (const item of section.items) {
      lines.push(...renderItem(item, options).filter(Boolean));
    }
  }

  if (Array.isArray(section.lines)) {
    for (const line of section.lines) {
      const normalized = normalizeText(line);
      if (normalized) lines.push(`  ${normalized}`);
    }
  }

  return lines;
}

export function renderReport(report, options = {}) {
  const lines = [];
  const title = normalizeText(report?.title);
  if (!title) return "";

  lines.push(`${renderStatusMarker(report.status, options)} ${title}`);

  if (report.summary?.length) {
    lines.push("");
    lines.push(...renderSection({ title: "Summary", rows: report.summary }, options));
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
  const output = renderReport({
    status: "error",
    title: "Command failed",
    sections: [
      {
        title: "Details",
        status: "error",
        items: [normalizeText(message)]
      }
    ]
  }, {
    ...options,
    stream: process.stderr
  });
  if (!output) return;
  process.stderr.write(`${output}\n`);
}
