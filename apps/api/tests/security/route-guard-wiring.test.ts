/**
 * ST-249: CI gate against two Hono routing footguns that silently drop a mounted middleware.
 *
 * Both were live bugs found by authz-role-matrix.test.ts's fuzz run — every affected
 * `requirePermission()` (and, incidentally, every `auditAction()` and `requireChannel()`) mounted
 * this way was dead code, never once invoked, for every role, on every request. Static, not
 * runtime: the point is to fail a PR the moment either shape is typed again, before it needs a
 * live fuzz run to notice.
 *
 * 1. `routes.use("/path/{param}", ...)`. `{param}` is `@hono/zod-openapi`'s `createRoute({ path })`
 *    syntax; `.openapi()` translates it to Hono's own `:param` internally before registering with
 *    the router, but `.use()` is inherited straight from base Hono and does no such translation.
 *    A curly-brace path handed to `.use()` is therefore never matched by a real request — confirmed
 *    against Hono 4.12.34's router directly, not inferred from this app's behavior alone.
 *
 * 2. `routes.use("/prefix*", ...)` — a wildcard glued directly to its prefix with no separating
 *    slash. This one only breaks once the app is composed with `app.route(mountPath, subApp)`
 *    (which every module in this app is): invoked directly, the glued form matches fine; mounted,
 *    it silently matches nothing. `"/prefix/*"` (slash before the star) has no such gap in either
 *    context — confirmed with both forms against a `.route()`-mounted `OpenAPIHono`, not inferred.
 *
 * Neither is a guess about *why* Hono behaves this way — that's this repo's problem to route
 * around, not a Hono bug report to file — this test only pins the two shapes down as forbidden.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

const SRC_DIR = resolve(import.meta.dir, "../../src");
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /\.d\.ts$/, /__tests__/];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from a readdir of our own src tree
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.endsWith(".ts") && !EXCLUDE_PATTERNS.some((p) => p.test(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

interface UseCall {
  file: string;
  line: number;
  path: string;
}

/** Every `<ident>.use(<string-literal>, ...)` call site's first argument, verbatim. */
function findUseCallPaths(files: string[]): UseCall[] {
  const calls: UseCall[] = [];

  for (const file of files) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from our own src tree
    const source = readFileSync(file, "utf-8");
    const relFile = relative(SRC_DIR, file);

    // Matches `.use(` followed by a single quoted string literal as the first argument. A `.use()`
    // whose first argument is a variable (`routes.use(basePath, ...)`) is out of scope for this
    // static check — read the variable's own definition by hand, the way ST-249's audit did for
    // the handful of cases that existed when this test was written.
    const re = /\b\w+\.use\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const line = source.slice(0, m.index).split("\n").length;
      calls.push({ file: relFile, line, path: m[2]! });
    }
  }

  return calls;
}

describe("route guard wiring — .use() path shape", () => {
  test("no .use() path uses createRoute's {param} syntax (use :param instead)", () => {
    const calls = findUseCallPaths(collectSourceFiles(SRC_DIR));
    const offenders = calls.filter((c) => c.path.includes("{"));

    if (offenders.length > 0) {
      const detail = offenders.map((c) => `  ${c.file}:${c.line}  "${c.path}"`).join("\n");
      throw new Error(
        `.use() call(s) with an OpenAPI-style "{param}" path — Hono's own router never matches ` +
          `this for .use(), so the middleware silently never runs. Use ":param" instead:\n${detail}`,
      );
    }

    expect(offenders).toHaveLength(0);
  });

  test('no .use() path glues a wildcard directly to its prefix (use "prefix/*" instead)', () => {
    const calls = findUseCallPaths(collectSourceFiles(SRC_DIR));
    const offenders = calls.filter(
      (c) => c.path.length > 1 && c.path.endsWith("*") && !c.path.endsWith("/*"),
    );

    if (offenders.length > 0) {
      const detail = offenders.map((c) => `  ${c.file}:${c.line}  "${c.path}"`).join("\n");
      throw new Error(
        `.use() call(s) with a wildcard glued to a non-empty prefix ("prefix*") — this silently ` +
          `matches nothing once the app is composed with app.route(), though it works fine called ` +
          `directly. A bare "*" (matching everything, no prefix) is unaffected and not flagged. ` +
          `Use "prefix/*" instead:\n${detail}`,
      );
    }

    expect(offenders).toHaveLength(0);
  });
});
