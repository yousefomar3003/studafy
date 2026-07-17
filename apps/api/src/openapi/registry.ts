import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { ERROR_CODES } from "@studafy/constants";

import type { AppEnv } from "../middleware/requestId";
import type { RouteConfig } from "@hono/zod-openapi";

// Re-export the extended Zod and route utilities so route authors only need one import.
export { z, createRoute, OpenAPIHono };
export type { RouteConfig };

// ---------------------------------------------------------------------------
// ProblemDetails — Zod schema using the extended `z` from @hono/zod-openapi.
//
// Registered with .openapi('ProblemDetails') so @asteasolutions/zod-to-openapi
// converts it to valid OpenAPI 3.1.0 JSON Schema and places it in
// components.schemas. Route error responses reference it via $ref.
//
// The shape mirrors the RFC 9457 envelope from ST-056 plus our `code` and
// `request_id` extension members. Single-sourced from @studafy/constants.
// ---------------------------------------------------------------------------

export const problemDetailsZodSchema = z
  .object({
    type: z
      .string()
      .default("about:blank")
      .openapi({ description: "RFC 9457 type URI. Defaults to 'about:blank'." }),
    title: z.string().openapi({ description: "Human-readable status description." }),
    status: z.number().int().min(100).max(599).openapi({ description: "HTTP status code." }),
    detail: z
      .string()
      .optional()
      .openapi({ description: "Localized error message (4xx only). Omitted for 5xx." }),
    instance: z
      .string()
      .optional()
      .openapi({ description: "URI reference identifying the specific occurrence." }),
    code: z
      .enum(ERROR_CODES)
      .openapi({ description: "Machine-readable error code from @studafy/constants." }),
    request_id: z
      .string()
      .uuid()
      .openapi({ description: "UUID linking to log lines and audit trail." }),
  })
  .openapi("ProblemDetails");

// ---------------------------------------------------------------------------
// Default error responses — auto-injected by createOpenApiRoute when the caller
// does not explicitly define them. Uses $ref to the ProblemDetails component
// schema so the generated spec has clean references instead of inline schemas.
// ---------------------------------------------------------------------------

const PROBLEM_CONTENT = "application/problem+json" as const;
const PROBLEMREF = { $ref: "#/components/schemas/ProblemDetails" } as const;

function errorResponse(description: string) {
  return {
    content: {
      [PROBLEM_CONTENT]: {
        schema: PROBLEMREF,
      },
    },
    description,
  };
}

const DEFAULT_ERROR_RESPONSES: Record<string, ReturnType<typeof errorResponse>> = {
  400: errorResponse("Validation error"),
  401: errorResponse("Unauthorized"),
  403: errorResponse("Forbidden"),
  404: errorResponse("Not found"),
  429: errorResponse("Rate limit exceeded"),
  500: errorResponse("Internal server error"),
};

// ---------------------------------------------------------------------------
// createOpenApiRoute — wraps createRoute with project-wide defaults.
//
// Automatically injects RFC 9457 problem+json error responses for common
// status codes when the caller does not define them explicitly.
// ---------------------------------------------------------------------------

export function createOpenApiRoute<R extends RouteConfig>(route: R): R {
  const injected = { ...DEFAULT_ERROR_RESPONSES };

  // Remove defaults the caller has already defined so we don't overwrite them.
  for (const code of Object.keys(injected)) {
    if (code in (route.responses as Record<string, unknown>)) {
      delete injected[code];
    }
  }

  return {
    ...route,
    responses: {
      ...injected,
      ...route.responses,
    },
  } as R;
}

// ---------------------------------------------------------------------------
// OpenAPI document configuration
// ---------------------------------------------------------------------------

export const OPENAPI_CONFIG = {
  openapi: "3.1.0" as const,
  info: {
    title: "Studafy API",
    version: "1.0.0",
    description: "Studafy school management platform API",
  },
  servers: [{ url: "http://localhost:3000" }],
};

// ---------------------------------------------------------------------------
// ensureProblemDetails — guarantees the ProblemDetails schema is present in
// components.schemas even when no domain route references it yet.
//
// Called by the build script and tests so the error envelope is always documented.
// ---------------------------------------------------------------------------

export function ensureProblemDetails(spec: {
  components?: { schemas?: Record<string, unknown> };
}): void {
  if (spec.components?.schemas?.ProblemDetails) return;

  spec.components = spec.components ?? {};
  spec.components.schemas = spec.components.schemas ?? {};
  spec.components.schemas.ProblemDetails = {
    type: "object",
    required: ["title", "status", "code", "request_id"],
    properties: {
      type: { type: "string", default: "about:blank" },
      title: { type: "string" },
      status: { type: "integer", minimum: 100, maximum: 599 },
      detail: { type: "string" },
      instance: { type: "string" },
      code: {
        type: "string",
        enum: Object.values(ERROR_CODES),
      },
      request_id: { type: "string", format: "uuid" },
    },
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// registerOpenApi — adds OpenAPI spec and Scalar docs to an existing
// OpenAPIHono instance.
//
// The ProblemDetails component is automatically included in the spec because
// it is referenced by the default error responses in createOpenApiRoute.
//
// Call this AFTER middleware registration so the doc endpoints are protected
// by the same middleware stack as the rest of the API.
// ---------------------------------------------------------------------------

export function registerOpenApi(app: OpenAPIHono<AppEnv>): void {
  // Serve the OpenAPI 3.1.0 spec as JSON at GET /doc
  app.doc31("/doc", OPENAPI_CONFIG);

  // Serve Scalar interactive API reference at GET /docs
  app.get(
    "/docs",
    Scalar({
      url: "/doc",
      pageTitle: "Studafy API Reference",
    }),
  );
}
