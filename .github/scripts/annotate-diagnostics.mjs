#!/usr/bin/env bun
// Reads `turbo run lint check-types ... --log-order=grouped` output from stdin, echoes it
// unchanged, and additionally emits GitHub `::error`/`::warning` workflow commands for each
// ESLint and tsc diagnostic so failures annotate the exact file/line on the PR diff.
//
// Why not a GitHub problem matcher: matchers apply a single regex to raw lines and can't
// translate a path. tsc and ESLint both report paths relative to the *task's* cwd (the package
// directory turbo runs the script in), not the repo root GitHub annotations need. This script
// resolves that translation from each package's own directory, which --log-order=grouped makes
// safe to do with a small per-task "current file" cursor instead of a full parser.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const repoRoot = process.cwd();

function discoverPackageDirs() {
  const dirs = [];
  for (const group of ["apps", "packages"]) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(group, entry.name));
    }
  }
  return dirs;
}

const packageDirByName = new Map();
for (const dir of discoverPackageDirs()) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (name) packageDirByName.set(name, dir.split("\\").join("/"));
}

// Matches turbo's per-line log prefix, e.g. "@studafy/api:check-types: " or the failure banner
// "@studafy/api#check-types:  ERROR ...".
const TASK_PREFIX = /^([^:#]+)[:#]([a-zA-Z-]+): ?(.*)$/;
const TSC_DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const ESLINT_FINDING = /^ {2}(\d+):(\d+)\s+(error|warning)\s+(.*?)\s{2,}(\S+)$/;

// GitHub workflow-command escaping for the `::message::` payload (properties never carry a
// comma or newline here, so only the free-text message needs it).
function escapeMessage(message) {
  return message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function toRepoRelative(pathLike) {
  const absolute = isAbsolute(pathLike) ? pathLike : join(repoRoot, pathLike);
  return relative(repoRoot, absolute).split("\\").join("/");
}

// One "current file" per task, since --log-order=grouped keeps each task's lines contiguous but
// several tasks' groups still appear one after another in the same stream.
const currentEslintFile = new Map();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  process.stdout.write(line + "\n");

  const match = line.match(TASK_PREFIX);
  if (!match) return;
  const [, packageName, task, rest] = match;
  const packageDir = packageDirByName.get(packageName);
  if (!packageDir) return;

  if (task === "check-types") {
    const diagnostic = rest.match(TSC_DIAGNOSTIC);
    if (!diagnostic) return;
    const [, file, ln, col, code, message] = diagnostic;
    const relPath = `${packageDir}/${file}`.split("\\").join("/");
    console.log(
      `::error file=${relPath},line=${ln},col=${col},title=${code}::${escapeMessage(message)}`,
    );
    return;
  }

  if (task === "lint") {
    const finding = rest.match(ESLINT_FINDING);
    if (finding) {
      const [, ln, col, severity, message, rule] = finding;
      const file = currentEslintFile.get(packageName);
      if (file) {
        console.log(
          `::${severity} file=${file},line=${ln},col=${col},title=${rule}::${escapeMessage(message.trim())}`,
        );
      }
      return;
    }
    const trimmed = rest.trim();
    // Everything ESLint's stylish reporter prints besides a finding line or a file header is
    // either the command echo, a blank line, or the trailing "X problems (...)" summary.
    if (trimmed === "" || trimmed.startsWith("$") || trimmed.startsWith("✖")) return;
    currentEslintFile.set(packageName, toRepoRelative(trimmed));
  }
});
