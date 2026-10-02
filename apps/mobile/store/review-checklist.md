# Store review checklist

Pre-submission checklist for `apps/mobile`, covering both first-submission mechanics and the
specific review risks this app carries. Re-run this list before every store submission, not just
the first one — a change to `features/ai`, auth, monitoring, or permissions can silently invalidate
an earlier pass.

## Resolved blockers

Both were real submission blockers when this checklist was first written, and neither could be
closed by documentation alone. Both are now built; kept here as the record of what was missing and
what closed it, since the same gap is exactly the kind of thing that regresses silently if a future
refactor removes the entry point without anyone re-reading this file.

### 1. Account-deletion path (was: none anywhere)

Previously: no settings/profile screen in the mobile app, no deletion link on the web `/account`
page, and the only erasure mechanism (`POST /api/privacy/dsr`) was `PRIVACY_DSR_MANAGE`-gated —
admin-only, with no UI anywhere to trigger it.

Now:

- `POST /api/privacy/me/dsr` / `GET /api/privacy/me/dsr` (`apps/api/src/modules/privacy/routes.ts`)
  — bearer-authenticated only, no permission gate, files/lists a GDPR export or erasure request for
  the caller's own account. Reuses the same worker-drained queue an admin-filed request already
  used, so there's one erasure pipeline, not two.
- `POST /api/account/deletion` (`apps/api/src/modules/account`, ST-301) — what the in-app action
  calls: signs out everywhere, detaches from the school, stops AI billing, files the erasure and
  returns the completion date and retained-record list. See `docs/modules/account-deletion.md`.
- `/account/delete` (`apps/web/src/features/account/privacy/DeleteAccountPage.tsx`) — the in-app
  action: explains the consequences, confirms, files the erasure request, shows a pending request
  if one already exists instead of allowing a duplicate.
- `/legal/delete-account` (`apps/web/src/routes/legal/DeleteAccountInfoPage.tsx`) — public, no
  sign-in or app required, for Google Play's Data Safety URL field. Since ST-302 it performs the
  deletion itself: the visitor enters the account's email, gets a one-time link
  (`POST /api/account/deletion-requests`), and confirming on `/legal/delete-account/confirm` runs
  the same `POST /api/account/deletion` pipeline for every account on that address. Linked from the
  site footer and the privacy policy. See `docs/modules/account-deletion.md`.
- The mobile app's Profile tab (`apps/mobile/lib/src/features/shell/presentation/profile_tab_screen.dart`,
  every role) now carries a "Delete my account" action, opened in the system browser at
  `/account/delete` — a system-browser hand-off, never an in-app webview (it's on
  `docs/store_payment_routing.md`'s reviewed list of outbound launches).

Re-check before every submission: the Profile tab link still resolves, `/account/delete` and
`/legal/delete-account` are still reachable, and `POST /api/account/deletion` still requires only
authentication (a permission added here by mistake would silently break self-service deletion for
every role at once). `POST /api/account/deletion-requests` (and `/confirm`) must stay
unauthenticated — `deletion-request-routes.test.ts` pins that — and a request must actually deliver
the email in the target environment (SES out of sandbox, `FRONTEND_URL` set on the workers).

### 2. Privacy policy page (was: didn't exist)

Now published at `/privacy` (`apps/web/src/routes/legal/PrivacyPolicyPage.tsx`), public, no sign-in
required. Its content is grounded in `privacy-labels.md`'s data mapping in this same directory —
re-check both together when either changes, since they describe the same facts from two angles
(one for the store forms, one for the public reader).

**This is a working draft, not legal-reviewed final copy.** It's accurate to what the code actually
does as of when it was written, but a compliance/legal review should happen before a store
submission relies on it as the final policy text — same caveat any engineer-drafted privacy policy
carries regardless of how carefully it's sourced.

## Store account / release prerequisites (not this ticket's scope, but block "approved" regardless)

Per `docs/runbooks/mobile-release.md`'s Status section: no App Store Connect app record and no Play
Console app entry exist yet, and neither store has ever received a build. The listing content in
this directory can be finalized independently of this, but nothing can actually be *submitted*
until those exist and the first manual upload happens. Don't read a finished checklist here as "the
listing is live" — it means "the content is ready for whoever does that setup."

## Payment routing (digital vs. real-world)

Fully covered by `docs/store_payment_routing.md` (ST-304, which superseded the earlier R-07 review)
— don't duplicate its checklist here, use it directly. Summary: nothing digital (the AI add-on, the
school's Studafy plan) is sold in or linked to from the app — the unsubscribed AI state is a notice
with no button, link, price or "get it on the website" copy, and the server refuses every purchase
route to mobile sessions; the only payment hand-off is the school-fee invoice link, a real-world
service both stores exempt. Enforced by `test/store_compliance/payment_routing_test.dart` and the
API's `store-payment-channel.test.ts`.

## Third-party AI data sharing (Apple 5.1.2(i))

Covered by `docs/ai_data_sharing_consent.md` (ST-305). Every AI feature screen is behind a consent
modal naming Anthropic and each data category; the API refuses every model call without a recorded
consent (`403 AI_CONSENT_REQUIRED`); consent is withdrawn from AI tab → AI data sharing. Re-check the
modal copy against `apps/api/src/modules/ai/consent/disclosure.ts` whenever the provider or the data
sent changes (that change must also bump the disclosure version).

## Reporting and moderation of AI content (Apple 1.2, Play generative-AI policy)

Covered by `docs/runbooks/ai-content-moderation.md` (ST-306). Every Ask AI answer, quiz, flashcard
deck, and summary has an in-app Report (flag) action; reports land in the school's moderation queue
with 24 h / 48 h / 5 day response targets; a generation-side filter blocks prohibited output and
escalates child-safety matches to a human. The runbook's "Known gaps" section lists what is not
covered yet (key concepts, explanations, exam mode; non-English text) — re-read it before
answering a reviewer's question about moderation.

## Privacy label accuracy

`privacy-labels.md` holds the answers for both forms, the manifest inventory, and the open items.
`test/store_compliance/privacy_declarations_test.dart` keeps the manifest, the mapping and the URLs
in sync. Before each submission:

- [ ] `privacy-labels.md` has been re-derived from the current `pubspec.lock`, permissions and
      API calls, not copied from a prior submission. App Privacy and Data safety in both consoles
      match it field for field.
- [ ] Xcode → Product → Archive → Generate Privacy Report has been run on the build being
      submitted. Its contents match the App Privacy answers, and no SDK is listed with a
      required-reason API that nothing declares.
- [ ] Tracking is "No" on both forms.
- [ ] Deletion is "Yes" on both forms, with the Play URL set to
      `https://app.studafy.com/legal/delete-account`, not `/account/delete` (Play's reviewer has
      no session to reach the authenticated page).
- [ ] The privacy policy URL in both consoles is `https://app.studafy.com/privacy`, the same page
      the app opens from the login screen and the Profile tab.

## Permissions sanity check

- [ ] `AndroidManifest.xml` requests exactly: `INTERNET`, `RECEIVE_BOOT_COMPLETED` (push
      re-registration after reboot), `CAMERA`. No permission is requested that the app doesn't use.
- [ ] `Info.plist` declares `NSCameraUsageDescription` and nothing else — correct, since
      `image_picker` is used with `ImageSource.camera` only, never `ImageSource.gallery`
      (confirmed: no other `ImagePicker` call site in `lib/`). If gallery picking is ever added,
      `NSPhotoLibraryUsageDescription` must be added in the same change, or the build will crash on
      first gallery access on iOS — a common late-cycle rejection cause.
- [ ] `file_picker`'s document-picker flow needs no additional iOS usage-description string (it
      uses `UIDocumentPickerViewController`). `ios/Podfile` sets `Pod::PICKER_MEDIA = false` and
      `Pod::PICKER_AUDIO = false`, so the photo-library and music-library pickers, and their
      purpose-string requirements, are not compiled in. If a screen ever passes a `FileType` other
      than `any`, remove the matching flag and add its usage string in the same change.

## Metadata and screenshots

- [ ] `listing-metadata.md` content is final and within each field's character limit (re-measure;
      don't trust the counts in that file blindly after edits).
- [ ] Screenshot set captured per `screenshot-plan.md`, from seeded/demo data only — confirm no real
      student, grade, attendance, or financial data appears in any captured image before upload.
- [ ] Target audience, Ads, IARC and Apple Age Rating answers match
      `docs/compliance/store-audience-and-age-ratings.md`, and its submission record is filled in.
      `docs/compliance/childrens-data-dossier.md` has a signed counsel row for every operating
      country.
- [ ] Reviewer demo accounts provisioned and all four logins verified against the production API,
      and their App Review Notes / Play App-access entries filled in — see
      `docs/runbooks/app-review-access.md` (ST-303).
- [ ] Support URL and privacy-policy URL both resolve (load in a browser, return 200) before
      submission — a broken URL in either field is an automatic rejection on both stores.

## First-or-second-submission risk notes

Specific things reviewers on both platforms commonly flag on education apps with a paid add-on,
worth a deliberate look rather than assuming they're fine:

- **Apple 3.1.1/3.1.3, Google Play Payments (external purchase)** — covered above; this is the
  single most common rejection reason for an app in this shape. The first design (R-07) still
  linked to the web checkout and would have been rejected; ST-304 removed the link. Still worth a
  reviewer re-reading `docs/store_payment_routing.md`'s checklist item-by-item against the actual
  build being submitted, not just trusting the tests.
- **Sign in with a third-party IdP only (Microsoft/Google), no Apple option** — Apple's guideline
  4.8 requires offering Sign in with Apple *if* the app offers any other third-party login option
  and doesn't rely solely on the platform's own account system. `login_screen.dart` currently offers
  Microsoft and Google only. This needs an explicit decision: either add Sign in with Apple, or
  confirm an applicable exception (e.g., the app is exclusively for an organization's own employees/
  students authenticating with that organization's existing account, which 4.8 does carve out) —
  don't submit assuming this is fine without checking it against the current guideline text at
  submission time, since Apple has changed this rule's exact wording before.
- **Minors as end users** — see `docs/compliance/childrens-data-dossier.md` (ST-309) for the
  lawful basis, retention and age-screen decision, and its open items for what still blocks a
  truthful submission.
