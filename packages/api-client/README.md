# @studafy/api-client

A fully typed, standard-`fetch` TypeScript client for the Studafy API, generated from the OpenAPI
3.1 contract that ST-060 emits at [`apps/api/openapi.json`](../../apps/api/openapi.json).

Every path, parameter, request body, and response is type-checked against the spec; a non-2xx
response throws a typed [`ApiError`](./src/errors.ts) carrying the RFC 9457 `problem+json` fields and
the correlation `request_id`. The runtime is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)
— a thin wrapper over the platform `fetch`, no heavy client runtime.

## Usage

```ts
import { createApiClient, ApiError } from "@studafy/api-client";

const api = createApiClient({
  baseUrl: "https://api.studafy.app",
  getToken: () => session.accessToken, // injects `Authorization: Bearer …`
  getSchoolId: () => session.schoolId, // injects the active tenant
});

try {
  const { data } = await api.GET("/healthz");
  //      ^? { readonly status: "ok" } | undefined  — typed from the spec, no casts
  console.log(data?.status);
} catch (error) {
  if (error instanceof ApiError) {
    // detail / instance / code / status / request_id are all typed and available to an error boundary
    console.error(`${error.code} (ref ${error.request_id}): ${error.detail ?? error.title}`);
  }
}
```

In the web app the client is a single shared instance — see
[`apps/web/src/lib/api.ts`](../../apps/web/src/lib/api.ts) — consumed by
[`PortalPage`](../../apps/web/src/routes/portal/PortalPage.tsx) via TanStack Query.

## Interceptors

`createApiClient` wires openapi-fetch middleware in this order:

| Interceptor                                                   | What it does                                                | Enabled                        |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| [`authMiddleware`](./src/interceptors/auth.ts)                | Adds `Authorization: Bearer <token>` from `getToken`        | when `getToken` is provided    |
| [`tenantMiddleware`](./src/interceptors/tenant.ts)            | Injects the active `school_id` (path-scoped routes skip it) | when `getSchoolId` is provided |
| [`sanitizeMiddleware`](./src/interceptors/sanitize.ts)        | Strips un-normalized nested sub-objects from JSON bodies    | opt-in via `sanitize`          |
| [`problemJsonMiddleware`](./src/interceptors/problem-json.ts) | Throws a typed `ApiError` on any non-2xx                    | always                         |

```ts
// Opt into body sanitization, allow-listing routes that legitimately carry a nested payload:
createApiClient({ baseUrl, sanitize: { allowNested: ["data"] } });
```

## Errors — `application/problem+json`

`ApiError` parses the RFC 9457 envelope (shape reused from
[`@studafy/shared-schemas`](../shared-schemas/src/error.ts)) and exposes:

- `status` — HTTP status.
- `code` — stable machine-readable error code (`ErrorCode`), or `null` for a non-problem body. Branch
  on this, never on the localizable `title`/`detail`.
- `detail`, `instance`, `type` — RFC 9457 members (`detail` is absent on 5xx by design).
- `request_id` — the body's `request_id`, falling back to the `X-Request-Id` response header. Quote
  this to support; it correlates with server logs and the audit trail.
- `problem` — the raw parsed body, or `null` when it was not a parseable problem.

## Relational-fidelity helpers

The generated types preserve the backend's 3NF shape: `NOT NULL` columns are strict fields, nullable
columns are `T | null` (not optional `?`). Two helpers keep call sites honest against routes that do
not exist yet (no list/tenant-scoped route is in the spec today — see **Status** below):

- [`assertListParams`](./src/pagination.ts) — mandates `limit` + `cursor` and constrains `sort_by` to
  a union of indexed columns, so a list call cannot bypass a B-Tree index.
- [`requireCompositeKey`](./src/composite.ts) — forces a composite `(id, school_id)` lookup to be
  passed as one block, so the tenant boundary is never an optional secondary argument.

## Regeneration & drift guard

The generated types are **committed** so a contract change appears in the pull-request diff. Do not
hand-edit [`src/generated-types.ts`](./src/generated-types.ts) — regenerate it:

```sh
bun run client:generate       # from the repo root (regenerates + formats)
bun run client:check-drift     # fails (exit 1) if the committed types are stale or hand-edited
```

CI runs `client:generate` and fails the build on a dirty tree, so the committed client can never
drift from the spec. `bun run verify` runs the full acceptance pipeline (codegen → TypeScript
verification → bundle) that the `<3s` benchmark measures.

## Status — awaiting live routes

The spec currently exposes three routes (`/healthz`, `/readyz`, `POST /erpnext/webhooks`). None
require auth, none are tenant-scoped in the path, and there are no list/pagination/sort operations.
The auth and tenant interceptors, the sanitizer, and the pagination/composite helpers are therefore
built and unit-tested against mocks but **inert against the live surface** until the corresponding
routes land — at which point they activate with no call-site changes.
