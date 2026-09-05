#!/usr/bin/env bun
// Automated regression comparison: "regression comparison to last run automated" (ST-248's
// acceptance criteria). Compares a freshly finished run's summary against the most recently
// archived run for the same scenario (reports/<scenario>/<timestamp>/summary.json, timestamps sort
// lexicographically because they're ISO-8601) and exits non-zero if anything got meaningfully
// worse.
//
// Usage: bun scripts/compare-regression.mjs <scenario> <path-to-new-summary.json>
//
// Deliberately not "diff against a hardcoded target" — that's what config/thresholds.js's NFR
// thresholds are for, and k6 already enforces those itself (non-zero exit on a threshold breach).
// This script answers a different question: "did this run get worse than the last one", which
// matters even when both runs are comfortably inside the NFR budget — a p95 that crept from 200ms
// to 750ms against an 800ms threshold is a real regression a threshold alone would never catch.

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSummary, comparableRows } from "./summary-utils.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTS_ROOT = join(SCRIPT_DIR, "..", "reports");

const LATENCY_TOLERANCE = Number(process.env.REGRESSION_LATENCY_TOLERANCE || 0.2); // +20% p95
const LATENCY_FLOOR_MS = Number(process.env.REGRESSION_LATENCY_FLOOR_MS || 20); // ignore noise below this
const RATE_TOLERANCE = Number(process.env.REGRESSION_RATE_TOLERANCE || 0.02); // +2 percentage points

function findPreviousRunDir(scenario) {
  const scenarioDir = join(REPORTS_ROOT, scenario);
  if (!existsSync(scenarioDir)) return null;
  const dirs = readdirSync(scenarioDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.length > 0 ? join(scenarioDir, dirs[dirs.length - 1], "summary.json") : null;
}

function compare(oldSummary, newSummary) {
  const oldRows = new Map(comparableRows(oldSummary).map((r) => [r.name, r]));
  const newRows = comparableRows(newSummary);
  const regressions = [];
  const comparisons = [];

  for (const row of newRows) {
    const previous = oldRows.get(row.name);
    if (!previous) continue; // new metric this run added — nothing to regress against yet.

    let regressed;
    if (row.kind === "p95-ms") {
      const allowedMax = Math.max(
        previous.value * (1 + LATENCY_TOLERANCE),
        previous.value + LATENCY_FLOOR_MS,
      );
      regressed = row.value > allowedMax;
    } else if (row.kind === "rate-lower") {
      regressed = row.value - previous.value > RATE_TOLERANCE;
    } else {
      // rate-higher
      regressed = previous.value - row.value > RATE_TOLERANCE;
    }

    comparisons.push({
      name: row.name,
      kind: row.kind,
      previous: previous.value,
      current: row.value,
      regressed,
    });
    if (regressed) regressions.push(row.name);
  }

  return { comparisons, regressions };
}

function formatValue(kind, value) {
  return kind === "p95-ms" ? `${value.toFixed(1)}ms` : `${(value * 100).toFixed(2)}%`;
}

async function main() {
  const [scenario, newSummaryPath] = process.argv.slice(2);
  if (!scenario || !newSummaryPath) {
    console.error("usage: compare-regression.mjs <scenario> <path-to-new-summary.json>");
    return 2;
  }

  const newSummary = loadSummary(newSummaryPath);
  const previousPath = findPreviousRunDir(scenario);

  if (!previousPath) {
    console.log(`[${scenario}] No previously archived run found — this run becomes the baseline.`);
    return 0;
  }

  const oldSummary = loadSummary(previousPath);
  const { comparisons, regressions } = compare(oldSummary, newSummary);

  console.log(`[${scenario}] Regression comparison against ${previousPath}:`);
  for (const c of comparisons) {
    const marker = c.regressed ? "REGRESSED" : "ok";
    console.log(
      `  ${marker.padEnd(9)} ${c.name}: ${formatValue(c.kind, c.previous)} -> ${formatValue(c.kind, c.current)}`,
    );
  }

  if (regressions.length === 0) {
    console.log(`[${scenario}] No regressions detected.`);
    return 0;
  }

  console.error(
    `[${scenario}] ${regressions.length} metric(s) regressed beyond tolerance ` +
      `(latency +${LATENCY_TOLERANCE * 100}%, rate +${RATE_TOLERANCE * 100}pp): ${regressions.join(", ")}`,
  );
  return 1;
}

process.exitCode = await main();
