import type { AppEnv } from "../middleware/requestId";
import type { Hook } from "@hono/zod-openapi";

/**
 * Default validation hook for every OpenAPIHono instance in this app (ST-060).
 *
 * Route-level validation failures are re-thrown as the ZodError they already are, so they land in
 * errorHandlerMiddleware's `error instanceof ZodError` arm and come back as a 400 VALIDATION_FAILED
 * problem+json with a `z.prettifyError` detail — the same envelope every other failure in this app
 * produces.
 *
 * Without this, @hono/zod-validator answers `c.json(result, 400)`: raw Zod internals, an
 * application/json content type, no request_id, and no error code. That response would contradict
 * both the error contract and the OpenAPI document describing it.
 */
export const openApiValidationHook: Hook<unknown, AppEnv, string, void> = (result) => {
  if (!result.success) {
    throw result.error;
  }
};
