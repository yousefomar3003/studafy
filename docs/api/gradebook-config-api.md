# Gradebook Configuration API (ST-112)

Weighted assessment categories and term-versioned grading schemes per class gradebook.
Teachers and admins configure how a class's final grade is computed: category weights
(e.g. Homework 20%, Midterm 30%, Final Exam 50%) must sum to exactly 100%, and grading
scales (A–F, numeric, pass/fail, etc.) are versioned per academic term so historical
grades remain auditable.

Source: [`apps/api/src/modules/grades/config`](../../apps/api/src/modules/grades/config).
The generated contract is [`apps/api/openapi.json`](../../apps/api/openapi.json); this document
explains the parts of the behaviour a schema cannot express.

## Endpoints

### Assessment categories

| Method | Path                                                                  | Permission     |
| ------ | --------------------------------------------------------------------- | -------------- |
| GET    | `/api/grades/config/gradebooks/{gradebookId}/categories`              | `grade:read`   |
| POST   | `/api/grades/config/gradebooks/{gradebookId}/categories`              | `grade:update` |
| PATCH  | `/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}` | `grade:update` |
| DELETE | `/api/grades/config/gradebooks/{gradebookId}/categories/{categoryId}` | `grade:update` |

### Grading schemes

| Method | Path                                                      | Permission     |
| ------ | --------------------------------------------------------- | -------------- |
| GET    | `/api/grades/config/gradebooks/{gradebookId}/scheme`      | `grade:read`   |
| POST   | `/api/grades/config/gradebooks/{gradebookId}/scheme/link` | `grade:update` |
| GET    | `/api/grades/config/schemes?termId=`                      | `grade:read`   |
| POST   | `/api/grades/config/schemes`                              | `grade:update` |
| GET    | `/api/grades/config/schemes/{schemeId}`                   | `grade:read`   |

## Who can see what

Two layers — tenant isolation at the row level and application-level authorization.

| Layer                                      | Answers                    |
| ------------------------------------------ | -------------------------- |
| `tenant_isolation` (migration `000006`)    | which school?              |
| `assertCanManageGradebook` (service layer) | which class in the school? |

The service-layer check delegates to the same SECURITY DEFINER helpers the RLS policies call:

- `app.teaches_class(classId)` — true if the caller is the class's `lead_teacher_id` **or** holds a
  timetable slot for the class (covers co-teachers and substitutes).
- `app.current_user_is_school_admin()` — true for `ORG_ADMIN` and `SUPER_ADMIN` roles.

| Caller                                    | Sees                                 |
| ----------------------------------------- | ------------------------------------ |
| School admin (`ORG_ADMIN`, `SUPER_ADMIN`) | every gradebook config in the school |
| Teacher of the class                      | the gradebook for classes they teach |
| Any other caller                          | nothing (403)                        |

### 403 vs 404

Managing a gradebook the caller does not teach answers **403** (`AUTHZ_FORBIDDEN`) — the caller has
already passed the `grade:read` permission gate, so "not your class" is more useful than a lie.

Reading a gradebook or scheme that does not exist answers **404** (`GRADEBOOK_NOT_FOUND`,
`GRADING_SCHEME_NOT_FOUND`, or `ASSESSMENT_CATEGORY_NOT_FOUND`).

## Gradebook lazy initialisation

Gradebook rows are not pre-created. The first access to a class's gradebook configuration creates a
`draft` gradebook row via `getGradebookByClassId()`. This means a class with no gradebook
configuration simply has no row in `app.gradebooks` until a teacher or admin first reads or writes
to it.

## Weight validation

The sum of all **active** category weights for a gradebook must equal exactly **100% (1.00)**.
A float tolerance of 0.001 handles rounding drift (e.g. 33.33 + 33.33 + 33.34 = 100.00).

Validation runs inside the mutation's transaction, so an invalid state rolls the entire change back:

- After **insert** — the new row is visible to the weight query; if the total is off the INSERT
  rolls back.
- After **update** — the updated weight is included; if the total is off the UPDATE rolls back.
- After **delete** — the remaining active categories must still sum to 100%; if not the DELETE
  rolls back.

The schema-level `numeric(5,2)` column enforces 0.00—100.00 range at the database level.

## Grading scheme versioning

`app.grading_schemes` is **append-only** for `studafy_app`: the application role has only
`SELECT` and `INSERT` grants. Prior versions are structurally immutable.

- Creating a scheme auto-assigns the next `version` integer for that term (version 1, 2, ...).
- `is_inherited = true` marks schemes auto-generated from school defaults (via
  `getOrCreateInheritedScheme`).
- When `GET /scheme` is called on a gradebook that has no linked scheme, one is auto-inherited from
  the school's `school_settings.grading_scheme` and linked to the gradebook.

### Scheme linking

`POST /scheme/link` requires the scheme to belong to the same academic term as the gradebook's
class. Mismatched terms return **400** (`VALIDATION_FAILED`).

## Lifecycle

### Assessment categories

Category rows are hard-deleted. There is no soft-delete or archive state — an unused category
should be removed entirely, which is safe because categories are configuration, not student work.

- `DELETE` removes the row. The caller must ensure the remaining active weights still sum to 100%.
- `is_active = false` can be used as an alternative to deletion, freezing a category's weight
  contribution without removing it.

### Grading schemes

Schemes are never deleted or updated. To change boundaries:

1. Create a new version via `POST /config/schemes`.
2. Link it via `POST /config/scheme/link`.
3. Prior versions remain queryable by ID for historical grade lookups.

## Audit

Every mutation writes an `app.audit_logs` row inside the mutation's own transaction, so the
write is atomic with the mutation.

| Operation                | Action   | Target table            |
| ------------------------ | -------- | ----------------------- |
| Create category          | `insert` | `assessment_categories` |
| Update category          | `update` | `assessment_categories` |
| Delete category          | `delete` | `assessment_categories` |
| Create grading scheme    | `insert` | `grading_schemes`       |
| Inherit grading scheme   | `insert` | `grading_schemes`       |
| Link scheme to gradebook | `update` | `gradebooks`            |

Update rows carry a real before/after diff of the changed fields. `school_id`, `actor_id`, and
`request_id` are read from PostgreSQL session GUCs set by `withTenantTx`, never passed as
arguments.

No events are emitted to `app.outbox_events` for gradebook configuration changes.

## Error codes

| Status | Code                             | When                                                                         |
| ------ | -------------------------------- | ---------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`              | body fails schema validation, or scheme term does not match gradebook's term |
| 400    | `INVALID_GRADEBOOK_WEIGHT_TOTAL` | active category weights do not sum to 100%                                   |
| 401    | `UNAUTHORIZED`                   | missing or invalid authentication                                            |
| 403    | `AUTHZ_FORBIDDEN`                | caller does not hold the required permission or does not teach the class     |
| 404    | `GRADEBOOK_NOT_FOUND`            | no gradebook with the given ID                                               |
| 404    | `GRADING_SCHEME_NOT_FOUND`       | no grading scheme with the given ID                                          |
| 404    | `ASSESSMENT_CATEGORY_NOT_FOUND`  | no assessment category with the given ID                                     |
| 404    | `RESOURCE_NOT_FOUND`             | term not found (during scheme creation or inheritance)                       |
| 500    | `INTERNAL_SERVER_ERROR`          | unexpected server error                                                      |

All failures are RFC 9457 `application/problem+json` with a `request_id` for correlation.
