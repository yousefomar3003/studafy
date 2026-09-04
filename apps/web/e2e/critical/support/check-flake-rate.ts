#!/usr/bin/env bun
/**
 * Reads the JSON reporter output `playwright.critical.config.ts` writes
 * (`test-results/critical-results.json`) and fails if the flake rate — tests that failed at least
 * once but passed on retry, divided by all tests that ran — is at or above the ST-246 acceptance
 * criterion (<2%). Run as its own CI step *after* `bun run e2e:critical`, not folded into the test
 * run itself, so a red flake-rate gate is a distinct, legible CI failure from a red journey.
 */
export {};

const THRESHOLD = 0.02;

interface JsonReporterOutput {
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
}

const path = process.argv[2] ?? "test-results/critical-results.json";
const file = Bun.file(path);
if (!(await file.exists())) {
  console.error(`${path} does not exist — did the e2e:critical run produce a report?`);
  process.exit(1);
}

const report = (await file.json()) as JsonReporterOutput;
const { expected, unexpected, flaky, skipped } = report.stats;
const total = expected + unexpected + flaky + skipped;

if (total === 0) {
  console.error("no tests ran — nothing to compute a flake rate from");
  process.exit(1);
}

const flakeRate = flaky / total;
console.log(
  `[flake-rate] ${flaky}/${total} tests flaky (${(flakeRate * 100).toFixed(2)}%), ` +
    `${unexpected} failed outright, threshold ${(THRESHOLD * 100).toFixed(0)}%`,
);

if (unexpected > 0) {
  console.error(`${unexpected} test(s) failed outright (not flaky, just red) — see the run above.`);
  process.exit(1);
}

if (flakeRate >= THRESHOLD) {
  console.error(
    `flake rate ${(flakeRate * 100).toFixed(2)}% is at or above the ${(THRESHOLD * 100).toFixed(0)}% budget.`,
  );
  process.exit(1);
}

console.log("flake rate within budget.");
