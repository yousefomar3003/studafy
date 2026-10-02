# Children's data dossier

How Studafy handles personal data of students who are children: the lawful basis it relies on,
what it collects, how long it keeps it, why it shows no ads, and why the app has no age screen.
ST-309 produced this page. The store answers that follow from it are in
[`store-audience-and-age-ratings.md`](store-audience-and-age-ratings.md).

Engineering wrote this page, not counsel. Every fact about the product was checked against the code
at commit `3d5f0fa0` on 2026-10-02 and names its source. Every legal conclusion is a working
position that counsel must confirm in [Counsel review](#counsel-review). Until a counsel row there
is signed, nothing here is a legal opinion.

The full data map (each data type, destination and store-form answer) is in
`apps/mobile/store/privacy-labels.md`, and the per-SDK audit is in
`apps/mobile/docs/sdk_compliance_inventory.md`. This page covers only what is specific to children
and does not repeat either one.

## How a child gets an account

1. An adult registers the school at `/onboarding` (`apps/api/src/modules/tenancy/registration`).
2. A school admin creates student records, one at a time (`CreateStudentModal.tsx`) or by CSV import
   (`packages/student-import`). The admin then invites each user by email, one at a time or in bulk
   (`POST /api/invitations`, `apps/api/src/modules/auth/invitation`), at the address the school
   entered.
3. The student accepts the invitation by signing in with Google or Microsoft
   (`apps/api/src/modules/auth/invitation`). Later sign-ins match the identity provider's `sub` to
   that account.

There is no public sign-up in the app or on the web for students, parents or teachers. A child
cannot create an account. The school decides who has one and which role it gets (student, parent,
teacher or an admin role). A student may be any school age. The app does not know a student's age
and never asks for it.

## Roles

| Party                                                                | Role                                                        | Basis in the code                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The school                                                           | Controller                                                  | `apps/api/src/modules/account/retention-policy.ts` states retention as "a legal obligation of the school as controller" |
| Studafy                                                              | Processor                                                   | Processes student data only for the school's account                                                                    |
| AWS (`eu-central-1`, Frankfurt; `infra/terraform/environments/prod`) | Sub-processor: hosting, database, file storage, email (SES) |                                                                                                                         |
| Google Firebase                                                      | Sub-processor: push notifications, crash reports            | `sdk_compliance_inventory.md`                                                                                           |
| Sentry                                                               | Sub-processor: crash and performance reports                | `sdk_compliance_inventory.md`                                                                                           |
| Anthropic                                                            | Sub-processor: AI study tools, called by the API only       | `apps/mobile/docs/ai_data_sharing_consent.md`                                                                           |
| Stripe, Tap                                                          | Payment processors for parent payments, on their own pages  | `docs/store_payment_routing.md`                                                                                         |
| Cloudflare Turnstile                                                 | Captcha on the public deletion page                         | `docs/modules/account-deletion.md`                                                                                      |

ERPNext runs on Studafy's own infrastructure (`infra/terraform/modules/erpnext`). It holds invoices
that identify a student by admission number. It is not a separate sub-processor.

## Lawful basis

**Studafy operates in Jordan only.** The business confirmed this on 2026-10-02. Store distribution
is limited to Jordan to match
([store answers](store-audience-and-age-ratings.md#countries-and-regions)). Production data is
hosted outside Jordan, in AWS `eu-central-1` (Frankfurt). Firebase, Sentry and Anthropic process
data in the United States.

**Jordan: Personal Data Protection Law No. 24 of 2023.** Engineering's working position, which
counsel must confirm or replace:

- The school is the controller. It holds student records under its legal duties as a school.
- Studafy processes those records only on the school's instructions, under a written agreement with
  each school.
- Where the law requires consent and the student is a minor, the consent comes from the parent or
  guardian, and the school collects it. Studafy never relies on a child's own consent as the legal
  basis.

Questions counsel must answer for Jordan:

1. At what age, if any, can a student consent for themselves?
2. Which processing purposes do the school's legal duties cover, and which need a guardian's
   consent? The AI study tools are the main case. See
   [Where the school's basis may not reach](#where-the-schools-basis-may-not-reach).
3. Which transfer condition or approval covers hosting in Germany and processing in the United
   States?
4. Does the law treat children's data as a special category with extra duties?
5. Does Studafy, as processor, have any registration, notification or breach-reporting duty of its
   own?

### Before expanding beyond Jordan

A school outside Jordan, or wider store availability, needs a counsel-reviewed row for that country
first. Engineering's starting positions for the two regimes the ticket names:

| Regime                                                         | Working position                                                                                                                                                                                                                                                                                                                                  | What it would require of Studafy                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COPPA (16 CFR Part 312), under 13. FERPA for education records | **School authorization.** A school may consent in place of parents when the data is used only for the school's educational purpose and for no other commercial purpose (FTC COPPA FAQ, section N). The FTC's 2025 amendments did not codify this exception, so it still rests on that guidance. Under FERPA, Studafy would be a "school official" | Direct notice to the school. Use only for the school. School review and deletion of a student's data. A written retention policy in the online notice (§312.10, as amended in 2025). A written information security program (§312.8)           |
| GDPR and UK GDPR, including Art. 8 ("GDPR-K")                  | **Art. 8 does not apply.** It covers a child's own consent to a service offered directly to that child. Studafy is not offered directly to children and does not rely on a child's consent. The school is controller and chooses its own basis. Studafy processes under an Art. 28 contract                                                       | An Art. 28 contract. Art. 32 security. Information for the school's DPIA (Art. 35). A transfer mechanism for sub-processors outside the EEA or UK. In the UK, counsel to confirm whether the Age Appropriate Design Code reaches the AI add-on |

### Where the school's basis may not reach

These are the places where Studafy does something beyond running the school's own records. Counsel
must decide each one before the working position above can be relied on.

1. **AI study tools.** A student, of any age, agrees to the AI disclosure themselves
   (`ai_data_sharing_consent.md`). That modal is the Apple 5.1.2(i) disclosure. It is not verifiable
   parental consent, and the API has no parental-consent step. The data goes to Anthropic as a
   service provider. Question for counsel: does the school's basis cover AI processing, given that
   the school must have the AI feature active, or is a guardian's consent needed for minors?
2. **The AI add-on is a paid product for individual students.** It is bought on the web at
   `/account/ai`, and the route accepts **student** sessions as well as parent sessions
   (`apps/web/src/app/routes.tsx`, ST-208). A child can reach that purchase page, with no age check.
   Question for counsel: should checkout be restricted to parent accounts? Could a parent's purchase
   be the point where a guardian's consent to the AI processing is collected? That would need a
   notice to the parent at checkout, which does not exist today.
3. **The "AI Study Assistant isn't active" screen.** Students without the add-on see a list of the
   add-on's benefits (`ai.notActive` in `assets/translations/en.json`). There is no price, link or
   button (ST-304). It is a first-party feature state, not a third-party ad. Question for counsel and
   for the Play listing: is a list of a paid feature's benefits, shown to children, promotional
   content?

## Data minimisation

What the school records about a student (`app.students`, migration `000008`): first, middle, last
and preferred name, admission number, admission date, school email, parent links and, optionally,
date of birth and nationality. Then the education records staff enter: grades, attendance and
discipline incidents.

- **Date of birth and nationality are optional** (nullable) and drive no feature. They appear only
  in the admin web student profile and the CSV import. No code computes an age. If no school needs
  them, removing them is the simplest minimisation available.
- **The app never asks for an age, phone number, location, contacts or photo library**, and requests
  no permission that would give it access to them (`privacy-labels.md`, "Not collected").
- **No advertising or tracking identifier is read.** The AAID permission is stripped, and there is
  no IDFA and no App Tracking Transparency prompt (`sdk_compliance_inventory.md`).
- **No push token before sign-in.** FCM auto-init is off, so no token exists while a user's age is
  unknown (ST-307).
- **Crash reports carry an opaque user ID**, never a name or email (`sendDefaultPii = false`).
- **AI requests carry no name, email, grades or attendance.** They carry the question, the material
  text and, unless zero retention is configured, the opaque user ID (`ai_data_sharing_consent.md`).
- **The device cache is cleared on sign-out**
  (`apps/mobile/lib/src/core/offline/offline_providers.dart`).

## Retention

Personal data must not be kept longer than its purpose needs. COPPA's 2025 amendments would also
require this schedule to be published if Studafy expands to the United States. The schedule as
built is below. "Enforced" means code removes or redacts the
data on that schedule today. Rows that are not enforced are open items, not policy.

| Data                                                    | Retention                                                                                                                             | Enforced by                                                                                    | Enforced                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Account and profile (`users`, `students`, parent links) | While the school keeps the account. Erased within 30 days of account deletion. On school closure, exported, held 30 days, then erased | `account-deletion-service.ts`; `closure-sweep.ts` (`CLOSURE_ERASURE_RETENTION_HOLD_DAYS = 30`) | Yes. Erasure redacts personal columns in place (`retention-registry.ts`)                         |
| Sessions, devices, OAuth identities                     | Until sign-out, revocation or erasure                                                                                                 | Erasure hard-deletes `refresh_tokens`, `user_devices`, `oauth_identities`                      | Yes                                                                                              |
| Grades and attendance                                   | Kept after erasure with personal columns redacted, for the period the school's education authority sets                               | Redaction, not deletion                                                                        | Partly. No per-school retention period exists, so pseudonymised rows are never deleted           |
| Financial records (Studafy and ERPNext)                 | Legal hold under tax and accounting law                                                                                               | `LEGAL_HOLD_TABLES`                                                                            | No end date is encoded                                                                           |
| Audit log                                               | Legal hold, to demonstrate compliance (Art. 5(2))                                                                                     | `LEGAL_HOLD_TABLES`                                                                            | No end date is encoded                                                                           |
| Ask AI history (`ai_messages`)                          | 90 days (`expires_at`, `AI_ASK_MESSAGE_RETENTION_DAYS`)                                                                               | `ai-message-retention-sweep.ts`, daily at 08:45 UTC, calls `app.delete_expired_ai_messages()`  | Yes, from the first worker deploy that includes ST-309. Before that, nothing called the function |
| AI message text, submission text, uploaded files        | Should follow the account                                                                                                             | —                                                                                              | **No.** Erasure does not reach them (ST-301 known gap, `docs/modules/account-deletion.md`)       |
| Student import staging                                  | 48 hours if not confirmed                                                                                                             | `abandoned-import-sweep.ts`                                                                    | Yes                                                                                              |
| DSR export bundles                                      | Not defined                                                                                                                           | —                                                                                              | **No.** They are never purged (`docs/security/data_retention_and_dsr_policy.md`)                 |
| AI inputs held by Anthropic                             | Per Anthropic's API terms. Zero retention only under a workspace agreement with `AI_LLM_ZERO_RETENTION=true`                          | `docs/runbooks/anthropic-provider-config.md`                                                   | Defaults to `false`. Whether an agreement exists is not recorded                                 |
| Crash and diagnostic events (Firebase, Sentry)          | Each vendor's configured retention. Not deleted per user                                                                              | Vendor settings                                                                                | Record the configured values in the console checklist                                            |
| Device cache                                            | Until sign-out                                                                                                                        | `apps/mobile/lib/src/core/offline/offline_providers.dart`                                      | Yes                                                                                              |

## Advertising

No ads are shown to anyone, children included.

- **Mobile.** No ads, analytics or attribution SDK is resolved, transitive dependencies included
  (`test/store_compliance/child_directed_sdks_test.dart`). The iOS privacy manifest declares no
  advertising purpose (`privacy_declarations_test.dart`). Play's Ads declaration is "No"
  ([store answers](store-audience-and-age-ratings.md#ads)).
- **Web.** No analytics or ads vendor is loaded. `apps/web/src/lib/analytics/track.ts` writes
  events only to a `window.dataLayer` that something else has already created, and nothing creates
  one. Adding a tag manager or analytics vendor to pages students use would contradict this section,
  so it needs a review against this page first.
- **No sale and no sharing for advertising.** The privacy policy says so
  (`apps/web/src/routes/legal/PrivacyPolicyPage.tsx`), and no code sends data to an advertising
  destination.

The AI-not-active benefit list is the one borderline surface. See item 3 under
[Where the school's basis may not reach](#where-the-schools-basis-may-not-reach).

## Age screen

**Decision: no age screen, because nothing branches on age.**

The rules:

- Google Play's Families policy requires a neutral age screen when an app that targets both children
  and older users behaves differently by age, for example showing ads only to adults.
- Apple guideline 5.1.4 allows asking for a date of birth only to comply with child-privacy law.
- The FTC (COPPA FAQ) requires any age screen to be neutral: no default value, no hint of which
  answer unlocks the app, and no easy way to go back and change the answer.

The facts:

- No app code asks for, stores or reads an age or date of birth. The generated API models include
  the admin student-profile schema, but no screen uses its `dateOfBirth`.
- No API code computes an age, and no route branches on one. Role decides what a user sees, and the
  school assigns the role.
- Every student sees the same features regardless of age, and there are no ads to switch on or off.

An age screen would therefore collect data the app does not need. It also could not be trusted,
because the school, not the user, creates the account.

**The guard.** `apps/mobile/test/store_compliance/age_branching_test.dart` fails when app code
outside the generated client reads a date of birth or adds an age-gate identifier. If it fails, the
change must:

1. Add a neutral age screen before any age-dependent behaviour, following the rules above.
2. Re-answer [`store-audience-and-age-ratings.md`](store-audience-and-age-ratings.md).
3. Update this section.

The test covers the mobile app only. Server-side age logic would be a new API branch, so review it
against this section.

## Open items

| #   | Item                                                                                                                                                                                                                                                                     | Owner                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1   | Answer the Jordan questions in [Lawful basis](#lawful-basis), then review and sign this dossier                                                                                                                                                                          | Counsel                               |
| 2   | **No school agreement is in the repository.** Each school needs a written agreement that gives notice of collection, use and disclosure, names the sub-processors, limits use to the school's purpose, covers transfers outside Jordan, and sets deletion on termination | Counsel                               |
| 3   | **The privacy policy has no children's section and no retention schedule**                                                                                                                                                                                               | Counsel, then `PrivacyPolicyPage.tsx` |
| 4   | Close the erasure gaps: AI message text, submission text and S3 files (ST-301), and DSR export bundles (ST-268)                                                                                                                                                          | Engineering                           |
| 5   | Set end dates for audit-log and financial-record retention, and decide whether grades and attendance need a per-school period                                                                                                                                            | Counsel, then engineering             |
| 6   | Decide the three items under [Where the school's basis may not reach](#where-the-schools-basis-may-not-reach)                                                                                                                                                            | Counsel and product                   |
| 7   | Decide whether production runs with Anthropic zero retention, and record the agreement                                                                                                                                                                                   | Product and counsel                   |
| 8   | Vendor settings from ST-307: Sentry "Prevent Storing of IP Addresses", Firebase data-processing terms. Record each vendor's crash-data retention                                                                                                                         | Console owner                         |
| 9   | Decide whether date of birth and nationality are needed at all (see [Data minimisation](#data-minimisation))                                                                                                                                                             | Product                               |

## Counsel review

The acceptance criterion "reviewed by counsel" is met only when the Jordan row below is filled in.
Add a row before operating in any other country.

| Jurisdiction | Reviewer | Date | Outcome | Changes required |
| ------------ | -------- | ---- | ------- | ---------------- |
| Jordan       |          |      |         |                  |
