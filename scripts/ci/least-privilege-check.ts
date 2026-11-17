/**
 * QA-003: compare a least-privilege test run against the known QA-014 work list.
 *
 *   bun scripts/ci/least-privilege-check.ts <known-failures.txt> <junit.xml> [<junit.xml> ...]
 *
 * The API suites run with the app logged in as studafy_runtime (NOSUPERUSER, NOBYPASSRLS, owns
 * nothing). Tests that fail only there are code paths that silently relied on the production login
 * bypassing RLS -- QA-014's fix list, kept in apps/api/tests/least-privilege-known-failures.txt as
 * one "file > suite > test" per line. This exits non-zero when:
 *   - a test fails that is not on the list (a new dependency on RLS bypass), or
 *   - a listed test now passes (fixed: delete its line, so the list only ever shrinks).
 * A line ending in "# flaky" is tolerated either way (it is also intermittent without the role).
 */
import { readFileSync } from "node:fs";

const [knownPath, ...junitPaths] = process.argv.slice(2);
if (!knownPath || junitPaths.length === 0) {
  console.error("usage: least-privilege-check.ts <known-failures.txt> <junit.xml>...");
  process.exit(2);
}

const known = new Map<string, { flaky: boolean }>();
for (const raw of readFileSync(knownPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const flaky = /#\s*flaky\b/.test(line);
  known.set(line.replace(/\s+#.*$/, "").trim(), { flaky });
}

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

const failed = new Set<string>();
const passed = new Set<string>();
for (const path of junitPaths) {
  const xml = readFileSync(path, "utf8");
  // <testcase ... /> (passed or skipped) or <testcase ...> ... </testcase> (may hold <failure>).
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(re)) {
    const attrs = match[1]!;
    const attr = (name: string) =>
      decode(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? "");
    const key = `${attr("file")} > ${attr("classname")} > ${attr("name")}`;
    const inner = match[3] ?? "";
    if (/<failure\b/.test(inner)) failed.add(key);
    else if (!/<skipped\b/.test(inner)) passed.add(key);
  }
}

const unexpected = [...failed].filter((key) => !known.has(key));
const fixed = [...known].filter(([key, { flaky }]) => !flaky && passed.has(key)).map(([k]) => k);

console.log(
  `least-privilege run: ${failed.size} failed, ${passed.size} passed; ` +
    `${known.size} known (QA-014 work list)`,
);
if (unexpected.length > 0) {
  console.error(
    `\n${unexpected.length} NEW failure(s) under the least-privilege login. Code now depends on ` +
      "the database login bypassing RLS or owning tables; route it through withTenantTx / " +
      "withSystemTx instead:\n  " +
      unexpected.join("\n  "),
  );
}
if (fixed.length > 0) {
  console.error(
    `\n${fixed.length} known failure(s) now pass. Delete them from ${knownPath}:\n  ` +
      fixed.join("\n  "),
  );
}
process.exit(unexpected.length > 0 || fixed.length > 0 ? 1 : 0);
