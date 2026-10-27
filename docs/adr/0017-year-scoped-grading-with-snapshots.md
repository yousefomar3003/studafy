# ADR-017: Year-scoped grading configuration, grade-level inheritance and result snapshots

## Status

Accepted

## Context

Schools configure subjects and grading rules per grade, run several sections of each grade, change
their rules from one year to the next, and issue certificates that must never change after the
fact. The class gradebook (000013) stored flat `label/score/max/weight` rows per class, ignored its
own category weights when calculating, excluded missing marks silently, and computed published
grades from whatever the current scheme was. That cannot produce a certificate a school can stand
behind.

## Decision

- **Configuration lives at the grade, per academic year.** A subject config with no section is the
  grade default; sections read it live. A section that differs gets its own override row. Overrides
  record the default revision they were forked from, so a changed default is surfaced as "outdated",
  never applied to or lost from the override.
- **One calculation engine.** `@studafy/grading-engine` is pure TypeScript with no I/O. The API's
  previews, finalization and corrections, the web app's live validation, reports and certificates all
  call it. No other code computes a percentage from marks.
- **Missing is not zero.** An unmarked mandatory assessment makes a result incomplete unless the
  school explicitly sets a zero policy. Incomplete results carry no grade, no pass/fail and no
  certificate.
- **Finalized results are immutable snapshots.** Each stored subject result carries the full engine
  configuration it was computed with (JSONB, approved in the RLS flexible-column allowlist). Grants,
  triggers and a mark lock keep it that way; a correction recomputes with the snapshot and writes a
  new version. Certificates store their rendered content and can only be superseded or revoked.

## Alternatives considered

- **Copy grade configuration into every section.** Simple reads, but every grade-level change must
  be fanned out and reconciled against customizations — exactly the silent-overwrite risk this
  design avoids. Rejected.
- **Version every configuration edit as a new immutable row (append-only, like `grading_schemes`).**
  Gives history for free but makes every edit re-point assessments and marks. Snapshots at
  finalization give the guarantee that matters (historical results never change) without that cost.
- **Extend the class gradebook.** Its rows have no link to assessments or categories, and classes are
  per term while subjects are graded per year. Retrofitting would change the meaning of existing
  published grades. Rejected; it remains for class-level grading.

## Consequences

- Teachers may grade through an explicit section/subject assignment or through the classes they
  already teach; `can_read_subject`/`can_read_student` were widened accordingly.
- Snapshot JSONB is deliberate denormalization; the reported figures remain normalized columns.
- See [academic-grading.md](../database/academic-grading.md) for formulas and the data model.

## Review

Pending review.
