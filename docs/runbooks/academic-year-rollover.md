# Academic Year Rollover Runbook

Operational guide for the `POST /api/academics/years/{yearId}/rollover` action (ST-091). This
endpoint transitions a target academic year to `active`, closes the prior active year, archives
enrollments, and writes audit logs — all within a single atomic database transaction.

## Prerequisites

1. The target academic year must already exist with status `planned` (or `closed`, for re-activation
   after a rollback).
2. The target year's date range must not overlap with the currently active year.
3. The caller must be authenticated with an `ORG_ADMIN` or `SUPER_ADMIN` role.

## What the Rollover Does (step by step)

1. **Validates the target year** — must exist, must not already be active.
2. **Loads the prior active year** — if one exists.
3. **Checks for date overlap** — the target year's date range must not overlap with the active year.
4. **Archives enrollments** — all `active` enrollments in classes belonging to the prior year are
   set to `completed`. This is a soft status change; the enrollment rows remain in the database with
   their full history preserved.
5. **Closes the prior year** — the active year's status transitions to `closed`.
6. **Activates the target year** — the target year's status transitions to `active`.
7. **Writes audit logs** — one `update` audit entry on `academic_years` documenting the transition,
   and (if any enrollments were archived) a second `update` entry on `enrollments`.

All six steps execute inside one `withTenantTx` transaction. If any step fails, the entire
operation rolls back — no partial state is committed.

## Request

```
POST /api/academics/years/{yearId}/rollover
Authorization: Bearer <token>
```

No request body is required. The `yearId` in the path is the UUID of the year to activate.

## Response (200)

```json
{
  "prior_year_id": "abc-...",
  "prior_year_status": "closed",
  "new_year_id": "def-...",
  "new_year_status": "active",
  "enrollments_archived": 42
}
```

| Field                  | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `prior_year_id`        | UUID of the previously active year, or `null` if none existed.      |
| `prior_year_status`    | `"closed"` if a prior year was archived, or `null`.                 |
| `new_year_id`          | UUID of the now-active year.                                        |
| `new_year_status`      | Always `"active"`.                                                  |
| `enrollments_archived` | Count of enrollment rows transitioned from `active` to `completed`. |

## Error Responses

| Status | Code                         | Meaning                                                      |
| ------ | ---------------------------- | ------------------------------------------------------------ |
| 400    | `ACADEMIC_YEAR_DATE_OVERLAP` | Target year overlaps the currently active year's date range. |
| 404    | `RESOURCE_NOT_FOUND`         | Target year does not exist or belongs to another school.     |
| 409    | `CONFLICT_STATE_MISMATCH`    | Target year is already active.                               |
| 401    | `AUTH_TOKEN_INVALID`         | Missing or invalid bearer token.                             |
| 403    | `AUTHZ_FORBIDDEN`            | Caller lacks `ORG_ADMIN` or `SUPER_ADMIN` role.              |

## Rollback Strategy

If a rollover is deployed and later found to be incorrect:

1. **Undo via another rollover** — create a new `planned` year for the original period, then
   roll over to it. The enrollments from the rolled-back year were set to `completed` and cannot
   be retroactively un-completed through this API; use a direct SQL update if necessary.

2. **Manual SQL** (emergency only):
   ```sql
   -- Restore the prior year to active
   UPDATE app.academic_years
   SET status = 'active', updated_at = CURRENT_TIMESTAMP
   WHERE id = '<prior_year_id>';

   -- Revert the target year to planned
   UPDATE app.academic_years
   SET status = 'planned', updated_at = CURRENT_TIMESTAMP
   WHERE id = '<target_year_id>';

   -- Revert archived enrollments (if needed)
   UPDATE app.enrollments
   SET status = 'active', updated_at = CURRENT_TIMESTAMP
   WHERE class_id IN (
     SELECT id FROM app.classes WHERE academic_year_id = '<prior_year_id>'
   )
   AND status = 'completed'
   AND updated_at >= NOW() - INTERVAL '1 hour';
   ```

## Verifying Audit Logs

```sql
SELECT actor_id, action, target_table, target_id, new_values, created_at
FROM app.audit_logs
WHERE school_id = '<school_id>'
  AND action = 'update'
  AND target_table IN ('academic_years', 'enrollments')
ORDER BY created_at DESC
LIMIT 10;
```

## Common Failure Modes

| Symptom                            | Cause                                                                        | Fix                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 409 `CONFLICT_STATE_MISMATCH`      | The target year was already set to active (perhaps by a concurrent request). | Refresh the year list and select a different target, or use the existing active year.                                                     |
| 400 `ACADEMIC_YEAR_DATE_OVERLAP`   | The new year's dates overlap with the active year.                           | Adjust the new year's `starts_on`/`ends_on` to avoid the active year's range, or close the active year first via its own update endpoint. |
| 404 `RESOURCE_NOT_FOUND`           | The year ID does not exist or belongs to a different school.                 | Verify the year ID from the `GET /api/academics/years` list.                                                                              |
| FK violation on enrollment archive | A class references a term or year that no longer exists (schema corruption). | Check referential integrity in `app.classes` and `app.terms` foreign keys.                                                                |

## What Is NOT Affected

- **Classes** — existing class rows remain unchanged. They still reference the old academic year.
  Admins create new classes for the new year via the normal class management flow.
- **Subjects and courses** — these are school-level structural definitions, not year-scoped. They
  persist across years unchanged.
- **Rooms** — school-level infrastructure, unaffected by rollover.
- **Teachers** — not scoped to academic years; their assignments are managed separately.
