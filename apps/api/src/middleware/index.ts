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
export { idempotencyMiddleware, type IdempotencyOptions } from "./idempotency";
export {
  auditAction,
  emitAuditLog,
  redactPayload,
  SENSITIVE_KEYS,
  type AuditAction,
  type AuditEntry,
  type AuditMeta,
} from "./auditEmitter";
export { jwtAuthMiddleware, AuthException, type JwtAuthOptions } from "./jwtAuth";
export { requireAuth } from "./authContext";
export { corsMiddleware, type CorsOptions } from "./cors";
export { csrfMiddleware, type CsrfOptions } from "./csrf";
export {
  securityHeadersMiddleware,
  type SecurityHeadersOptions,
  type CspDirectives,
  type HstsOptions,
} from "./securityHeaders";
