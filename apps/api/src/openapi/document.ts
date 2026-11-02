import { createApp } from "../app";
import { createUnusableDatabase } from "../db/unusable";
import { createInflightTracker } from "../lifecycle";
import { createLogger } from "../logger";
import { KeyStore } from "../modules/auth";
import { createUnusableRedis } from "../redis-unusable";

import { OPENAPI_DOCUMENT_CONFIG } from "./config";

/**
 * Build the OpenAPI document from the routes createApp actually mounts (ST-060).
 *
 * It builds the real app rather than a parallel registry, and that is the whole point: the document
 * is a projection of the server, so it cannot describe a route that does not exist or miss one that
 * does. Nothing is served — createApp binds no port, and getOpenAPI31Document only reads the
 * registry that route registration already populated.
 *
 * The database and Redis client are both poisoned placeholders rather than null. createApp mounts
 * the ERPNext webhook only `if (database)`, and `/api/ai/*` only `if (database && redis &&
 * entitlements)` (see app.ts's AI gate section), so null would silently emit a document missing
 * real endpoints, while real clients would open connections just to enumerate routes. See
 * src/db/unusable.ts and src/redis-unusable.ts.
 */
export async function buildOpenApiDocument() {
  const keyStore = new KeyStore(60_000);
  await keyStore.init();

  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    // Registration touches no logger, but createApp requires one rather than defaulting so that a
    // default could never write real NDJSON to a caller's stdout. Discard whatever it would emit.
    logger: createLogger({ destination: () => undefined }),
    redis: createUnusableRedis(),
    database: createUnusableDatabase(),
    keyStore,
    // /docs and /openapi.json are tooling for reading the API, not part of the API's contract.
    docsEnabled: false,
  });

  keyStore.destroy();
  return app.getOpenAPI31Document(OPENAPI_DOCUMENT_CONFIG);
}
