# Notification data model

Notifications, preferences, and devices are school-owned and tenant-isolated, and additionally
user-owned: each table carries both `school_id` and `user_id`, and each takes a restrictive
user-ownership policy on top of the canonical tenant policy. The SQL rationale -- keys, normalization,
RLS, index choices, and the benchmark -- is in
[notifications-data-model](../database/notifications-data-model.md).

```mermaid
erDiagram
  SCHOOLS ||--o{ USERS : "owns"
  SCHOOLS ||--o{ NOTIFICATIONS : "owns"
  SCHOOLS ||--o{ NOTIFICATION_PREFERENCES : "owns"
  SCHOOLS ||--o{ USER_DEVICES : "owns"

  USERS ||--o{ NOTIFICATIONS : "receives"
  USERS ||--o{ NOTIFICATION_PREFERENCES : "configures"
  USERS ||--o{ USER_DEVICES : "registers"

  SCHOOLS {
    uuid id PK
    text slug UK
  }
  USERS {
    uuid id PK_UK
    uuid school_id FK_UK
    text normalized_email UK
    user_status status
  }
  NOTIFICATIONS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid user_id FK
    notification_type notification_type
    text title
    text body
    jsonb metadata
    timestamptz read_at
    timestamptz created_at
  }
  NOTIFICATION_PREFERENCES {
    uuid user_id PK_FK
    notification_type notification_type PK
    notification_channel channel PK
    uuid school_id FK
    boolean enabled
  }
  USER_DEVICES {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid user_id FK_UK
    text fcm_token UK
    device_platform platform
    timestamptz last_seen
    timestamptz revoked_at
  }
```

## What the diagram does not say on its own

**Two boundaries, not one.** Every table has the canonical permissive `tenant_isolation` policy on
`school_id` _and_ a restrictive policy on `user_id` scoped to `studafy_app`. Restrictive policies AND
with permissive ones, so a row is reachable only when the school and the user both match. The
application must set `app.school_id` **and** `app.user_id` per transaction; neither has a default, so
an unset context reads nothing rather than everything. RLS is enabled _and forced_, so this binds the
table owner too.

**Sending is not reading.** `NOTIFICATIONS` deliberately has no restrictive INSERT policy: a
notification is written for someone by someone else, so a teacher posting a grade can insert a row
addressed to a student and cannot then read it back. SELECT, UPDATE and DELETE are strictly
self-only. Authorization for sending is the application's job, via the existing `notification:send`
permission.

**Tenant integrity.** Every `user_id` foreign key is composite -- `(user_id, school_id)` references
`app.users (id, school_id)` -- so a row can never point at a user outside its own school, even if
application code supplied a mismatched pair.

**Uniqueness.** `USER_DEVICES.fcm_token` is unique _per user_, not per school. A device that changes
hands is transferred by `app.claim_device_token`, which soft-revokes the previous owner's row before
the new owner upserts their own; a per-school constraint would raise an unresolvable conflict against
a row the new owner cannot see under RLS.

**Preferences are rows, not columns.** `(user_id, notification_type, channel) -> enabled` -- one row
per combination, not a wide table of boolean flags. They are seeded automatically by a trigger on
`app.users` the first time a user reaches `active`, currently 8 types x 3 channels = 24 rows.

**Cardinality note.** `NOTIFICATION_PREFERENCES` is drawn as a plain child of `USERS`, but it is
effectively a materialized cross product: every active user has exactly one row per
(type, channel) pair, and absence of a row is not "unset" but "never activated".
