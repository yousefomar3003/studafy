# Notification, preference, and device data model

Migration `000017_create_notification_and_device_tables.sql` (ST-045) adds the three tables the
notification pipeline needs in order to persist anything: `notifications` (the in-app inbox),
`notification_preferences` (per user, per type, per channel), and `user_devices` (the FCM push-token
registry). The ERD is in [notifications-data-model](../api/notifications-data-model.md). SQL
constraints are the source of truth; APIs must not weaken them or treat RLS as a substitute for
permission checks.

The vocabulary is not new. `app.notification_type` mirrors `NOTIFICATION_TYPES` in
`packages/constants/src/notifications.ts` label-for-label, and `app.notification_channel` mirrors the
three channels `apps/workers/docs/queue-catalog.md` already names for the `notifications` queue. The
paired test asserts both label lists, in order, against `pg_enum`, so the TypeScript constants and
the database types cannot drift apart silently.

## What owns what

| Table                      | Scope                                            | Key columns                             |
| -------------------------- | ------------------------------------------------ | --------------------------------------- |
| `notifications`            | one row per delivered notification per recipient | `id`; `(school_id, user_id)`            |
| `notification_preferences` | one row per user x type x channel                | `(user_id, notification_type, channel)` |
| `user_devices`             | one row per user's registration of a push token  | `id`; `(user_id, fcm_token)`            |

`read_at IS NULL` means unread. There is no separate boolean: a flag plus a timestamp would be two
representations of one fact, and they could disagree. `revoked_at IS NULL` means a device route is
live, on the same principle.

## Keys and functional dependencies

| Table                      | Primary and candidate keys                                                                                             | Principal dependencies                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `notifications`            | `pk_notifications (id)`; `uq_notifications_id_school (id, school_id)`                                                  | `id ->` recipient, type, title, body, metadata, read state |
| `notification_preferences` | `pk_notification_preferences (user_id, notification_type, channel)`                                                    | `(user_id, notification_type, channel) -> enabled`         |
| `user_devices`             | `pk_user_devices (id)`; `uq_user_devices_user_token (user_id, fcm_token)`; `uq_user_devices_id_school (id, school_id)` | `(user_id, fcm_token) ->` platform, last seen, revocation  |

All values are atomic: read state is a nullable timestamp rather than a list of read receipts, and a
user's preferences are rows rather than a CSV string or an array of enabled types (1NF).
`notification_preferences` is the only table with a composite key, and its single non-key attribute,
`enabled`, depends on all three of its components -- wanting `GRADE_POSTED` by email says nothing
about wanting it by push -- so no attribute depends on a proper subset of the key (2NF). No user
fact is copied into any of the three tables: a notification carries no email address or display name,
and a device carries no user profile, so the only path to those is the foreign key to `app.users`.
`metadata` holds identifiers for deep-linking, never a copy of the referenced entity's text, so a
renamed assignment does not leave a stale title behind in an inbox row (3NF).

`metadata` is JSONB for the reason [the normalization standard](./migration-policy.md#normalization-standard)
permits it: the deep-link payload genuinely varies by `notification_type` and is not stable relational
structure. It is constrained to an object (`ck_notifications_metadata`) so it cannot decay into a
scalar or a loosely typed array, and it is not indexed, because nothing queries by it.

## Two boundaries, not one

The ticket asks for user isolation via `user_id = current_setting('app.user_id')`. This repository's
canonical helper, `app.apply_tenant_isolation` (000006), installs a _permissive_ policy on `school_id`
and hard-rejects any table without a `NOT NULL school_id` carrying a single-column foreign key to
`app.schools`. The two are not in competition: all three tables carry `school_id` **and** `user_id`,
take the canonical tenant policy, and then take a **restrictive** policy on `user_id`. Restrictive
policies AND with the permissive one, so a row is reachable only when the school _and_ the user
match. Tenant isolation remains the outer boundary; user ownership is the inner one. This is the
shape 000014 introduced for `teacher_evaluations`.

### Why the restrictive policies name `studafy_app`

A restrictive policy applies only to the roles it names. Naming the runtime role fences it completely
while leaving two operations -- both legitimately cross-user -- reachable from a `studafy_admin`-owned
`SECURITY DEFINER` function. Without that, they are not expressible at all, because
`FORCE ROW LEVEL SECURITY` subjects even the table owner to its own policies:

- **`app.seed_default_notification_preferences()`** -- an administrator activating a user must be able
  to write _that user's_ defaults, and during the trigger `app.user_id` is the acting administrator,
  not the new user.
- **`app.claim_device_token(text)`** -- a handset changing hands must be able to retire the previous
  owner's route, and the previous owner's row is invisible to the new one.

Both are confined to `current_setting('app.school_id')`, so neither can cross a tenant boundary, and
`app.claim_device_token` can only ever set `revoked_at` -- it cannot read, move, or delete a row.
`studafy_admin` is `NOLOGIN` (000002), so these two functions are the only way to that capability.

### Why `notifications` has no restrictive INSERT policy

A notification is written _for_ someone _by_ someone else: a teacher posting a grade notifies a
student. A self-only `WITH CHECK` on INSERT would make the feature unbuildable. INSERT is therefore
confined by `tenant_isolation`'s `WITH CHECK` alone -- same school -- and authorization for _sending_
is the application's job, via the `notification:send` permission that already exists in
`packages/constants/src/permissions.ts`. SELECT, UPDATE, and DELETE are strictly self-only, and the
UPDATE policy carries `WITH CHECK` as well as `USING`, so a recipient may mark their own notification
read but may not re-address the row to someone else. This is a deliberate, tested deviation from a
blanket "USING and WITH CHECK everywhere"; see Known gaps.

## Why the token is unique per user, not per school

`uq_user_devices_user_token` is `(user_id, fcm_token)`. A per-school unique constraint would be the
stronger anti-duplicate-route guarantee on paper, but it is unusable under forced RLS: when a device
changes hands, user B's INSERT raises `23505` against a row owned by user A that B can neither see
nor delete, and there is no recovery from inside B's session. Ownership transfer is therefore an
explicit, privileged step, and ordinary re-registration stays a plain, conflict-free upsert:

```sql
SELECT app.claim_device_token($1);            -- soft-revokes any other user's live row for the token
INSERT INTO app.user_devices (school_id, user_id, fcm_token, platform, last_seen)
VALUES (...)
ON CONFLICT ON CONSTRAINT uq_user_devices_user_token
DO UPDATE SET last_seen = EXCLUDED.last_seen, platform = EXCLUDED.platform,
              revoked_at = NULL, updated_at = CURRENT_TIMESTAMP;
```

Rows are soft-revoked rather than deleted, so a token that moves between users leaves a trail and a
re-registering device reactivates its own row instead of accumulating duplicates.

## Default preferences

`trg_users_seed_notification_preferences` fires `AFTER INSERT OR UPDATE OF status ON app.users`
`WHEN (NEW.status = 'active')` and seeds the full matrix -- every type on every channel, enabled --
which is currently 8 x 3 = 24 rows per user. It is driven off `enum_range`, so a later migration that
adds a type or a channel does not have to be taught about it. `ON CONFLICT DO NOTHING` makes
re-activation (`suspended -> active`) idempotent and, importantly, does not resurrect a preference the
user has deliberately turned off. An invited user who never activates is seeded nothing.

This is the first trigger on `app.users` in the schema. It is a trigger rather than an application
call because the ticket requires the defaults to be reliable, and a database trigger cannot be
bypassed by a writer that forgets.

## RLS and grants

All three tables are owned by `studafy_admin`, have RLS **enabled and forced**, grant
`SELECT, INSERT, UPDATE, DELETE` to `studafy_app`, and revoke everything from `PUBLIC`. Neither role
has `BYPASSRLS`. The application must set both session variables per transaction:

```sql
SELECT set_config('app.school_id', $school_id, true);
SELECT set_config('app.user_id',  $user_id,   true);
```

Neither has a default, so the failure mode is closed: an unset or malformed GUC raises rather than
matching rows. Forced RLS means this holds for the table owner too, not only the runtime role -- the
test suite asserts that `studafy_admin` reading without context is denied.

Note for the delivery worker: resolving a user's devices is a _self_-read under
`user_devices_owner`, so the worker adopts the recipient's `app.user_id` for the delivery rather than
running as the sender.

## Index rationale

- **`idx_notifications_school_user_unread (school_id, user_id, created_at DESC) WHERE read_at IS NULL`**
  -- the inbox's hot path: a user's unread notifications, newest first. Partial because unread is a
  small and shrinking fraction of a mature inbox, so the index stays proportional to the backlog a
  user actually has rather than to everything they have ever received; marking one read removes it
  from the index instead of updating it in place.
- **`idx_notifications_school_user_created (school_id, user_id, created_at DESC, id)`** -- the inbox's
  second query: full history, newest first, keyset-paginated. `id` breaks ties between notifications
  created in the same instant, which a batch write produces by construction.
- **`idx_user_devices_school_user_platform_last_seen (school_id, user_id, platform, last_seen DESC) WHERE revoked_at IS NULL`**
  -- push targeting: a user's live tokens, optionally narrowed to one platform, most recently seen
  first. Partial on the predicate the send path already filters by, so revoked routes cost nothing.
- **`uq_user_devices_user_token (user_id, fcm_token)`** -- enforces the per-user token constraint and
  backs both the registration upsert and `app.claim_device_token`.
- **`pk_notification_preferences (user_id, notification_type, channel)`** -- the send-time question
  ("has this user disabled this type on this channel?") _is_ a lookup on this key.
- **`idx_notification_preferences_school_user_type_channel (school_id, user_id, notification_type, channel)`**
  -- ST-050's database-wide invariant requires every RLS-protected table to expose a B-tree with
  `school_id` as the leading key. It also gives the preference lookup an exact tenant-aware path.

Every composite index leads with `school_id` so the permissive tenant predicate is satisfied from the
index rather than by a recheck, with `user_id` immediately after it for the restrictive predicate.
Every GUC comparison casts to `uuid`, matching the column type exactly, so no index is disqualified
by an implicit coercion.

Migration `000023_add_notification_preferences_school_index.sql` supersedes the original exception
for `notification_preferences`. The index is created concurrently because an established database
holds 24 preference rows per user. `uq_user_devices_user_token` still needs no redundant partner;
the partial school-leading device index already covers its documented live-device query boundary.

## Index verification

`EXPLAIN (ANALYZE, BUFFERS)` under `SET ROLE studafy_app` with both GUCs set, against 300 users,
45,000 notifications, 1,200 devices, and 7,200 preference rows in one school. Each of the four query
shapes uses its intended index; none falls back to a sequential scan.

```
-- 1. Unread inbox
Limit (actual time=1.253..1.275 rows=10 loops=1)
  ->  Result (actual time=0.348..0.369 rows=10 loops=1)
        One-Time Filter: ((app.current_user_id() = '9006...'::uuid) AND ((current_setting('app.school_id'::text))::uuid = '75a4...'::uuid))
        ->  Index Scan using idx_notifications_school_user_unread on notifications (actual time=0.022..0.039 rows=10 loops=1)
              Index Cond: ((school_id = '75a4...'::uuid) AND (user_id = '9006...'::uuid))
              Buffers: shared hit=12
Execution Time: 1.314 ms

-- 2. Full inbox, keyset-paginated
Limit (actual time=16.141..16.150 rows=20 loops=1)
  ->  Incremental Sort (actual time=16.139..16.143 rows=20 loops=1)
        Sort Key: created_at DESC, id DESC
        Presorted Key: created_at
        ->  Index Scan using idx_notifications_school_user_created on notifications (actual time=0.022..0.318 rows=150 loops=1)
              Index Cond: ((school_id = '75a4...'::uuid) AND (user_id = '9006...'::uuid))
Execution Time: 16.257 ms

-- 3. Device push targeting
Sort (actual time=0.120..0.121 rows=3 loops=1)
  Sort Key: last_seen DESC
  ->  Index Scan using idx_user_devices_school_user_platform_last_seen on user_devices (actual time=0.013..0.017 rows=3 loops=1)
        Index Cond: ((school_id = '75a4...'::uuid) AND (user_id = '9006...'::uuid))
Execution Time: 0.150 ms

-- 4. Preference lookup
Index Scan using idx_notification_preferences_school_user_type_channel on notification_preferences
  Index Cond: ((school_id = (current_setting('app.school_id'::text))::uuid)
               AND (user_id = '9006...'::uuid)
               AND (notification_type = 'GRADE_POSTED')
               AND (channel = 'push'))
```

The restrictive `app.current_user_id()` predicate is `STABLE`, so PostgreSQL evaluates it once per
query. Plan 4 is the expected ST-050 index shape; the database-wide catalog test independently
asserts that the index is valid, ready, B-tree, and `school_id`-leading.

## Batch write benchmark

The ST-045 acceptance target: resolving a recipient's active devices and writing a batch of 10
notifications, in one transaction, in under **15 ms**. Measured by
`packages/db/tests/notifications-benchmark.test.ts` (gated behind `NOTIFICATIONS_BENCHMARK=1`, run as
its own CI step), with every control on: forced RLS with both the permissive tenant policy and the
restrictive user policy evaluated, both GUCs transaction-local, all foreign keys, all check
constraints, both notification indexes maintained on write, and a 500-row read backlog in the inbox.
5 warmup and 30 measured iterations against a 3-live-device recipient.

|                                 | min     | median       | p95      | mean        |
| ------------------------------- | ------- | ------------ | -------- | ----------- |
| Database (`pg_stat_statements`) | 0.82 ms | --           | --       | **1.18 ms** |
| End to end (one round-trip)     | 4.27 ms | **12.64 ms** | 33.35 ms | --          |

The database's own time for the send is **~1.2 ms**, a 12x margin under the target, and it is stable
across runs (1.10-1.26 ms mean over four consecutive runs). That is the number this migration owns and
the one that regresses if an index is dropped, a policy stops being index-supported, or a trigger
creeps onto the write path, so the suite asserts it against the 15 ms target directly.

The end-to-end figure needs a caveat, and the benchmark encodes it rather than hiding it. The measured
unit is deliberately a **single round-trip** -- the transaction, both GUCs, the device lookup and the
batch insert are issued as one exchange, which is the shape a latency-sensitive worker should use
anyway -- so its wall time is transport plus database work and nothing else. On the Linux CI container
an exchange is a few tenths of a millisecond and the assertion is the ticket's 15 ms, unmodified. On a
developer machine where Docker Desktop NATs the loopback, a bare `SELECT 1` costs ~7.6 ms at the median
and ~42 ms at p95; a naive wall-clock assertion there measures the network, not the schema, and flakes
on an idle machine with no schema change at all. The benchmark therefore measures that floor in-run and
asserts `median < 15 ms + one measured exchange`, which holds the schema to the full target while
charging the host's own transport to the host. The numbers above are from a Windows/Docker Desktop
host; CI is the environment of record.

This is a development measurement on a disposable container, not a production SLA.

## Known gaps

Not built here, and deliberately out of scope for this migration:

- **INSERT on `notifications` is tenant-scoped, not self-scoped.** Any authenticated user in a school
  can, at the database level, address a notification to any other user in that school. Narrowing this
  is an application-layer authorization concern (`notification:send`), not an RLS one, for the reason
  given above.
- **No retention or purge.** A mature inbox grows without bound; nothing archives or deletes read
  notifications, and nothing prunes devices that have not been seen in months. Both want a scheduled
  maintenance job in the shape of `db:attendance:partitions`.
- **No delivery receipts.** `notifications` records that a row was created, not that a push was
  accepted by FCM, delivered, or opened. A `notification_deliveries` table (per notification, per
  device, per attempt) is the natural next table and is what the `notifications` queue will need in
  order to retry intelligently.
- **`app.claim_device_token` soft-revokes rather than reassigns.** The previous owner's row is marked
  revoked and left in place; it is never re-pointed at the new user. That keeps the audit trail but
  means a token that ping-pongs between two users accumulates one row per user, not per handover.
- **No per-school preference defaults or admin overrides.** Every user is seeded the same
  all-enabled matrix; a school cannot force a channel off tenant-wide.
