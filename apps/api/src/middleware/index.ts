/**
 * Middleware barrel exports.
 *
 * @example
 * ```typescript
 * import { requestIdMiddleware, localeMiddleware, loggerMiddleware, errorHandlerMiddleware } from "./middleware";
 * ```
 */

export {
  requestIdMiddleware,
  type RequestIdOptions,
  type AppEnv,
  type AppVariables,
  type AuthContext,
} from "./requestId";
export {
  localeMiddleware,
  parseAcceptLanguage,
  getLocalizedMessage,
  getForwardableAcceptLanguage,
  type SupportedLocale,
} from "./locale";
export { loggerMiddleware, type LoggerMiddlewareOptions } from "./logger";
export {
  errorHandlerMiddleware,
  notFoundHandler,
  apiProblemSchema,
  type ApiProblem,
} from "./errorHandler";
export { rateLimiterMiddleware, extractClientIp, type RateLimiterOptions } from "./rateLimiter";
