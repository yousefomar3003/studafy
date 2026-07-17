import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";

import { OPENAPI_DOCUMENT_CONFIG } from "./config";

/**
 * Build the OpenAPI document from the routes createApp actually mounts (ST-060).
 *
 * It builds the real app rather than a parallel registry, and that is the whole point: the document
 * is a projection of the server, so it cannot describe a route that does not exist or miss one that
 * does. Nothing is served — createApp binds no port, and getOpenAPI31Document only reads the
 * registry that route registration already populated.
 *
 * The database is a poisoned placeholder rather than null. createApp mounts the ERPNext webhook only
 * `if (database)`, so null would silently emit a document missing a real endpoint, while a real
 * client would open a connection just to enumerate routes. See src/db/unusable.ts.
 */
export function buildOpenApiDocument() {
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    // Registration touches no logger, but createApp requires one rather than defaulting so that a
    // default could never write real NDJSON to a caller's stdout. Discard whatever it would emit.
    logger: createLogger({ destination: () => undefined }),
    // No rate limiter: a middleware's presence does not change the document, and a Redis client
    // would be one more connection opened to draw a picture.
    redis: null,
    database: createUnusableDatabase(),
    // /docs and /openapi.json are tooling for reading the API, not part of the API's contract.
    docsEnabled: false,
  });

  return app.getOpenAPI31Document(OPENAPI_DOCUMENT_CONFIG);
}
