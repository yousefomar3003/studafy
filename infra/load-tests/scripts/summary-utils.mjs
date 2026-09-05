// Shared helpers for reading a k6 `--summary-export` JSON file. Node-side tooling only (report
// archiving, regression comparison) — never imported by the k6 scripts themselves, which run in
// k6's own goja runtime and have no access to node:fs.

import { readFileSync } from "node:fs";

/** Load and parse a k6 summary-export JSON file, failing loudly with the path on a bad read. */
export function loadSummary(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read summary at ${path}: ${error.message}`, { cause: error });
  }
  return JSON.parse(raw);
}

/**
 * Metric keys this repo's scenarios actually tag with `{endpoint:...}` or define as custom
 * metrics, in the categories a regression check treats differently. Kept as an explicit allowlist
 * rather than "every metric in the file" — k6's summary JSON also carries built-in metrics
 * (`vus`, `iteration_duration`, `data_sent`, ...) that are not meaningful to threshold-style
 * regression comparison the way a tagged request duration or a failure rate is.
 */
const DURATION_METRIC_PATTERN = /^http_req_(duration|waiting)\{endpoint:[^}]+\}$/;
const RATE_METRIC_LOWER_IS_BETTER = new Set(["http_req_failed", "ai_hard_failure_rate"]);
const RATE_METRIC_HIGHER_IS_BETTER = new Set(["checks"]);

/**
 * Extract the comparable rows from one summary: `{ name, kind, value }[]`, where `kind` is
 * `"p95-ms"` for a duration-shaped metric or `"rate-lower"` / `"rate-higher"` for a rate-shaped
 * one. Metrics absent from a run (e.g. a scenario that adds a new endpoint tag later) are simply
 * not returned — comparison only ever happens over the intersection of two runs' rows.
 */
export function comparableRows(summary) {
  const metrics = summary.metrics || {};
  const rows = [];

  // k6's `--summary-export` JSON (verified against k6 v2.2.0's actual output, not just its docs)
  // puts a Trend metric's stats directly on the metric object — `metric["p(95)"]`, not
  // `metric.values["p(95)"]` — and a Rate metric's fraction as `metric.value` (singular), not
  // `metric.values.rate`. There is no `.values` wrapper at all in this format.
  for (const [name, metric] of Object.entries(metrics)) {
    if (DURATION_METRIC_PATTERN.test(name) && metric["p(95)"] !== undefined) {
      rows.push({ name, kind: "p95-ms", value: metric["p(95)"] });
      continue;
    }
    if (RATE_METRIC_LOWER_IS_BETTER.has(name) && metric.value !== undefined) {
      rows.push({ name, kind: "rate-lower", value: metric.value });
      continue;
    }
    if (RATE_METRIC_HIGHER_IS_BETTER.has(name) && metric.value !== undefined) {
      rows.push({ name, kind: "rate-higher", value: metric.value });
    }
  }

  return rows;
}

/** Render a short Markdown table of the comparable rows, for the archived human-readable report. */
export function renderMarkdownSummary(scenario, metadata, summary) {
  const rows = comparableRows(summary);
  const lines = [
    `# Load test report — ${scenario}`,
    "",
    `- Run at: ${metadata.ranAtUtc}`,
    `- Target: ${metadata.targetEnv}${metadata.baseUrl ? ` (${metadata.baseUrl})` : ""}`,
    `- Git commit: ${metadata.gitSha}`,
    `- k6 exit code: ${metadata.k6ExitCode}`,
    "",
    "| Metric | Kind | Value |",
    "| --- | --- | --- |",
  ];
  for (const row of rows) {
    const formatted =
      row.kind === "p95-ms" ? `${row.value.toFixed(1)} ms` : `${(row.value * 100).toFixed(2)}%`;
    lines.push(`| \`${row.name}\` | ${row.kind} | ${formatted} |`);
  }
  lines.push(
    "",
    "Thresholds themselves (pass/fail) are k6's own exit code — see the raw `summary.json` " +
      "in this same directory for the full per-metric threshold detail.",
  );
  return lines.join("\n");
}
