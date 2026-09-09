import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ERROR_CODES } from "@studafy/constants";

import { guides } from "./content";
import { DEFAULT_DIST_DIR, OPENAPI_SPEC_PATH } from "./paths";
import {
  renderErrorCodeTable,
  renderGuidePage,
  renderLandingPage,
  renderOperationsPage,
} from "./render";
import { formatIssues, validateGuides } from "./validate";

import type { NavLink } from "./render";
import type { OpenApiPathsDocument } from "./validate";

/**
 * Builds the static API reference site (ST-269): the landing page, one page per guide, the
 * generated operation browser, and a versioned copy of the OpenAPI document itself.
 *
 * `bun run --cwd apps/docs-api build` (or `bun run docs:api:build` from the repo root). Requires
 * `apps/api/openapi.json` to already exist — `bun run openapi:generate` first, same precondition
 * `packages/api-client`'s codegen has.
 *
 * DOCS_API_OUT overrides the output directory. DOCS_API_RELEASE_TAG names the release this build
 * belongs to (the deploy workflows pass the image tag they are shipping); it defaults to "local"
 * for a plain developer build, which is never a value a real deploy would pass.
 */

interface OpenApiInfo {
  info?: { version?: string; title?: string };
}

async function loadSpec(): Promise<OpenApiPathsDocument & OpenApiInfo> {
  let raw: string;
  try {
    raw = await readFile(OPENAPI_SPEC_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ${OPENAPI_SPEC_PATH}. Run \`bun run openapi:generate\` first.`,
      {
        cause: error,
      },
    );
  }
  return JSON.parse(raw) as OpenApiPathsDocument & OpenApiInfo;
}

function buildNav(activeSlug: string): NavLink[] {
  const guideLinks: NavLink[] = guides.map((guide) => ({
    href: `./${guide.slug}.html`,
    label: guide.navTitle,
    active: guide.slug === activeSlug,
  }));
  return [
    { href: "./operations.html", label: "API operations", active: activeSlug === "operations" },
    ...guideLinks,
  ];
}

export async function build(distDir: string = DEFAULT_DIST_DIR): Promise<void> {
  const spec = await loadSpec();

  const issues = validateGuides(guides, spec, Object.values(ERROR_CODES));
  if (issues.length > 0) {
    throw new Error(
      `${issues.length} guide example(s) do not match apps/api/openapi.json or ERROR_CODES:\n` +
        formatIssues(issues),
    );
  }

  const version = spec.info?.version ?? "0.0.0";
  const releaseTag = process.env.DOCS_API_RELEASE_TAG ?? "local";

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  await writeFile(path.join(distDir, "openapi.json"), JSON.stringify(spec, null, 2));

  await writeFile(
    path.join(distDir, "index.html"),
    renderLandingPage(guides, buildNav("index"), { version, releaseTag }),
  );

  await writeFile(path.join(distDir, "operations.html"), renderOperationsPage());

  for (const guide of guides) {
    const extra = guide.slug === "errors" ? renderErrorCodeTable(ERROR_CODES) : "";
    await writeFile(
      path.join(distDir, `${guide.slug}.html`),
      renderGuidePage(guide, buildNav(guide.slug), version, extra),
    );
  }

  console.log(
    `docs-api: built ${guides.length + 2} pages for contract version ${version} (release ${releaseTag}) into ${distDir}`,
  );
}

if (import.meta.main) {
  const distDir = process.env.DOCS_API_OUT ?? DEFAULT_DIST_DIR;
  await build(distDir);
}
