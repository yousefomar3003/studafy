# Student AI programme: upload consistency

Phase 4 (measurement, upload part) of "Student AI seats bundled with tuition, plus revenue share"
(decision 10). The content bonus depends on how consistently teachers upload. This page says how that
is measured. Settings and tiers are in [ai-programme.md](ai-programme.md).

**Upload consistency** is the percentage of school days on which a lesson or material was published
for a class, averaged across the classes that have Student AI.

## The rule

- **School days** are the school's teaching weekdays (`school_settings.school_days`, 000122) minus
  every day a calendar holiday covers (`school_events` with kind `holiday`, `starts_on`..`ends_on`).
  Other calendar entries (events, meetings, exam periods) are school days. Days after today never
  count.
- **Which day:** the school's timezone (`school_settings.timezone`) decides. A material published at
  21:30 UTC on Wednesday counts for Thursday in Dubai.
- **A class's days** are the school days in the period that also fall inside its term
  (`classes.term_id`).
- **Uploaded on a day:** a class counts as having uploaded on a school day when a class material
  for it was first published that day (`materials.published_at`, stamped by
  `trg_materials_published` the first time a material becomes ready, 000228). There is no separate
  lessons table: lessons are class materials placed in a week and day (000226). Students' own AI
  sources (`source_kind = 'personal'`) and assignment AI sources (`'assignment'`, 000232) never
  count. An upload on a weekend or holiday counts for nothing. A material that is never published
  (still scanning, or failed) doesn't count either.
- **Classes that have Student AI:** `studentAiClassIds` in
  `packages/billing/src/ai-revenue-share/upload-consistency.ts` is the only definition (the API's
  views and the revenue share engine, in the API and the workers' hourly job, all read through it).
  A class qualifies when at least one of its students did all of the following at some point in the
  period:
  - was in the class (enrolment active or completed, or withdrawn during or after the period);
  - held a Student AI programme opt-in (phase 2, `app.ai_optins`) whose months overlap the period
    (start month to last month, or to the month before a release takes effect);
  - held that opt-in's licence seat in the period (assigned before the period ended and not
    unassigned before it started; an opt-in still waiting for a seat does not count);
  - on a licence whose dates overlap the period and that was taken up (not a draft, not cancelled).
    It need not be activated yet: a licence's first payment is what activates it, and that payment's
    share measures the very period it pays for.

- **Rounding** always goes down, so a bonus tier is never shown before it is reached. A class's value
  is floor(upload days × 10000 / school days) in basis points. A teacher's value, and the school's,
  is the floor of the mean of their classes' basis points. A class with no school day in the period
  is listed with `null` and left out of every mean.
- **Teachers of a class** are its lead teacher plus anyone teaching it on an approved timetable. Draft
  and pending timetables don't count.

## Code

- Pure counting, with no database and no clock: `computeUploadConsistency`, `schoolDaysBetween` and
  `contentBonusStanding` in `packages/license-pricing/src/upload-consistency.ts`.
- Reads, in `apps/api/src/modules/licensing/upload-consistency.ts` (views) and `packages/billing/src/ai-revenue-share/upload-consistency.ts` (the read). They use the armed school, and
  work as studafy_app for a school admin or principal, or as studafy_admin scoped to the school:
  - `uploadConsistency(tx, { from, to })` returns the school's figure, rows per class
    (`schoolDays`, `uploadDays`, `consistencyBps`, teachers) and rows per teacher. It takes any date
    range, which is what the revenue share engine needs for the school days a payment covers.
  - `currentUploadPeriod(tx, license)` is "the current period to date": from the current licence's
    first day to today, or to its last day once it has ended. With no licence, it runs from the start
    of the academic year that contains today.
  - `uploadConsistencyBonus(tx, bps, license)` and `contentBonusTiersFor(tx, stamp)` give the
    content-bonus tier a percentage falls in, using the values the licence was signed with. With no
    licence, they use the school's current values. They also return the next tier, and the lowest
    tier that pays (`targetBps`, the "below target" line for principals). They show the tier only,
    never an amount. The tiers come from the core resolver `resolveAiProgrammeValues`, not
    `resolveAiProgrammeStamp`, which also looks up the super admins' names in their own school and
    so is for platform views only.
  - `uploadConsistencyView(tx, period | null)` is what the routes return: the report, how the
    period was chosen (`basis`), and the bonus tier.
- Index `idx_materials_school_class_published` (migration 000236), a partial index on published
  class materials. With it, reading the upload days is one range scan.
- No snapshot table. The read is that index scan plus a calendar of a few hundred days, cheap enough
  to run on every request. The revenue share engine (phase 5) records the percentage it used with
  each share, so nothing here needs freezing. Live reads also mean a material that is uploaded and
  then deleted stops counting.

## Routes (read-only)

| Route                                                                  | Who                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /api/school/license/upload-consistency?from&to`                   | `license:read` (ORG_ADMIN, PRINCIPAL), own school only |
| `GET /api/platform/schools/{schoolId}/ai-programme/upload-consistency` | `platform:read` (super admin), web channel, any school |

`from` and `to` (YYYY-MM-DD, inclusive, at most 400 days apart) must be given together. Without them,
the routes measure the current period to date. Both routes return `UploadConsistency`. There is no
UI yet; the phase 6 dashboards will read it.
