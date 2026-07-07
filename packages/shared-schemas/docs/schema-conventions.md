# Schema conventions

Conventions for `@studafy/shared-schemas`, the Zod schemas shared by API routes and web
forms. Keep this package to **base primitives and cross-cutting envelopes** — domain-entity
schemas belong in their own packages/services.

## Naming

- Every schema is exported as `<name>Schema` (camelCase), e.g. `uuidSchema`, `moneySchema`,
  `paginationQuerySchema`.
- Export the inferred type alongside each schema via `z.infer`, named in PascalCase:
  `export type Money = z.infer<typeof moneySchema>`.
- Numeric bounds that callers may need are exported as named constants
  (`PAGINATION_DEFAULT_LIMIT`, `PAGINATION_MAX_LIMIT`) rather than inlined magic numbers.

## Primitives (`base.ts`)

- **UUID** — `uuidSchema` (`z.uuid()`), RFC 4122.
- **Money** — `moneySchema` = `{ amountMinor: integer, currency: ISO-4217 alpha-3 }`.
  Money is stored as **integer minor units** (e.g. cents), never a float, to avoid rounding
  error. `currency` is a three-letter uppercase code. This is the single canonical money shape
  for the platform; if it must change, change it here.
- **Date** — `dateSchema` (`z.iso.date()`), ISO-8601 `YYYY-MM-DD`.
- **Date-time** — `dateTimeSchema` (`z.iso.datetime()`), ISO-8601 UTC timestamp.

## Pagination (`pagination.ts`)

- Cursor-based, not offset-based. `cursorSchema` is an **opaque** non-empty string — its
  encoding is the producer's concern; consumers must not parse it.
- `paginationQuerySchema` = `{ limit, cursor? }`. `limit` is **coerced** (query-string and form
  values arrive as strings), defaults to `PAGINATION_DEFAULT_LIMIT` (20), and is **hard-capped
  at `PAGINATION_MAX_LIMIT` (100)** — a request for more is rejected, not silently clamped.

## Errors (`error.ts`)

- The error envelope is **RFC 9457 `application/problem+json`**: `problemDetailsSchema` =
  `{ type, title, status, detail?, instance?, code }`. `type` defaults to `"about:blank"`;
  `status` is the HTTP status (100–599).
- `code` (`errorCodeSchema`) is an extension member whose values come **directly from
  `ERROR_CODES` in `@studafy/constants`** (`z.enum(ERROR_CODES)`). Error codes are never
  redeclared in this package — constants is the single source of truth.

## Testing

- Tests use Bun's runner (`import { ... } from "bun:test"`), one `*.test.ts` per source module.
- Cover, per schema: a valid parse, at least one invalid parse (`safeParse(...).success` is
  `false`), and — for anything serialized over the wire — a **round-trip** assertion
  (`schema.parse(JSON.parse(JSON.stringify(schema.parse(value))))`).
