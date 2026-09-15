#!/usr/bin/env bun
/**
 * The web performance budget CI enforces — the "regression fails CI" half of ST-285. Timing budgets
 * (marketing LCP, app-shell TTI) live in `lighthouserc.json` and run under Lighthouse; this script
 * gates the two things a browser measurement cannot, deterministically and on every build:
 *
 * 1. **Initial portal JS < 300 KB gzip** — the acceptance criterion's byte ceiling. It reads the
 *    built `dist/index.html`, takes every script it actually requests on first paint (the entry
 *    chunk plus Vite's module-preloaded shared chunks), adds the lazily-loaded `PortalPage`
 *    chunk — the only portal-specific delta over that entry graph — and sums their gzip sizes.
 *
 *    Why this is an honest measurement of "initial portal JS": the whole portal shell
 *    (`PortalLayout`, sidebar, search palette, notification bell, auth, realtime, react-query,
 *    i18n) lives in the static entry graph that `main.tsx` pulls in for every route; `/auth/login`
 *    and `/portal/home` share it verbatim. Lighthouse asserts TTI on that shared shell
 *    (`lighthouserc.json`); this byte gate covers the shell plus what the portal home alone adds.
 *
 *    Gzip rather than raw bytes, because that is what the acceptance writes ("<300KB gzip") and
 *    what nginx serves (`gzip on`, infra/docker/web/nginx.conf). Lighthouse's `transferSize` on an
 *    uncompressed static server is raw bytes, so it cannot enforce this number — that is why the
 *    two enforcement mechanisms are split the way they are.
 *
 * 2. **Help-media images are small WebP** — the help center's onboarding screenshots must stay
 *    lossy WebP (q80, see docs/help/README.md) within a total budget. A regenerated `.png` or a
 *    bloated screenshot fails here. Screenshots are the only raster assets in this app, so this one
 *    directory is the entire image budget.
 *
 * Run it after `vite build` (`bun run perf:bundle` in apps/web). It needs nothing but `dist/` and
 * `public/`, so it runs as fast locally as it does in `.github/workflows/web-performance.yml`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST_DIR = "dist";
const ASSETS_DIR = join(DIST_DIR, "assets");
const INDEX_HTML = join(DIST_DIR, "index.html");
const MEDIA_DIR = "public/help-media";

/** Initial portal JS ceiling in bytes (gzip). Acceptance criterion: <300KB. */
const INITIAL_JS_GZIP_BUDGET_BYTES = 300 * 1024;
/** Total help-media weight ceiling in bytes (lossy WebP screenshots). */
const MEDIA_TOTAL_BUDGET_BYTES = 240 * 1024;
/** Per-file ceiling for a help-media screenshot. */
const MEDIA_PER_FILE_BUDGET_BYTES = 60 * 1024;

interface Violation {
  readonly message: string;
}

function assetHrefsFromIndexHtml(): string[] {
  let html: string;
  try {
    html = readFileSync(INDEX_HTML, "utf8");
  } catch {
    throw new Error(
      `${INDEX_HTML} not found — run ${"`bun run build`"} before ${"`bun run perf:bundle`"}.`,
    );
  }

  const hrefs: string[] = [];
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)) {
    hrefs.push(match[1]);
  }
  return hrefs;
}

function gzipBytes(filePath: string): number {
  return gzipSync(readFileSync(filePath)).length;
}

function fail(violations: readonly Violation[]): never {
  const lines = [
    "Performance budget exceeded:",
    ...violations.map((violation) => `  - ${violation.message}`),
    "",
    "Tighten the change (e.g. keep heavy dependencies out of the entry graph, compress help-media",
    "assets back to quality-80 WebP) — see apps/web/README.md and docs/help/README.md.",
  ];
  throw new Error(lines.join("\n"));
}

/**
 * The portal home's initial JS: every script the entry HTML requests, plus the lazy `PortalPage`
 * route chunk. The shared-shell set is enumerated from `index.html` (script + modulepreload), so
 * a regression that grows any entry dependency is caught by name; the portal-only delta is globbed
 * by its stable route-chunk prefix.
 */
function gzipBytesForPortalShell(): { readonly totalBytes: number; readonly items: string[] } {
  const names = assetHrefsFromIndexHtml()
    .map((href) => href.replace(/^\/assets\//, ""))
    .concat(readdirSync(ASSETS_DIR).filter((name) => /^PortalPage-.*\.js$/.test(name)));

  const items: string[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const filePath = join(ASSETS_DIR, name);
    if (!filePath.endsWith(".js")) {
      continue;
    }
    const bytes = gzipBytes(filePath);
    items.push(`${name}: ${(bytes / 1024).toFixed(1)} KB gzip`);
    totalBytes += bytes;
  }
  return { totalBytes, items };
}

function mediaViolations(): readonly Violation[] {
  const violations: Violation[] = [];
  const files = readdirSync(MEDIA_DIR, { recursive: true, encoding: "utf8" }).filter((name) =>
    statSync(join(MEDIA_DIR, name)).isFile(),
  );

  for (const name of files) {
    if (/\.webp$/.test(name)) {
      const size = statSync(join(MEDIA_DIR, name)).size;
      if (size > MEDIA_PER_FILE_BUDGET_BYTES) {
        violations.push({
          message: `${name} is ${Math.round(size / 1024)} KB — over the ${Math.round(
            MEDIA_PER_FILE_BUDGET_BYTES / 1024,
          )} KB per-file budget (quality-80 WebP screenshots).`,
        });
      }
    } else if (/\.[a-zA-Z0-9]+$/.test(name) && !name.endsWith(".map")) {
      violations.push({
        message: `${name} is not WebP — help-media assets must be lossy WebP (q80), not PNG/JPEG.`,
      });
    }
  }

  const totalBytes = files
    .filter((name) => /\.webp$/.test(name))
    .reduce((sum, name) => sum + statSync(join(MEDIA_DIR, name)).size, 0);
  if (totalBytes > MEDIA_TOTAL_BUDGET_BYTES) {
    violations.push({
      message: `help-media totals ${Math.round(totalBytes / 1024)} KB — over the ${Math.round(
        MEDIA_TOTAL_BUDGET_BYTES / 1024,
      )} KB budget.`,
    });
  }

  return violations;
}

const { totalBytes, items } = gzipBytesForPortalShell();
const violations: Violation[] = [];

if (totalBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  violations.push({
    message: `initial portal JS is ${Math.round(totalBytes / 1024)} KB gzip — over the ${Math.round(
      INITIAL_JS_GZIP_BUDGET_BYTES / 1024,
    )} KB budget (${totalBytes} bytes).`,
  });
}

violations.push(...mediaViolations());

console.log(
  `Initial portal JS: ${(totalBytes / 1024).toFixed(1)} KB gzip (${items.length} chunks)`,
);
for (const item of items) {
  console.log(`  ${item}`);
}

if (violations.length > 0) {
  fail(violations);
}

console.log("Help-media assets: within budget.");
console.log("Performance budget: PASS.");
