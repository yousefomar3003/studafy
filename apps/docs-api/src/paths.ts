import path from "node:path";

/**
 * Filesystem layout for the API reference site (ST-269).
 *
 * Mirrors packages/api-client/openapi-typescript.config.ts's OPENAPI_SPEC_PATH: the same gitignored,
 * CI-regenerated `apps/api/openapi.json` is the one source of truth every consumer of the contract
 * reads from disk, never re-derives.
 */

/** Absolute path to the OpenAPI 3.1 document emitted by ST-060's generator. */
export const OPENAPI_SPEC_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "api",
  "openapi.json",
);

/** Default build output directory. DOCS_API_OUT overrides it (see build.ts). */
export const DEFAULT_DIST_DIR = path.resolve(import.meta.dirname, "..", "dist");
