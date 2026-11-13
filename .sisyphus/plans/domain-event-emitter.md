# Domain Event Emitter — Implementation Plan

## Context

The ERPNext webhook handler (`apps/api/src/erpnext/webhook.ts:190-193`) currently writes directly to `app.outbox_events` via raw SQL. This works but couples the outbox write to one call site. Every future service that needs to emit domain events (user lifecycle, enrollment, assignments, etc.) would have to duplicate the same INSERT + school_id GUC extraction. The task is to extract a reusable `emit()` helper that any service-layer code can call inside an existing tenant transaction.

## Scope

Create `/apps/api/src/lib/events/` with:

| File              | Purpose                                                      |
| ----------------- | ------------------------------------------------------------ |
| `schemas.ts`      | Zod schemas mapping each `DomainEvent` to its typed payload  |
| `emitter.ts`      | `emit(tx, event, payload)` — validates + inserts into outbox |
| `index.ts`        | Barrel re-export                                             |
| `emitter.test.ts` | Unit + integration tests                                     |

**Not in scope**: Refactoring the ERPNext webhook to use the new emitter (follow-up task).

## Design

### Payload schemas (`schemas.ts`)

Single source of truth: a `Record<DomainEvent, z.ZodType>` where keys are the `DOMAIN_EVENTS` values. TypeScript types derived via `z.infer` so there's one definition, not two.

Payload design原则: each event carries the **minimal IDs** needed by downstream consumers. Consumers query the DB for full entity data. ERPNext events are freeform (`z.record(z.string(), z.unknown())`) because their payloads come from an external system.

```
User events       → { userId }
Organization      → { organizationId }
Course            → { courseId }
Enrollment        → { enrollmentId, courseId, studentId }
Assignment        → { assignmentId, courseId }
Submission        → { submissionId, assignmentId, studentId }
Discussion        → { discussionId }
StudyGroup        → { groupId }
Certificate       → { certificateId, studentId }
ERPNext           → z.record(z.string(), z.unknown())  // freeform
```

### Emitter (`emitter.ts`)

```typescript
export async function emit<E extends DomainEvent>(
  tx: TransactionSql,
  event: E,
  payload: z.infer<(typeof eventPayloadSchemas)[E]>,
): Promise<void>;
```

**Transaction guard**: reads `school_id` from `current_setting('app.school_id')` inside the INSERT. If the GUC isn't set (i.e., not inside a `withTenantTx` or equivalent), PostgreSQL throws `42P02` ("unrecognized configuration parameter") or the uuid cast fails. This is the "emitting outside a transaction throws" acceptance criterion — enforced by the database, not a fragile runtime check.

**Why not a wrapper around `withTenantTx`?**: The emitter writes to the outbox _within_ an existing transaction. The caller owns the transaction boundary (domain writes + outbox insert are atomic). Wrapping the transaction would break atomicity or force callers into a rigid pattern.

### Tests (`emitter.test.ts`)

Following the existing pattern from `tenant-tx.test.ts`:

1. **Payload validation per event name**: Loop over all `DOMAIN_EVENTS` values, verify each has a schema and `schema.parse()` succeeds with valid data and rejects invalid data.
2. **Emit inside transaction**: Integration test — `db.begin()` + `set_config` → `emit()` → verify row in `outbox_events`.
3. **Emit without school_id GUC throws**: `db.begin()` without `set_config` → `emit()` → expect rejection.
4. **Invalid payload throws**: Valid event name but wrong payload shape → expect Zod error.

Integration tests gated by `integrationEnabled` / `TEST_DATABASE_URL` per existing convention.

## Files to create

1. `apps/api/src/lib/events/schemas.ts`
2. `apps/api/src/lib/events/emitter.ts`
3. `apps/api/src/lib/events/index.ts`
4. `apps/api/src/lib/events/emitter.test.ts`

## Verification

1. `cd apps/api && bun test src/lib/events/emitter.test.ts` — all tests pass
2. `cd apps/api && bun run check-types` — no type errors
3. `cd apps/api && bun run lint` — no lint errors
