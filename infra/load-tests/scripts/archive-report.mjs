#!/usr/bin/env bun
// Archives one k6 run's summary as a durable report artifact: "report artifact archived" (ST-248's
// acceptance criteria). Copies the summary JSON `run.sh` produced into a timestamped directory under
// reports/<scenario>/, alongside a metadata.json (git commit, target, exit code) and a small
// human-readable report.md rendered from the same data — so a reviewer can open one file instead of
// grepping raw k6 JSON.
//
// Usage: bun scripts/archive-report.mjs <scenario> <path-to-summary.json> <k6-exit-code>

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSummary, renderMarkdownSummary } from "./summary-utils.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTS_ROOT = join(SCRIPT_DIR, "..", "reports");

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const [scenario, summaryPath, exitCodeArg] = process.argv.slice(2);
  if (!scenario || !summaryPath) {
    console.error("usage: archive-report.mjs <scenario> <path-to-summary.json> [k6-exit-code]");
    return 2;
  }

  const summary = loadSummary(summaryPath);
  const outDir = join(REPORTS_ROOT, scenario, timestamp());
  mkdirSync(outDir, { recursive: true });

  copyFileSync(summaryPath, join(outDir, "summary.json"));

  const metadata = {
    scenario,
    ranAtUtc: new Date().toISOString(),
    gitSha: gitSha(),
    targetEnv: process.env.TARGET_ENV || "local",
    baseUrl: process.env.BASE_URL || null,
    k6ExitCode: exitCodeArg !== undefined ? Number(exitCodeArg) : null,
  };
  writeFileSync(join(outDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdownSummary(scenario, metadata, summary));

  console.log(`[${scenario}] Archived report to ${outDir}`);
  return 0;
}

process.exitCode = await main();
