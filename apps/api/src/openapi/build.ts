#!/usr/bin/env bun

/**
 * Build script to generate the OpenAPI 3.1.0 specification from route definitions.
 *
 * Creates a minimal app instance (no Redis/DB required), extracts the spec from
 * the OpenAPI registry, and writes it to `apps/api/openapi.json`.
 *
 * Usage:
 *   bun run src/openapi/build.ts            # generate spec
 *   bun run src/openapi/build.ts --check    # check spec matches committed version (CI)
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { createApp } from "../app";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { ensureProblemDetails, OPENAPI_CONFIG } from "./registry";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "..", "..", "openapi.json");

// ---------------------------------------------------------------------------
// Minimal dependencies for spec generation — no Redis, no database, no logging.
// ---------------------------------------------------------------------------

const silentLogger = createLogger({ destination: () => undefined });
const tracker = createInflightTracker();

const app = createApp({
  isReady: async () => true,
  tracker,
  logger: silentLogger,
});

// ---------------------------------------------------------------------------
// Extract and write the spec
// ---------------------------------------------------------------------------

const spec = app.getOpenAPI31Document({
  openapi: OPENAPI_CONFIG.openapi,
  info: OPENAPI_CONFIG.info,
  servers: OPENAPI_CONFIG.servers,
});

// Ensure ProblemDetails is always in the spec. It may not appear if no route
// currently references it (e.g. when the API has zero domain routes yet).
ensureProblemDetails(spec);

const json = JSON.stringify(spec, null, 2) + "\n";

// --check mode: used in CI to verify the committed spec is up to date.
if (process.argv.includes("--check")) {
  if (!existsSync(SPEC_PATH)) {
    console.error("openapi.json does not exist. Run 'bun run openapi:build' to generate it.");
    process.exit(1);
  }

  const committed = readFileSync(SPEC_PATH, "utf-8");
  if (committed !== json) {
    console.error(
      "openapi.json is out of date. Run 'bun run openapi:build' and commit the result.",
    );
    process.exit(1);
  }

  console.log("openapi.json is up to date.");
  process.exit(0);
}

writeFileSync(SPEC_PATH, json);
console.log(`Wrote ${SPEC_PATH} (${(Buffer.byteLength(json) / 1024).toFixed(1)} KB)`);
