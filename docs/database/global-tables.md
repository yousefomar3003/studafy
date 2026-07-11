# Global schools, plans, and reference data

Migrations `000004_create_global_tables.sql` and
`000005_seed_countries_and_currencies.sql` introduce Studafy's first application tables. SQL remains
the source of truth and the existing checksum/advisory-lock runner applies both transactionally.

## Classification and ownership

`schools`, `plans`, `plan_prices`, `countries`, `currencies`, and `platform_settings` are global
platform data. None is owned by or filtered for one school, and none contains `school_id`,
`tenant_id`, or a disguised tenant discriminator. Future tenant tables may reference their UUIDs.

SAD section 10 was not present in the repository or the linked ST-033 material when this migration
was authored. The global classification therefore comes from the ticket's explicit table list; this
document does not claim that the unavailable SAD text was inspected.

All tables, enum types, constraints, and indexes are owned by `studafy_admin`. The ST-031 default
CRUD grant is narrowed explicitly: `studafy_app` receives `SELECT` only on the six tables and owns
nothing; `PUBLIC` receives no table privileges. Until a reviewed administration API exists, writes
must run through controlled maintenance as `studafy_admin`.

## Table contracts

| Table               | Purpose and keys                                                                | Relationships and lifecycle                                                                  |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `countries`         | UUID primary key; unique ISO alpha-2, alpha-3, and three-digit M49 codes        | `is_active` limits platform availability without deleting canonical reference data.          |
| `currencies`        | UUID primary key; unique ISO-4217 alpha-3 and numeric codes; exact `minor_unit` | Symbols are deliberately absent and never identifiers. `is_active` is platform availability. |
| `schools`           | UUID primary key; unique lowercase hyphenated `slug`                            | Required country and default-currency references. Status defaults to `pending`.              |
| `plans`             | UUID primary key; unique lowercase stable `code`                                | Descriptive plan identity only; no prices or entitlement blobs.                              |
| `plan_prices`       | UUID primary key; unique plan/currency/interval business key                    | Exact non-negative `bigint` minor units; monthly/yearly current prices only.                 |
| `platform_settings` | UUID primary key; unique dotted lowercase `key`                                 | Exactly one boolean, bigint, or text value; public/internal sensitivity; no secrets.         |

All foreign keys use `ON UPDATE RESTRICT ON DELETE RESTRICT`. Country and currency rows cannot be
deleted while referenced, plans cannot be deleted while priced, and no relationship silently
cascades global business data. `created_at` and `updated_at` are real moments stored as `timestamptz`;
the caller maintaining data is responsible for changing `updated_at`. No trigger is introduced.

### School lifecycle

The enum values are `pending`, `active`, `suspended`, and `archived`. Transitions are application-
enforced because no shared transition-trigger convention exists:

- `pending` may become `active` or `archived`; it is not enabled for normal school operations.
- `active` may become `suspended` or `archived`; it permits normal operation.
- `suspended` may return to `active` or become `archived`; normal operation/login is blocked.
- `archived` is terminal and cannot be restored without a separately reviewed policy change.

The database guarantees a non-null valid value and safe `pending` default, but deliberately does not
encode transitions in a trigger.

### Platform settings

`value_type` and the exactly-one-value check make values structurally typed instead of storing every
setting as an unvalidated string. `sensitivity` is `internal` by default, `is_mutable` documents
whether controlled runtime administration may eventually update it, and `requires_restart` records
activation behavior. These fields do not grant write access.

Passwords, API keys, tokens, connection strings, and encryption material are prohibited. They remain
in Secrets Manager. ST-033 seeds no settings. Future migrations adding known keys must document
semantic bounds that the generic integer/text types cannot express.

## Reference-data provenance and updates

The country snapshot contains **248** rows from the English UN Statistics Division M49 overview,
retrieved 2026-07-11 from <https://unstats.un.org/unsd/methodology/m49/overview/>. Rows are included
only when both ISO alpha-2 and alpha-3 codes are assigned; aggregate regions are excluded. Countries
and dependent areas remain in scope because this is platform coverage, not a sovereignty list.

The currency snapshot contains **157** unique codes from SIX Group's ISO-4217 List One, published
2026-01-01 and retrieved 2026-07-11 from
<https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml>.
Repeated country uses are deduplicated by currency code. Entries marked `IsFund`, precious-metal
codes, testing/no-currency codes, and entries without numeric minor units are excluded.

The seed migration performs no network calls. For each canonical code it inserts a missing row,
accepts an exact metadata match, and raises on a conflicting name/code/minor-unit value. It never
silently overwrites reference metadata and deliberately preserves an existing `is_active` platform
decision. The loop is directly replayable; the migration runner also prevents a recorded version
from executing twice.

To update either standard, create a new ordered migration: record the new source publication and
retrieval dates, make code changes explicit, retain retired rows with `is_active = false` when they
are referenced, and never edit the applied seed migration.

## Normalization review

- `countries`: alpha-2, alpha-3, numeric code, and name depend only on the country UUID; each code is
  a candidate key. Atomic codes satisfy 1NF, the single-column key makes 2NF immediate, and no
  transitive platform fact is stored.
- `currencies`: code, numeric code, name, and minor-unit scale depend only on the currency UUID; both
  codes are candidate keys. Symbols and country lists are not duplicated.
- `schools`: name, status, and reference IDs depend only on the school UUID; slug is a candidate key.
  Country/currency metadata is referenced rather than copied.
- `plans`: display data and active state depend only on the plan UUID; code is a candidate key.
  Prices and future entitlements are separate concerns.
- `plan_prices`: amount and active state depend on the complete plan/currency/interval business key.
  Plan names and currency metadata are not repeated.
- `platform_settings`: description, typed value, sensitivity, and behavior flags depend only on the
  setting UUID; key is a candidate key. Typed atomic columns avoid JSONB and comma-separated data.

All tables satisfy 1NF-3NF. There is no deliberate denormalization, relationship array, JSONB
payload, repeated price column, polymorphic key, or extension-backed index.

## Index review

Primary and unique constraints provide exact lookup indexes for UUIDs, school slug, plan code,
country/currency codes, setting key, and the plan-price business key. Three ordinary indexes exist:

| Index                             | Query/integrity purpose                                                   | Tradeoff                                |
| --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `idx_schools_country_id`          | Join/filter schools by country and support country parent checks          | Adds one index write per school change. |
| `idx_schools_default_currency_id` | Join schools to their default currency and support currency parent checks | Adds one index write per school change. |
| `idx_plan_prices_currency_id`     | Currency-side joins and parent checks                                     | Adds one index write per price change.  |

No separate `plan_prices(plan_id)` index exists because the business-key unique index begins with
`plan_id`. Low-selectivity status/active indexes, name search indexes, trigram indexes, vector
indexes, and value indexes are omitted without an established API query and representative data.

## Safe reads and future changes

```sql
SELECT s.id, s.slug, s.name, s.status, c.alpha2_code, cur.code AS currency
FROM app.schools s
JOIN app.countries c ON c.id = s.country_id
JOIN app.currencies cur ON cur.id = s.default_currency_id
WHERE s.slug = 'north-star-school';

SELECT p.code, pp.billing_interval, pp.amount_minor, c.code AS currency
FROM app.plans p
JOIN app.plan_prices pp ON pp.plan_id = p.id
JOIN app.currencies c ON c.id = pp.currency_id
WHERE p.code = 'standard' AND p.is_active AND pp.is_active;
```

Future plan features belong in normalized entitlement/feature tables after their cardinality and
contracts are known. They must not be comma-separated or embedded into `plans` or `plan_prices`.
