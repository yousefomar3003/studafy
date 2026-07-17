/**
 * CI gate: every mutating route must declare an audit action.
 *
 * This test scans source files under src/ for Hono mutating route registrations
 * (routes.post, routes.put, routes.patch, routes.delete) and verifies each is
 * accompanied by an auditAction() call. A missing declaration means an un-audited
 * mutation could ship to production, which violates SAD section 15.
 *
 * Health endpoints are excluded -- they are GET-only and carry no mutation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../src");

// Files matching these patterns are excluded from the scan.
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /__tests__/];

// Mutating HTTP methods that require audit coverage.
const MUTATING_METHODS = ["post", "put", "patch", "delete"] as const;

// Patterns that explicitly exempt a route from audit coverage (e.g. health endpoints).
const EXEMPT_ROUTES = ["/healthz", "/readyz"];

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.endsWith(".ts") && !EXCLUDE_PATTERNS.some((p) => p.test(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

interface MutatingRoute {
  file: string;
  line: number;
  method: string;
  path: string;
  hasAuditAction: boolean;
}

function findMutatingRoutes(files: string[]): MutatingRoute[] {
  const routes: MutatingRoute[] = [];
  const methods = MUTATING_METHODS.join("|");
  const methodPattern = new RegExp(
    "routes\\.(" + methods + ")\\s*\\(\\s*[\"'`]" + "(/[^\"'`]+)" + "[\"'`]",
    "g",
  );

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relFile = relative(SRC_DIR, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = methodPattern.exec(line);
      if (!match) continue;

      const method = match[1].toUpperCase();
      const path = match[2];

      if (EXEMPT_ROUTES.includes(path)) continue;

      // Look for auditAction( within 15 lines before or after the route registration.
      const windowStart = Math.max(0, i - 15);
      const windowEnd = Math.min(lines.length - 1, i + 15);
      const window = lines.slice(windowStart, windowEnd + 1).join("\n");
      const hasAuditAction = /\bauditAction\s*\(/.test(window);

      routes.push({
        file: relFile,
        line: i + 1,
        method,
        path,
        hasAuditAction,
      });
    }
  }

  return routes;
}

describe("audit route coverage", () => {
  test("every mutating route has a declared audit action", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    const uncovered = routes.filter((r) => !r.hasAuditAction);

    if (uncovered.length > 0) {
      const detail = uncovered
        .map((r) => `  ${r.file}:${r.line}  ${r.method} ${r.path}`)
        .join("\n");
      throw new Error(
        `Mutating routes without auditAction():\n${detail}\n\n` +
          "Every mutating route must declare auditAction(action, table) as middleware.\n" +
          "See apps/api/src/middleware/auditEmitter.ts for the decorator API.",
      );
    }

    expect(uncovered).toHaveLength(0);
  });

  test("at least one mutating route exists (guard against empty scan)", () => {
    const files = collectSourceFiles(SRC_DIR);
    const routes = findMutatingRoutes(files);

    expect(routes.length).toBeGreaterThan(0);
  });
});
