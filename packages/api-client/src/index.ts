export { createApiClient } from "./client";
export type { ApiClient, ApiClientOptions } from "./client";

export { ApiError, clientProblemSchema } from "./errors";
export type { ApiErrorFields, ClientProblem } from "./errors";

export { authMiddleware } from "./interceptors/auth";
export type { TokenProvider } from "./interceptors/auth";
export { tenantMiddleware, TENANT_QUERY_PARAM } from "./interceptors/tenant";
export type { SchoolIdProvider } from "./interceptors/tenant";
export { sanitizeMiddleware, stripUnnormalizedNesting } from "./interceptors/sanitize";
export type { SanitizeOptions } from "./interceptors/sanitize";
export { problemJsonMiddleware } from "./interceptors/problem-json";

export { assertListParams } from "./pagination";
export type { ListParams, SortDirection } from "./pagination";
export { requireCompositeKey } from "./composite";
export type { CompositeKey } from "./composite";

export type { components, operations, paths, webhooks } from "./generated-types";
