import type { AppEnv } from "./requestId";
import type { MiddlewareHandler } from "hono";

/**
 * Runs `middleware` only for the given HTTP methods and passes every other request straight through.
 *
 * Hono's `routes.use(path, ...)` applies to every method on that path, so a guard meant for one
 * route on a shared path (POST /api/users beside GET /api/users) would otherwise also gate the
 * others — e.g. demand `user:create` just to list users.
 */
export function onlyMethods(
  methods: readonly string[],
  middleware: MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => (methods.includes(c.req.method) ? middleware(c, next) : next());
}
