# OpenAPI Generation

Type-safe route registration with automatic OpenAPI 3.1.0 spec generation.

## Architecture

```
registry.ts          Central OpenAPI registry (schemas, helpers, config)
  ├── z               Re-export of @hono/zod-openapi's extended Zod
  ├── createRoute     Re-export of @hono/zod-openapi's createRoute
  ├── createOpenApiRoute()  Wraps createRoute with auto-injected error responses
  ├── ensureProblemDetails()  Guarantees ProblemDetails is in components.schemas
  └── registerOpenApi()  Mounts GET /doc (JSON) and GET /docs (Scalar UI)

build.ts             CLI script — generates openapi.json at build time
  ├── Default mode    Writes spec to apps/api/openapi.json
  └── --check mode    CI mode — fails if committed spec is stale

routes/              Domain route files (one per resource)
  ├── <resource>.schema.ts   Zod schemas for request/response
  └── <resource>.ts          Route definitions + handlers
```

## How to Register a New Route

### 1. Define Zod Schemas

Create `apps/api/src/routes/<resource>.schema.ts`:

```typescript
import { z } from "../openapi/registry";

export const userSchema = z
  .object({
    id: z.string().uuid().openapi({ description: "Unique identifier." }),
    name: z.string().openapi({ description: "Full name." }),
  })
  .openapi("User"); // <-- Register as named component for $ref reuse

export const createUserBodySchema = z
  .object({
    name: z.string().min(1).max(100).openapi({ description: "Full name." }),
  })
  .openapi("CreateUserBody");
```

### 2. Define Routes with `createOpenApiRoute`

Create `apps/api/src/routes/<resource>.ts`:

```typescript
import { createOpenApiRoute, z } from "../openapi/registry";
import { createUserBodySchema, userSchema } from "./users.schema";

const createUser = createOpenApiRoute({
  method: "post",
  path: "/api/users",
  tags: ["Users"],
  summary: "Create a user",
  request: {
    body: { content: { "application/json": { schema: createUserBodySchema } } },
  },
  responses: {
    201: {
      content: { "application/json": { schema: userSchema } },
      description: "The created user.",
    },
  },
});
```

**Key:** Every route must be wrapped with `createOpenApiRoute`. This auto-injects
RFC 9457 `problem+json` error responses for 400, 401, 403, 404, 429, and 500
unless you explicitly define those status codes yourself.

### 3. Register in `app.ts`

```typescript
import { userRoutes } from "./routes/users";

// Inside createApp():
app.route("/", userRoutes());
```

## Error Envelope (ST-056)

All error responses use the RFC 9457 Problem Details format via `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "The requested student was not found.",
  "code": "RESOURCE_NOT_FOUND",
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

The `ProblemDetails` schema is always present in `components.schemas` in the
generated spec, even if no domain routes reference it yet.

## Build Commands

| Command                 | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `bun run openapi:build` | Generate `apps/api/openapi.json`                |
| `bun run openapi:check` | Fail if committed spec is stale (CI)            |
| `bun run openapi:lint`  | Validate spec against OpenAPI 3.1.0 meta-schema |

## CI Pipeline

The `api-spec-lint.yml` workflow runs on PRs that touch API source or shared schemas:

1. **Meta-schema validation** — `redocly lint` validates the committed spec against
   the official OpenAPI 3.1.0 meta-schema.
2. **Drift detection** — `bun run openapi:check` compares the committed spec against
   a freshly generated one.
3. **Diff posting** — If the spec is stale, the workflow generates a unified diff and
   posts it as a PR comment (upserts on subsequent pushes).
4. **Build failure** — The job fails if the spec is out of date.

## Adding Custom Error Responses

If your route needs a non-standard error response (e.g., a specific 409 Conflict shape),
define it explicitly in `responses`. `createOpenApiRoute` will not overwrite it:

```typescript
const transferOwnership = createOpenApiRoute({
  method: "post",
  path: "/api/users/{id}/transfer",
  responses: {
    200: {/* ... */},
    409: {
      content: { "application/problem+json": { schema: conflictSchema } },
      description: "Ownership transfer conflict",
    },
  },
});
```

## Testing

Tests live in `apps/api/src/openapi/__tests__/spec.test.ts` and verify:

- Spec structure (version, info, servers, ProblemDetails)
- Health routes are excluded from the spec
- `createOpenApiRoute` injects/defers error responses correctly
- Committed `openapi.json` matches expected shape
