# App store listings and review compliance

Store-submission prep for `apps/mobile` — copy, screenshot plan, privacy labels, and the review
checklist a human pastes into App Store Connect and Play Console. This directory is the source
content; it is not wired into any build or upload step.

## Why this isn't in `fastlane/`

`fastlane/Fastfile`'s `ios release` and `android release`/`internal` lanes all pass
`skip_metadata: true` / `skip_upload_metadata: true` and `skip_screenshots: true` /
`skip_upload_images: true`, with the comment "store copy is managed in App Store Connect, not this
repo" (`ios release`, line 197). That's a deliberate choice this directory doesn't override — the
files here are drafted and reviewed as markdown, then a human copies the final text and images into
each console by hand. Nothing reads this directory at build or release time.

## Before any of this can go live

Per `docs/runbooks/mobile-release.md`'s Status section: **no App Store Connect app record and no
Play Console app entry exist yet**, and neither store has ever received a build (both refuse API
uploads to a track with no prior manual build). This directory's content can be finalized and
reviewed independently of that, but the actual "first submission" can't happen until:

1. The app records exist in both consoles (bundle id `com.studafy.studafyMobile` / application id
   `com.studafy.studafy_mobile` — see `android/app/build.gradle.kts` and
   `ios/Runner.xcodeproj/project.pbxproj`).
2. The first build is uploaded manually to each (fastlane can only take over after that).
3. The remaining prerequisites in `docs/runbooks/mobile-release.md#status` (repo secrets, iOS Xcode
   signing wiring) are done.

## Contents

- [`listing-metadata.md`](listing-metadata.md) — app name, descriptions, keywords, category, and
  URLs for both stores.
- [`screenshot-plan.md`](screenshot-plan.md) — the shot list per role journey, required sizes, and
  the rule against real student data in captures.
- [`privacy-labels.md`](privacy-labels.md) — Apple App Privacy and Google Play Data Safety answers,
  the iOS privacy manifest inventory, the deletion routes and policy URL, each mapped to the code it
  comes from.
- [`review-checklist.md`](review-checklist.md) — the pre-submission checklist: forms, policies and
  the review risks this app carries.
- [`reviewer-walkthrough.md`](reviewer-walkthrough.md) — the clean-device run-through of the
  submitted build (sign-in, core path, push, AI consent, fees, no IAP, privacy policy, deletion),
  with the per-platform sign-off.

## Related

- `docs/permission_purpose_strings.md` — every permission's purpose string, where it is asked, and
  the sign-in browser (ST-310).

- `docs/store_payment_routing.md` — which payments the app may hand off to the browser (school
  fees) and which it must not route to at all (the AI add-on and every other digital good). Not
  duplicated here; `review-checklist.md` links to it.
- `docs/runbooks/mobile-release.md` — the release mechanics (lanes, signing, forced-update floor).
- `docs/compliance/store-audience-and-age-ratings.md` — Target audience, Ads, IARC and Apple Age
  Rating answers. `docs/compliance/childrens-data-dossier.md` — the children's-data basis,
  retention and age-screen decision behind them (ST-309).
