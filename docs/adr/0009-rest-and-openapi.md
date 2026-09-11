# ADR-009: REST + OpenAPI — contract-first, generated client

## Status

Accepted

## Context

Studafy is reached by several clients — a browser app (`apps/web`), a native mobile app
(`apps/mobile`), and server-to-server callers — all talking to one HTTP API (`apps/api`). With three
clients there has to be one authoritative description of endpoints, request shapes, and error
shapes; otherwise each client re-derives the contract by reading source, and a breaking change is
discovered at runtime instead of in review. ST-269 also requires a hosted API reference site. The
decision to record is which API style and which contract mechanism the API is built around.

## Decision

- **REST over HTTP with JSON is the API style.** Routes are grouped under `/api/...`, use HTTP
  verbs and status codes conventionally, and return `application/json`. One exception to the JSON
  uniformity is the error envelope: errors are RFC 9457 `application/problem+json` (see below).
- **The contract is OpenAPI 3.1.0, generated from code — never hand-written.** `apps/api` is built
  on `@hono/zod-openapi`: every route declares its request and response schemas in zod at
  definition time (`createRoute` + `OpenAPIHono`), and the app exposes the merged document at
  `GET /openapi.json` (`src/openapi/document.ts`, `src/openapi/config.ts`). An interactive reference
  is served at `/docs` via Scalar. `scripts/generate-openapi.ts` writes
  `apps/api/openapi.json`, and the served document and the committed one are checked to agree.
- **Zod schemas are the single source of truth for validation and documentation.** The
  `openApiValidationHook` validates every request against the declared schemas, so a route's docs
  and its actual runtime validation cannot drift apart — the alternative (validate with one set of
  schemas, document with another) is the failure mode this avoids.
- **Clients are generated, not hand-authored.** `@studafy/api-client` is generated from the OpenAPI
  document and drift-checked in CI (`bun run client:generate`, `bun run client:check-drift`), and
  `apps/mobile`'s client is generated the same way. The hosted reference site
  (`apps/docs-api`) is built from the same live spec.
- **Errors carry a stable machine-readable code.** The envelope is RFC 9457 problem details
  (`src/problem.ts`) with `type`, `title`, `status`, `detail`, plus `request_id` (tied to logs and
  audit, SAD_28) and a `code` drawn from `ERROR_CODES` in `@studafy/constants`
  (`packages/constants/src/errors.ts`) — the same codes the `apps/docs-api` guides validate their
  prose against, so a doc that names a code that no longer exists fails the build.
- **`/api/*` is deny-by-default.** The JWT boundary covers it; public paths are explicit allow-lists
  (see ADR-0014 and `DEFAULT_PUBLIC_PATHS`).
- **Breaking-change discipline is enforced in CI.** `oasdiff` compares the generated spec across the
  PR, and the api-docs site build validates every documented route/code against the actual spec.

## Alternatives considered

- **GraphQL** — a single endpoint, client-picked fields, typed schema. Rejected: no stable per-route
  cacheability, heavier server machinery, and the strongest reason — our REST surface is already
  resource-shaped and our clients are known; GraphQL would buy flexibility nobody asked for at the
  cost of a second API contract to teach every client.
- **tRPC** — wonderfully typed, but couples clients to TypeScript and generates no portable
  documentation; the native mobile client (Dart) and the docs site would still need a separate
  contract. Rejected for the multi-client reality.
- **gRPC / protobuf** — strong contracts, but binary over plain HTTP, awkward in browsers, and an
  ecosystem mismatch with a JSON-first JS API and a mobile app. Not used.
- **Hand-written Swagger/OpenAPI YAML** beside the code — the contract and the validator drift the
  moment a route changes without a doc edit. Rejected explicitly; schema-as-code is the point of
  the decision.

## Consequences

- Every route change is a schema change; there is no "implementation without docs". A route that
  cannot be described in zod won't exist.
- Adding a field to a response regenerates the client; clients that don't need it are unaffected.
- Breaking changes are visible as a spec diff in the PR (via oasdiff), not discovered by a
  downstream team.
- The error vocabulary is centralized in `@studafy/constants` (ADR-0002 already centralizes
  permissions there); new error codes are reviewed like permissions, and their values are test
  guaranteed unique.

## Review

Reviewed by `baderalhindi` on 2026-09-11.
