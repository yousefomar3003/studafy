import { renderApiReference } from "@scalar/client-side-rendering";

import type { Guide } from "./content/types";

/**
 * Static HTML rendering for the reference site (ST-269).
 *
 * The operation browser is not hand-built: it calls the exact same `renderApiReference` function
 * `apps/api/src/app.ts`'s `Scalar()` middleware calls for the local, dev-only `/docs` route (see
 * @scalar/hono-api-reference's own `scalar.js`), so the published site and a developer's local
 * `/docs` render identically rather than being two different tools that can drift apart. Everything
 * else (guides, landing page, nav, layout) is plain hand-written HTML — no templating engine, no
 * Markdown parser: four fixed guides and a landing page do not earn either dependency.
 */

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal inline markup: `` `code` ``, `**bold**`, `[text](url)`. Deliberately not Markdown — see
 * the file header. Input is escaped first, so the syntax markers below can never be reintroduced by
 * guide content that happens to contain a literal `<`/`&`.
 */
function renderInline(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, (_m, label: string, url: string) => {
      // url comes from escapeHtml above, so quotes inside it are already &quot; — safe in an
      // attribute without a second pass.
      return `<a href="${url}">${label}</a>`;
    });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-raised: #f6f7f9;
  --fg: #1a1d23;
  --fg-muted: #5b6270;
  --border: #e2e5ea;
  --accent: #2f6feb;
  --code-bg: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --bg-raised: #1c1f26;
    --fg: #e7e9ee;
    --fg-muted: #9aa1ad;
    --border: #2b2f38;
    --accent: #6ea1ff;
    --code-bg: #1e2128;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif;
}
.layout { display: flex; min-height: 100vh; }
nav.sidebar {
  width: 220px;
  flex: none;
  padding: 24px 16px;
  border-right: 1px solid var(--border);
  background: var(--bg-raised);
}
nav.sidebar a {
  display: block;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--fg-muted);
  text-decoration: none;
  font-size: 14px;
}
nav.sidebar a:hover { background: var(--border); color: var(--fg); }
nav.sidebar a.active { color: var(--accent); font-weight: 600; }
nav.sidebar .brand { font-weight: 700; font-size: 15px; margin-bottom: 16px; display: block; color: var(--fg); }
nav.sidebar .version { color: var(--fg-muted); font-size: 12px; margin-top: 24px; }
main {
  flex: 1;
  max-width: 760px;
  padding: 40px 48px 96px;
}
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 40px 0 12px; border-top: 1px solid var(--border); padding-top: 24px; }
.summary { color: var(--fg-muted); font-size: 17px; margin: 0 0 32px; }
p { margin: 0 0 16px; }
code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0 0 16px;
}
pre code { background: none; padding: 0; }
a { color: var(--accent); }
.landing-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin-top: 24px; }
.landing-card {
  display: block;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  text-decoration: none;
  color: var(--fg);
}
.landing-card:hover { border-color: var(--accent); }
.landing-card h3 { margin: 0 0 6px; font-size: 16px; }
.landing-card p { margin: 0; color: var(--fg-muted); font-size: 13px; }
table.error-codes { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
table.error-codes th, table.error-codes td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
table.error-codes th { color: var(--fg-muted); font-weight: 600; }
`;

export interface NavLink {
  href: string;
  label: string;
  active: boolean;
}

function renderNav(links: readonly NavLink[], version: string): string {
  const items = links
    .map(
      (link) =>
        `<a href="${escapeHtml(link.href)}"${link.active ? ' class="active"' : ""}>${escapeHtml(link.label)}</a>`,
    )
    .join("\n");
  return `<nav class="sidebar">
  <a href="./index.html" class="brand">Studafy API</a>
  ${items}
  <div class="version">${escapeHtml(version)}</div>
</nav>`;
}

function layout(title: string, nav: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="layout">
${nav}
<main>
${body}
</main>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Guide pages
// ---------------------------------------------------------------------------

function renderBlockLanguageLabel(language: string): string {
  return language === "http" || language === "bash" ? language : "";
}

function renderGuideBody(guide: Guide): string {
  const sections = guide.sections
    .map((section) => {
      const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : "";
      const paragraphs = section.body.map((p) => `<p>${renderInline(p)}</p>`).join("\n");
      const blocks = (section.blocks ?? [])
        .map((block) => {
          const label = renderBlockLanguageLabel(block.language);
          const labelComment = label ? `# ${label}\n` : "";
          return `<pre><code>${escapeHtml(labelComment)}${escapeHtml(block.code)}</code></pre>`;
        })
        .join("\n");
      return `${heading}\n${paragraphs}\n${blocks}`;
    })
    .join("\n");

  return `<h1>${escapeHtml(guide.title)}</h1>
<p class="summary">${renderInline(guide.summary)}</p>
${sections}`;
}

/** Appended only to the errors guide — see content/errors.ts's header comment. */
export function renderErrorCodeTable(errorCodes: Readonly<Record<string, string>>): string {
  const rows = Object.values(errorCodes)
    .sort()
    .map((code) => `<tr><td><code>${escapeHtml(code)}</code></td></tr>`)
    .join("\n");
  return `<h2>Every error code</h2>
<p>Generated from <code>ERROR_CODES</code> in <code>@studafy/constants</code> — the single source of
truth this table cannot drift from, because it is not hand-copied.</p>
<table class="error-codes"><thead><tr><th>Code</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

export function renderGuidePage(
  guide: Guide,
  navLinks: readonly NavLink[],
  version: string,
  extraBodyHtml = "",
): string {
  const body = renderGuideBody(guide) + extraBodyHtml;
  return layout(`${guide.title} — Studafy API`, renderNav(navLinks, version), body);
}

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

export interface LandingInfo {
  version: string;
  releaseTag: string;
}

export function renderLandingPage(
  guides: readonly Guide[],
  navLinks: readonly NavLink[],
  info: LandingInfo,
): string {
  const cards = guides
    .map(
      (guide) =>
        `<a class="landing-card" href="./${guide.slug}.html"><h3>${escapeHtml(guide.navTitle)}</h3><p>${escapeHtml(guide.summary)}</p></a>`,
    )
    .join("\n");

  const body = `<h1>Studafy API reference</h1>
<p class="summary">Contract version <code>${escapeHtml(info.version)}</code>, built from release
<code>${escapeHtml(info.releaseTag)}</code>.</p>
<p><a href="./operations.html">Browse every endpoint →</a></p>
<div class="landing-grid">
<a class="landing-card" href="./operations.html"><h3>API operations</h3><p>Every endpoint, request, and response schema, generated from the live OpenAPI document.</p></a>
${cards}
</div>`;

  return layout("Studafy API reference", renderNav(navLinks, info.version), body);
}

// ---------------------------------------------------------------------------
// Operation browser (Scalar, reused from apps/api's own /docs — see file header)
// ---------------------------------------------------------------------------

export function renderOperationsPage(): string {
  return renderApiReference({
    pageTitle: "Studafy API",
    config: { url: "./openapi.json" },
  });
}
