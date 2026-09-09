import type { Guide } from "./content/types";

/**
 * The one shape this module reads off a parsed openapi.json: a map of path template to a map of
 * lowercase HTTP method. Not the full OpenAPI 3.1 type — nothing here needs more than "does this
 * method+path exist" — so no OpenAPI schema package is pulled in just to answer that.
 */
export interface OpenApiPathsDocument {
  paths: Record<string, Record<string, unknown>>;
}

export interface ValidationIssue {
  guideSlug: string;
  sectionHeading: string;
  message: string;
}

/**
 * Checks every guide's structured example metadata against the live contract (ST-269's "examples
 * validated against spec in CI" acceptance criterion).
 *
 * Two independent checks, run over every `CodeBlock` in every guide:
 *   1. `block.api` with `documented: true` — the method+path must exist in openapi.json.
 *   2. `block.errorCodes` — every code named must be a real member of ERROR_CODES.
 *
 * Returns every issue found rather than throwing on the first one, so a CI failure lists everything
 * wrong in one run instead of one fix-and-rerun cycle per issue.
 */
export function validateGuides(
  guides: readonly Guide[],
  spec: OpenApiPathsDocument,
  errorCodes: readonly string[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const knownCodes = new Set(errorCodes);

  for (const guide of guides) {
    for (const section of guide.sections) {
      for (const block of section.blocks ?? []) {
        if (block.api?.documented) {
          const { method, path } = block.api;
          const operations = spec.paths[path];
          if (!operations || !(method.toLowerCase() in operations)) {
            issues.push({
              guideSlug: guide.slug,
              sectionHeading: section.heading,
              message: `${method} ${path} is not in apps/api/openapi.json`,
            });
          }
        }

        for (const code of block.errorCodes ?? []) {
          if (!knownCodes.has(code)) {
            issues.push({
              guideSlug: guide.slug,
              sectionHeading: section.heading,
              message: `error code "${code}" is not a member of ERROR_CODES`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/** Formats issues for a CI log — one line each, guide/section-prefixed so a failure is greppable. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map(
      (issue) => `[${issue.guideSlug} § ${issue.sectionHeading || "(untitled)"}] ${issue.message}`,
    )
    .join("\n");
}
