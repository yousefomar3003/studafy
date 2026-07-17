import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createApp } from "../../app";
import { createInflightTracker } from "../../lifecycle";
import { createLogger } from "../../logger";
import {
  createOpenApiRoute,
  createRoute,
  ensureProblemDetails,
  OPENAPI_CONFIG,
  z,
} from "../registry";

const __dirname = dirname(fileURLToPath(import.meta.url));

const buildApp = () =>
  createApp({
    isReady: async () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
  });

const getSpec = () => {
  const app = buildApp();
  const spec = app.getOpenAPI31Document({
    openapi: OPENAPI_CONFIG.openapi,
    info: OPENAPI_CONFIG.info,
    servers: OPENAPI_CONFIG.servers,
  });

  // Inject ProblemDetails to mirror what the build script does.
  ensureProblemDetails(spec);
  return spec;
};

describe("OpenAPI spec structure", () => {
  const spec = getSpec();

  test("has openapi 3.1.0 version", () => {
    expect(spec.openapi).toBe("3.1.0");
  });

  test("has required info fields", () => {
    expect(spec.info.title).toBe("Studafy API");
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.info.description).toBeDefined();
  });

  test("has at least one server", () => {
    expect(spec.servers).toBeDefined();
    expect(spec.servers!.length).toBeGreaterThanOrEqual(1);
  });

  test("has components.schemas with ProblemDetails", () => {
    expect(spec.components?.schemas?.ProblemDetails).toBeDefined();
    const pd = spec.components!.schemas!.ProblemDetails as Record<string, unknown>;
    expect(pd.type).toBe("object");
    expect((pd.properties as Record<string, unknown>).title).toBeDefined();
    expect((pd.properties as Record<string, unknown>).status).toBeDefined();
    expect((pd.properties as Record<string, unknown>).code).toBeDefined();
    expect((pd.properties as Record<string, unknown>).request_id).toBeDefined();
  });
});

describe("OpenAPI spec — health routes excluded", () => {
  const spec = getSpec();

  test("/healthz does not appear in paths", () => {
    expect(spec.paths?.["/healthz"]).toBeUndefined();
  });

  test("/readyz does not appear in paths", () => {
    expect(spec.paths?.["/readyz"]).toBeUndefined();
  });
});

describe("createOpenApiRoute — default error responses", () => {
  test("injects default error responses when none are defined", () => {
    const route = createOpenApiRoute(
      createRoute({
        method: "get",
        path: "/api/test",
        responses: {
          200: {
            content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
            description: "Success",
          },
        },
      }),
    );

    const responses = route.responses as Record<string, unknown>;

    expect(responses[200]).toBeDefined();
    expect(responses[400]).toBeDefined();
    expect(responses[401]).toBeDefined();
    expect(responses[403]).toBeDefined();
    expect(responses[404]).toBeDefined();
    expect(responses[429]).toBeDefined();
    expect(responses[500]).toBeDefined();
  });

  test("does not overwrite explicitly defined error responses", () => {
    const route = createOpenApiRoute(
      createRoute({
        method: "get",
        path: "/api/test-override",
        responses: {
          200: {
            content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
            description: "Success",
          },
          404: {
            content: {
              "application/problem+json": {
                schema: z.object({ message: z.string() }),
              },
            },
            description: "Custom not found",
          },
        },
      }),
    );

    const responses = route.responses as Record<string, { description: string }>;
    expect(responses[404]!.description).toBe("Custom not found");
  });
});

describe("OpenAPI spec — committed file", () => {
  test("openapi.json exists and is valid JSON with expected shape", () => {
    const specPath = resolve(__dirname, "..", "..", "..", "openapi.json");
    const raw = readFileSync(specPath, "utf-8");
    const spec = JSON.parse(raw);

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Studafy API");
    expect(spec.components?.schemas?.ProblemDetails).toBeDefined();

    const pd = spec.components.schemas.ProblemDetails;
    expect(pd.type).toBe("object");
    expect(pd.required).toContain("title");
    expect(pd.required).toContain("status");
    expect(pd.required).toContain("code");
    expect(pd.required).toContain("request_id");
  });
});
