# Timezone & locale test catalog

Single source of truth for Studafy's timezone- and locale-sensitive deadlines, digest labels, and
RTL rendering. Its job: make DST behaviour reproducible and keep "well-meaning future-deadline"
tests from flaking. Every expectation in this repo that mentions a school-local deadline, an
attendance correction anchor, a parent/notification digest date label, or an RTL report is keyed off
the matrix and the fixed instants below, and the suites named at the bottom enforce precisely that.

## Honesty rules (what the suite is allowed to assert — and must never)

1. **Postgres is the oracle for timezone math.** Deadlines and digest labels are produced by the SQL
   `AT TIME ZONE` / `make_interval(hours => ...)` operators running in the DB, which owns the IANA
   tz database (and, for digest-label suffixes, sends through the IANA engine the worker imports).
   Every deadline/label expectation is pinned against a **hardcoded local wall-clock literal** taken
   from the tables below — never recomputed on the fly with a JS timezone library (the repo has no
   `date-fns-tz` dependency in these paths).
2. **Tests never depend on the machine wall clock.** No suite compares a "48 hours from now" window
   or a digest label against `new Date()`. Every assertion anchors to a **fixed, documented
   absolute instant** (a specific UTC instant, or `CURRENT_TIMESTAMP` with an expiry the sweep
   tolerates by comparing instants, not wall-clock "same hour tomorrow").
3. **DST is asserted at the instant, then surfaced as the expected wall clock.** For each zone the
   suite enumerates the spring-forward and fall-back dates, computes each local-midnight anchor and
   its absolute delegate, and confirms the `AT TIME ZONE` round-trip landed on the documented local
   wall reading — e.g. America/New_York `2026-03-08 00:00` EDT anchors to the _same absolute
   instant_ that Europe/London, Europe/Berlin, Africa/Casablanca, Asia/Amman, Asia/Kathmandu, and
   Pacific/Kiritimati already disambiguate. A "naive +48h" reading is asserted as the _bug it is_:
   it lands at a different absolute instant than the production `make_interval(hours => 48)`, and
   that divergence is the very thing the test locks.
4. **Locale labels are honest about their primary direction.** RTL rendering is asserted for
   `ar` (via the finance report envelope / template direction), and every other supported locale is
   asserted LTR. Locale parsing is _not_ re-tested here — `parseAcceptLanguage` and the
   `en`/`ar` template pair already have dedicated suites (see `packages/**`), so this catalog only
   pins the surfaces those suites do not reach (notification digest labels by school-local date,
   parent digest date frames, RTL report direction).

## Zone matrix (2026)

2026 is a normal (non-leap) year; DST dates below are the IANA facts. Zones are grouped by how
Studafy actually uses them:

- **school-timezone DST zones** — used as the school settings `timezone` in attendance correction
  anchors and digest labels (configurable, per school, via `app.school_settings.timezone`) with
  default `Africa/Casablanca`.
- **recipient-timezone DST zones** — used as a per-user `timezone` on `app.user_notification_settings`
  for notification-digest date labels.
- **control zones (no DST, no change)** — `Africa/Casablanca` (+01:00, constant), `Asia/Amman`
  (+03:00, constant), `Asia/Kathmandu` (+05:45, constant), `Pacific/Kiritimati` (+14:00, constant).
  Controls exist so a DST failure is attributable to the transition, not to a general offset drift.

| IANA zone           | UTC offset (mid-2026) | DST in 2026           | Role in Studafy                                       |
| ------------------- | --------------------- | --------------------- | ----------------------------------------------------- |
| America/New_York    | -04:00 (EDT)          | yes (Mar 8 / Nov 1)   | school & recipient tz; primary RTL-safe digest anchor |
| America/Los_Angeles | -07:00 (PDT)          | yes (Mar 8 / Nov 1)   | school tz (west-coast cohort)                         |
| Europe/London       | +01:00 (BST)          | yes (Mar 29 / Oct 25) | school tz (UK cohort)                                 |
| Europe/Berlin       | +02:00 (CEST)         | yes (Mar 29 / Oct 25) | school tz (EU cohort)                                 |
| Africa/Casablanca   | +01:00                | **no** (control)      | default school tz, default anchor                     |
| Asia/Amman          | +03:00                | **no** (control)      | school tz (Middle-East cohort)                        |
| Asia/Kathmandu      | +05:45                | **no** (control)      | recipient tz (odd half-hour offset)                   |
| Pacific/Kiritimati  | +14:00                | **no** (control)      | recipient tz (date-line control, furthest ahead)      |

## 2026 DST transition dates

| Event          | America/New_York                  | America/Los_Angeles               | Europe/London                     | Europe/Berlin                      |
| -------------- | --------------------------------- | --------------------------------- | --------------------------------- | ---------------------------------- |
| spring-forward | 2026-03-08 02:00 EST -> 03:00 EDT | 2026-03-08 02:00 PST -> 03:00 PDT | 2026-03-29 01:00 GMT -> 02:00 BST | 2026-03-29 02:00 CET -> 03:00 CEST |
| fall-back      | 2026-11-01 02:00 EDT -> 01:00 EST | 2026-11-01 02:00 PDT -> 01:00 PST | 2026-10-25 02:00 BST -> 01:00 GMT | 2026-10-25 03:00 CEST -> 02:00 CET |

## Attendance correction deadline (48 h absolute window anchored to school-local midnight)

Production anchor — `apps/api/src/modules/attendance/corrections/correction-service.ts`
(`sessionWindowDeadline` / the `in_window` predicate): the deadline is

    session_date::timestamp AT TIME ZONE COALESCE(settings.timezone, 'Africa/Casablanca')  -- local midnight of session_date
    + make_interval(hours => COALESCE(window_hours, 48))

Because Postgres adds `make_interval(hours => 48)` (not `days => 2`), the 48-hour deadline is
_always_ exactly 172 800 000 ms of wall time **regardless of DST**: the anchor lands on the _same
absolute instant_ whether a transition sits inside the window or not. A naive "local midnight + 2
calendar days" reader is the bug this catalog guards against. The expected instants in this repo are
pinned to a Postgres-computed deadline. The suite asserts, per zone and per anchor date:

- `in_window(deadline - 1s)` is `true`; `in_window(deadline)` is `false` — the flip is at the
  absolute instant, and DST only changes the _wall-clock label_ the sweep would print.

Control rule: on a non-DST school (Africa/Casablanca, Asia/Amman, Asia/Kathmandu,
Pacific/Kiritimati) the local wall deadline is exactly `0000 two days later`; on a DST school it is
`0100` (spring: EU/NY) or `2300` (fall: NY; 0100 Berlin spring; 2300 London fall) — those are the
honest assertions.

## Notification digest date labels

Parent digest (`apps/workers/src/queues/notifications/email/notification-digest-producer.ts`) labels
each recipient digest with the recipient's **own local date**:

    (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(user_settings.timezone, school_settings.timezone, 'UTC'))::date::text

Defaults, in order: the recipient's own timezone, then their school's, then UTC. Parent digest
(`digest-producer.ts`) uses `CURRENT_TIMESTAMP AT TIME ZONE <school timezone>` (school local) and
meets the same rules. Both land in the recipient's/school's _local_ calendar day, so a date line
that crosses midnight in a far-ahead zone (Kiritimati, Kathmandu) is assigned the local day, and a
DST transition does not shift the label's input instant off the intended local day.

**Documented divergence (cite, don't quietly fix):** the _parent_ digest date frame is the parent's
school-local date; the _recipient_ digest date label is the recipient-local date (which can differ
for a recipient in a different zone than their school). Tests for the two labels assert both sides,
so the contract evolves if the divergence is ever reconciled — it is not hidden.

## RTL / locale rendering

- Finance report envelope (`apps/api/src/modules/finance/reports/service.ts`, `reportEnvelope`)
  sets `presentation.direction` to `"rtl"` when the resolved locale is `ar`, else `"ltr"`.
- Notification/report template rendering is RTL via the returned direction flag and the `ar`
  template set; assertions check the envelope direction and that `ar` renders with no unresolved
  `{var}` placeholders for the template types the catalog lists as RTL-enabled.

## Where these expectations are enforced (must exist; linked from each suite)

| Suite                                                                              | Layer       | Zone                                                                            | What it pins                                                                  |
| ---------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/api/tests/tz-locale/attendance-correction-deadline.test.ts`                  | api, DB     | NY/Berlin/London spring+fall, Casablanca/Amman/Kathmandu/Kiritimati control     | 48 h absolute deadline; flip at -1s/+0s                                       |
| `apps/api/tests/tz-locale/digest-label-date.test.ts`                               | api, DB     | per-recipient NY/Berlin/London spring+fall + Kiritimati/Kathmandu + default-UTC | local-date label for digest + parent frame; divergence documented             |
| `apps/api/tests/tz-locale/scheduled-announcements-dst.test.ts`                     | api         | announcement `scheduled_at` future-clamp across DST                             | absolute instant preserved across DST; future stays scheduled, past publishes |
| `apps/api/tests/tz-locale/locale-rtl.test.ts`                                      | api, pure   | ar vs en/others                                                                 | reportEnvelope direction; ar render with no unresolved placeholders           |
| `apps/workers/src/queues/notifications/email/notification-digest-producer.test.ts` | workers, DB | recipient tz fallback chain (user -> school -> UTC)                             | existing suite; catalog extends it with spring/fall cases in each DST zone    |

Cron/scheduler anchors are all `tz: "UTC"` (see `apps/workers` `*-scheduler.ts`), so sweep timing
never depends on a local wall clock; DST affects only _labels_ and _deadline instants_, both of
which the suites above assert at the fixed instants.
