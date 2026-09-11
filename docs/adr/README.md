# Architecture Decision Records

This directory records the repository's architectural decisions. Each file follows the same shape —
**Status · Context · Decision · Alternatives considered · Consequences · Review** — and is numbered
in the sequence in which the decision was recorded.

## Sourcing and the SAD

The Software Architecture Document (SAD) is an external document and is **not in this repository**.
The in-repo re-creations under [`../architecture/`](../architecture/) (`SAD_13`, `SAD_16`, `SAD_21`,
`SAD_28`, `SAD_30`) each state that gap explicitly. These ADRs are the repository's own record of
the decisions that this code actually implements; where the SAD first described a requirement, the
ADR cites the SAD section re-creation, and the SAD files link back to the ADRs that record the
decision. A decision that contradicts the code is not a decision — so an ADR whose reasoning the
code no longer matches must be superseded before the code, not after.

## Convention

- One decision per ADR. If a later decision contradicts an earlier one, the later ADR supersedes and
  says so — earlier files are not rewritten in place.
- **Required sections:** `Status` (Accepted / Superseded by … / Deprecated), `Context` (the problem,
  not the solution), `Decision` (the actual choice, with file/migration citations so it can be
  verified against the code), `Alternatives considered` (what was rejected and why), `Consequences`
  (what this decision commits the repository to), and `Review` (reviewer identity and date).
- Files are named `NNNN-kebab-case-title.md`; titles are `ADR-NNN: …`.

## Index

| ADR                                               | Decision                                                                                        | Topic area           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------- |
| [ADR-000](0000-monorepo-tooling-choice.md)        | Bun workspaces + Turborepo for dependency management and task orchestration                     | Monorepo tooling     |
| [ADR-001](0001-shared-lint-format-config.md)      | Shared lint/format config as a root-inherited package                                           | Developer experience |
| [ADR-002](0002-fixed-roles-authorization.md)      | Fixed compile-time roles and a `resource:action` permission matrix in `@studafy/constants`      | Authorization        |
| [ADR-003](0003-git-hooks-conventional-commits.md) | Lefthook + commitlint for Conventional Commits                                                  | Developer experience |
| [ADR-004](0004-infrastructure-as-code.md)         | Infrastructure as Code with Terraform                                                           | Infrastructure       |
| [ADR-005](0005-erpnext-education-plane.md)        | ERPNext + Frappe Education as the ERPNext staging plane                                         | Integration          |
| [ADR-006](0006-identity-tokens-and-tenant-rls.md) | Identity tables, hash-only token storage, and the first tenant RLS application                  | Identity / tenancy   |
| [ADR-007](0007-ocr-engine.md)                     | tesseract.js in-process for OCR in the AI-ingestion pipeline                                    | AI ingestion         |
| [ADR-008](0008-tenancy-model.md)                  | One school per row (`school_id` FK), global-vs-tenant invariant, transaction-local tenant GUC   | Tenancy model        |
| [ADR-009](0009-rest-and-openapi.md)               | REST + OpenAPI 3.1 generated from zod-openapi route schemas, generated clients                  | API contract         |
| [ADR-010](0010-runtime-choice.md)                 | Bun as the single runtime, installer, test runner, and bundler                                  | Runtime              |
| [ADR-011](0011-pgvector.md)                       | Embeddings in PostgreSQL (`vector` ext.), one global HNSW graph, iterative-scan retrieval       | AI retrieval         |
| [ADR-012](0012-transactional-outbox.md)           | `app.outbox_events` — one outbox, exactly-once claim, at-least-once delivery                    | Async reliability    |
| [ADR-013](0013-payment-abstraction.md)            | `PaymentProviderPort` + one `StripeAdapter`, provider-neutral webhooks                          | Payments             |
| [ADR-014](0014-jwt-strategy.md)                   | RS256 access JWTs, in-process rotated `KeyStore`, `jti` denylist, entitlement-version staleness | Authentication       |
| [ADR-015](0015-rls-conventions.md)                | `apply_tenant_isolation` helper, FORCE RLS, no BYPASSRLS, fail-closed GUC                       | Row-level security   |
| [ADR-016](0016-channel-policy.md)                 | `AUTH_CHANNELS` (web/mobile/api) fixed at login, `requireChannel` guard                         | Channel policy       |

## Platform decision coverage

The platform's core decision set maps to this index as follows:

1. Tenancy model → ADR-0008 (+ ADR-0006)
2. REST / OpenAPI → ADR-0009
3. Runtime choice → ADR-0010 (+ ADR-0000)
4. pgvector → ADR-0011
5. Transactional outbox → ADR-0012
6. Payment abstraction → ADR-0013
7. JWT strategy → ADR-0014 (+ ADR-0006, SAD_13)
8. RLS conventions → ADR-0015 (+ ADR-0006)
9. Monorepo tooling → ADR-0000 (+ ADR-0010)
10. Channel policy → ADR-0016 (+ SAD_13)

## Review

The `## Review` section on each ADR records who reviewed the decision and when. By convention the
record is the reviewer's git identity and the date the decision was ratified; a later re-review
appends a line rather than rewriting history.
