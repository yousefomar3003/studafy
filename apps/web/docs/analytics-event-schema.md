# Analytics event schema

Privacy-respecting product analytics for the web app: the school registration funnel, the
invite-to-activation funnel, and feature-adoption events. The moving parts:

| Layer         | File(s)                                     | Responsibility                                                      |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| Tracker       | `src/lib/analytics/track.ts`                | `track(event, props?)` — the one call site every event goes through |
| Event catalog | `src/lib/analytics/events.ts`               | Canonical event name constants, grouped by funnel                   |
| Barrel        | `src/lib/analytics/index.ts`                | What call sites import: `track` plus the event constants            |
| PII lint      | `packages/config/rules/no-analytics-pii.js` | Static check that flags PII-shaped fields passed to `track()`       |

## No vendor wired in yet

`track()` pushes `{ event, ...props }` onto `window.dataLayer` when a consumer has put one there —
the standard GTM/GA4 convention — and otherwise logs to the console in dev. No analytics vendor
(GA4, PostHog, Segment, ...) is wired into the app itself; that is a deploy-time concern (load the
vendor's snippet, which creates `window.dataLayer` and drains it) that can be added without any
call site here changing. In staging, wiring up a vendor against this same event stream is what
turns the funnels below into dashboards.

## Naming convention

`<domain>_<subject>_<verb, past tense>`, snake_case, one flat namespace across all three funnels:

- `registration_*` — the public school self-registration flow (`/onboarding`).
- `activation_*` — invitation verification through the post-activation setup wizard
  (`/invite/:token`, `/invite/:token/complete`, `/onboarding/setup`).
- `feature_used` — one event for all feature adoption; a `feature` property distinguishes which
  capability fired it, rather than minting a new event name per feature.

The event name itself never carries PII — no emails, names, or other identifiers embedded in the
string. Properties follow the same rule; see [PII policy](#pii-policy) below.

## Registration funnel

| Event                                        | Fires when                                                               | Properties                |
| -------------------------------------------- | ------------------------------------------------------------------------ | ------------------------- |
| `registration_started`                       | `/onboarding` mounts                                                     | —                         |
| `registration_step_completed`                | The school-details step is submitted and passes validation               | `step: "school"`          |
| `registration_submitted`                     | The admin-contact step submits, just before `POST /api/schools/register` | —                         |
| `registration_succeeded`                     | `POST /api/schools/register` succeeds                                    | —                         |
| `registration_failed`                        | `POST /api/schools/register` fails                                       | `reason: <ApiError.code>` |
| `registration_verification_resend_requested` | The admin clicks "resend verification email"                             | —                         |
| `registration_verification_resend_succeeded` | `POST /api/schools/resend-verification` succeeds                         | —                         |

## Activation funnel

From invitation link to a working, configured account.

| Event                                | Fires when                                                            | Properties                          |
| ------------------------------------ | --------------------------------------------------------------------- | ----------------------------------- |
| `activation_invitation_viewed`       | `/invite/:token` verifies the token successfully                      | —                                   |
| `activation_invitation_invalid`      | `/invite/:token` fails to verify (expired, revoked, consumed, ...)    | `reason: <ApiError.code>`           |
| `activation_oauth_started`           | The admin clicks a provider button to start the invitation OAuth flow | `provider: "google" \| "microsoft"` |
| `activation_succeeded`               | `/invite/:token/complete` recovers an authenticated session           | —                                   |
| `activation_admin_approval_required` | The OAuth identity's email diverged from the invitation's bound email | —                                   |
| `activation_setup_step_completed`    | A setup-wizard step (`/onboarding/setup`) is completed                | `step: <StepId>`                    |
| `activation_setup_step_skipped`      | A setup-wizard step is skipped                                        | `step: <StepId>`                    |
| `activation_setup_completed`         | The last setup-wizard step is completed or skipped                    | —                                   |

`StepId` is one of `school-profile`, `academic-year`, `grading-scheme`, `timetable`, `staff`,
`students` (`src/routes/onboarding-setup/progress.ts`) — a fixed, non-personal enum, safe as an
event property.

## Feature adoption

One event, `feature_used`, fires every time a school engages a core capability — first use and
every use after; a funnel/dashboard tool computes "first touch per school" from the timestamp
ordering, so the client doesn't need to track "is this the first time" itself.

The setup wizard is where a school first adopts each of the capabilities below, so its step
completions double as that feature's adoption signal (`SETUP_WIZARD_FEATURES` in `events.ts` maps
`StepId` to the `feature` value):

| `feature` value     | Adopted via                |
| ------------------- | -------------------------- |
| `school_profile`    | The school-profile step    |
| `academic_year`     | The academic-year step     |
| `grading_scheme`    | The grading-scheme step    |
| `timetable`         | The timetable step         |
| `staff_invitations` | The staff-invitations step |
| `student_import`    | The student-import step    |

## PII policy

Event payloads carry only IDs, enums, counts, and booleans — never an email, name, phone number,
free-text field, or anything else that identifies a person. `AnalyticsProps` is typed as
`Record<string, string | number | boolean | null | undefined>` — a shape constraint, not a content
one, so `studafy/no-analytics-pii` backs it with a static check: any `track()` call whose payload
has a property keyed on (or referencing a variable named) `email`, `phone`, `name`, `address`,
`token`, and similar PII-shaped roots is a lint **error**, repo-wide.

The lint is best-effort — it inspects literal object properties and simple identifier/member
references, not values it can't see statically (a spread, a value computed by an opaque function).
It catches the common mistake (`track(EVENT, { email: values.email })`) at author time; it is not a
runtime payload scanner. When in doubt, pass an ID or an enum, not the field a form collected.

If a future event genuinely needs a free-text-shaped property that isn't personal data, don't
disable the rule — rename the field so the lint's word list stops matching, or add the specific
false positive to `PII_ROOTS`'/`PII_COMPOUND_WORDS`' exceptions in
`packages/config/rules/no-analytics-pii.js`, since a silenced call site is invisible to the next
person who copies it.
