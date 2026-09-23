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
- `/account/delete` (`apps/web/src/features/account/privacy/DeleteAccountPage.tsx`) — the in-app
  action: explains the consequences, confirms, files the erasure request, shows a pending request
  if one already exists instead of allowing a duplicate.
- `/legal/delete-account` (`apps/web/src/routes/legal/DeleteAccountInfoPage.tsx`) — public, no
  sign-in required, for Google Play's Data Safety URL field and for anyone who can't sign in.
- The mobile app's Profile tab (`apps/mobile/lib/src/features/shell/presentation/profile_tab_screen.dart`,
  every role) now carries a "Delete my account" action, opened in the system browser at
  `/account/delete` — the same external-browser pattern `AiUpsellCard` already uses for the AI
  add-on checkout (`docs/ai_store_compliance.md`'s R-07), for the same reason: no in-app webview.

Re-check before every submission: the Profile tab link still resolves, `/account/delete` and
`/legal/delete-account` are still reachable, and `POST /api/privacy/me/dsr` still requires only
authentication (a permission added here by mistake would silently break self-service deletion for
every role at once).

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

## External-purchase compliance (AI upsell)

Fully covered by `docs/ai_store_compliance.md` (R-07) — don't duplicate its checklist here, use it
directly. Summary of what it guarantees: no price shown anywhere in `features/ai`, no
subscribe/buy/pay affordance, the only outbound action is a system-browser launch (never an in-app
webview), no payment-credential collection, and no in-app-purchase plugin dependency. Re-run that
checklist specifically whenever `features/ai` changes.

## Privacy label accuracy

- [ ] `privacy-labels.md` in this directory has been re-checked against the current `pubspec.yaml`
      and current permission declarations (`AndroidManifest.xml`, `Info.plist`) — not just copied
      from a prior submission.
- [ ] Every data type declared in the App Privacy / Data Safety forms traces to an actual SDK or API
      call in the codebase, not a guess. (`privacy-labels.md`'s table is the source for this.)
- [ ] The tracking question is answered "No" on both forms, consistent with there being no ad/data-
      broker SDK in `pubspec.yaml`.
- [ ] The deletion-request question on both forms is answered "Yes" — self-service deletion now
      exists in-app (mobile Profile tab -> web `/account/delete`) and via a public web page
      (`/legal/delete-account`) — with the URL field pointed at `/legal/delete-account`, not
      `/account/delete` (Play's reviewer won't have a session to reach the authenticated one).

## Permissions sanity check

- [ ] `AndroidManifest.xml` requests exactly: `INTERNET`, `RECEIVE_BOOT_COMPLETED` (push
      re-registration after reboot), `CAMERA`. No permission is requested that the app doesn't use.
- [ ] `Info.plist` declares `NSCameraUsageDescription` and nothing else — correct, since
      `image_picker` is used with `ImageSource.camera` only, never `ImageSource.gallery`
      (confirmed: no other `ImagePicker` call site in `lib/`). If gallery picking is ever added,
      `NSPhotoLibraryUsageDescription` must be added in the same change, or the build will crash on
      first gallery access on iOS — a common late-cycle rejection cause.
- [ ] `file_picker`'s document-picker flow needs no additional iOS usage-description string (it
      uses `UIDocumentPickerViewController`, not photo-library APIs) — verify this hasn't changed if
      the dependency is upgraded across a major version.

## Metadata and screenshots

- [ ] `listing-metadata.md` content is final and within each field's character limit (re-measure;
      don't trust the counts in that file blindly after edits).
- [ ] Screenshot set captured per `screenshot-plan.md`, from seeded/demo data only — confirm no real
      student, grade, attendance, or financial data appears in any captured image before upload.
- [ ] Age rating / content rating questionnaire answers match the recommendation and reasoning in
      `listing-metadata.md`, and have been confirmed by whoever owns compliance sign-off, not
      assumed from this document alone.
- [ ] Support URL and privacy-policy URL both resolve (load in a browser, return 200) before
      submission — a broken URL in either field is an automatic rejection on both stores.

## First-or-second-submission risk notes

Specific things reviewers on both platforms commonly flag on education apps with a paid add-on,
worth a deliberate look rather than assuming they're fine:

- **Apple 3.1.1/3.1.3 (external purchase)** — covered above; this is the single most common
  rejection reason for an app in this shape, and it's already been designed around deliberately.
  Still worth a reviewer re-reading `docs/ai_store_compliance.md`'s checklist item-by-item against
  the actual build being submitted, not just trusting it hasn't regressed.
- **Sign in with a third-party IdP only (Microsoft/Google), no Apple option** — Apple's guideline
  4.8 requires offering Sign in with Apple *if* the app offers any other third-party login option
  and doesn't rely solely on the platform's own account system. `login_screen.dart` currently offers
  Microsoft and Google only. This needs an explicit decision: either add Sign in with Apple, or
  confirm an applicable exception (e.g., the app is exclusively for an organization's own employees/
  students authenticating with that organization's existing account, which 4.8 does carve out) —
  don't submit assuming this is fine without checking it against the current guideline text at
  submission time, since Apple has changed this rule's exact wording before.
- **Minors as end users** — see `listing-metadata.md`'s age-rating section; the Data Safety /
  App Privacy forms both ask direct questions about data from users under 13/16/18 that should be
  answered consistent with whatever that policy decision turns out to be.
