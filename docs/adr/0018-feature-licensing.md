# ADR-018: Paid features as code-registered keys, granted through tiers and resolved per person

## Status

Accepted

## Context

Studafy sold one paid product, the per-student AI add-on: one row per student in
`app.ai_subscriptions`, checked by one gate in front of `/api/ai/*` (ST-155). The product now needs
many paid features (AI tutor, study tools, notebook, auto grading, Family+), sold to students,
teachers and parents, both personally (in-app and web purchases) and to schools as seat-based
licenses paid by bank transfer. A person can hold several of these at once: a personal subscription
and a school seat, say.

Adding each feature must not need a migration, a billing change or an admin-page change, and the
AI add-on's existing subscribers must keep exactly the access and quota they have.

The full plan, the product decisions and the session plan are in
[docs/billing/feature-licensing.md](../billing/feature-licensing.md).

## Decision

- **A feature is a key in code.** `FEATURES` in `packages/constants/src/features.ts` holds each
  feature's audience, usage unit, default monthly limit and i18n key. `app.features` (000161) holds
  only what the super admin edits (display name, status) and is synced from the code list at API boot,
  insert-only.
- **Tiers are plans.** `app.plans` gains `audience`, `rank` and `includes_all_features`;
  `app.plan_features` holds `(tier, feature, monthly_limit)`. A tier with `includes_all_features`
  includes features registered after it at their code default. The `ai_addon` plan becomes the first
  student tier, with unlimited units.
- **Grants, not products, decide access.** A person's grants come from adapters (`ai_subscriptions`,
  `user_subscriptions`, and license seats from session 2) in `apps/api/src/modules/features/grants.ts`.
  A pure resolver merges them: active when the school is active and some live grant's tier includes
  the feature; across grants, the highest limit and the latest period end, every source recorded.
- **One middleware enforces it.** `requireFeature(key, { meter })` refuses with
  `FEATURE_NOT_INCLUDED` / `FEATURE_EXPIRED` (402) or `FEATURE_LIMIT_REACHED` (429), and the school
  as before (403 `AI_SCHOOL_INACTIVE`). Units are counted per person per calendar month (UTC) in
  `app.feature_usage_meters` by one conditional upsert, so concurrency cannot pass a limit.
- **Grants ride the entitlement versions (ADR-014).** A new `user` entitlement subject and
  `userEntitlement.changed` event version a person's grants (`ent:usr:{userId}`), invalidated by the
  same pub/sub subscriber and outbox invalidator as the school and AI entries (000162 adds the
  invalidator's partial index, built concurrently).
- **The AI gate is replaced, its budget kept.** AI routes carry `requireFeature("ai_tutor" |
"study_tools")` and then `aiTokenBudget()`, which keeps the ST-155 Redis token budget keyed on the
  reported grant's billing window. For AI add-on subscribers that window, the budget and the hold sizes
  are unchanged; the AI routes keep their old refusal codes until the mobile app reads the new ones.

## Alternatives considered

- **A feature table as the source of truth** (features created in the admin console). Rejected: a
  feature is meaningless without code that implements and guards it, so the key must exist in code
  anyway; making the database authoritative would add a second registry that can drift from it.
- **Per-feature columns or per-feature subscription tables** (an `ai_subscriptions` per feature).
  Rejected: every new feature would need a migration and billing changes, which is what this system
  exists to avoid.
- **A separate `tiers` table** instead of extending `app.plans`. Rejected: plans already carry codes,
  display names, activity and multi-currency prices (`app.plan_prices`) synced to providers; a second
  table would duplicate all of it.
- **Grant-period usage windows** (reset at each billing renewal, as the AI token budget does).
  Rejected for units: a person can hold several grants with different periods and a license can run
  for years, so "monthly" has to mean the calendar month.
- **Versioning the catalog per school** so tier edits apply instantly. Rejected: the catalog is global
  and rarely edited; a 30-second per-process cache is enough, and grant changes -- which must be
  instant -- are versioned.
- **Changing the AI routes' error codes now.** Rejected: the installed mobile app maps
  `AI_SUBSCRIPTION_INACTIVE` to its paywall; the switch waits for the client update (session 6).

## Consequences

- A new paid feature is three code changes: registry entry, `requireFeature` on its routes, a client
  check of `GET /api/me/features`.
- Every writer of a grant must call `publishUserEntitlementChange` in its transaction, or the change is
  served stale for up to the cache TTL.
- Feature resolution runs with no acting user and maps students to users through two SECURITY DEFINER
  helpers (`app.student_user_id`, `app.user_student_id`), because the students table's role-scope
  policy hides students from a userless transaction.
- Each metered request writes one row in Postgres before its handler runs.
- `app.user_subscriptions` exists before anything writes it; purchases keep writing
  `app.ai_subscriptions` until a provider sells a tier.
- The `AI_REFUSAL_CODES` compatibility mapping must be removed once the minimum supported mobile
  version reads `FEATURE_*` codes.

## Review

Pending review (recorded 2026-10-27).
