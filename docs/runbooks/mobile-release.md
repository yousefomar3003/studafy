# Mobile release runbook (ST-257)

Source of the resources this doc describes: [`apps/mobile/fastlane`](../../apps/mobile/fastlane)
(the lanes), [`apps/mobile/Gemfile`](../../apps/mobile/Gemfile) (the toolchain),
[`.github/workflows/mobile-release.yml`](../../.github/workflows/mobile-release.yml) (what runs
when), and the forced-update floor endpoint `GET /api/mobile/config`
([`apps/api/src/modules/mobile`](../../apps/api/src/modules/mobile), plus the Flutter check in
[`apps/mobile/lib/src/core/update`](../../apps/mobile/lib/src/core/update)).

## Status

**The lanes are written, not yet exercised against real store accounts.** Same posture as
`docs/runbooks/deploy-rollback.md` and `docs/runbooks/supply-chain-security.md`: the mechanism is
complete and reviewable ahead of the credentials that make it runnable. Nothing here has uploaded a
build to TestFlight or Play. Concretely still missing:

- The seven+ repository secrets in [Secrets](#secrets) — every job in `mobile-release.yml` fails
  fast with a named `::error::` until they exist.
- An App Store Connect app record and a Play Console app entry with the `internal` and `production`
  tracks created, and the first build uploaded **manually** on each side (both stores refuse an
  API upload for a track that has never had a build).
- The one-time iOS Xcode wiring in [iOS signing](#ios-signing) — the same class of "needs a human
  with Xcode once" gap `.github/workflows/mobile-integration.yml` already carries for its iOS leg.
- A committed `apps/mobile/Gemfile.lock` — generated the first time `bundle install` runs (CI does
  this via `bundler-cache`); commit it once it exists.

## Canonical layout

fastlane discovers `./fastlane/Fastfile` and nothing else, so the directory is `apps/mobile/fastlane/`
(lowercase). The ticket's `/apps/mobile/Fastlane` names the concern, not the path.

```
apps/mobile/
  Gemfile                 fastlane, pinned exact
  fastlane/
    Appfile              app identifiers (env-driven)
    Matchfile            managed iOS signing config
    Fastfile             the lanes
  android/
    app/build.gradle.kts release signingConfig from key.properties (fallback: debug keystore)
    key.properties.example
```

## Lanes

| Lane                      | Trigger                                   | What it does                                                                                                       |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `ios beta`                | merge to `main` touching `apps/mobile/**` | build release IPA → **TestFlight** (internal testers, no external review)                                          |
| `android internal`        | merge to `main` touching `apps/mobile/**` | build release AAB → **Play `internal` track**, fully rolled out                                                    |
| `ios release`             | push tag `mobile-v*`                      | build IPA → **App Store**, `submit_for_review`, `phased_release` (Apple's 7-day 1→100% ramp), manual final release |
| `android release`         | push tag `mobile-v*`                      | build AAB → **Play `production`**, `rollout: 0.1` (10%)                                                            |
| `android promote_rollout` | `workflow_dispatch` (`rollout` input)     | advance the live production rollout — `fastlane android promote_rollout rollout:0.25` → `0.5` → `1.0`              |
| `update_floor`            | run inside `android release`, or by hand  | compute the [forced-update floor](#forced-update-floor) this release implies                                       |

Staged rollout is asymmetric between the stores and this is deliberate, not a gap: **Android** takes
an explicit fraction (`0.1` → `0.25` → `0.5` → `1.0`), driven by `promote_rollout`. **iOS** has no
custom curve — `phased_release: true` opts into Apple's own fixed 7-day 1/2/5/10/20/50/100%
schedule, which is the only staged-rollout control App Store Connect exposes.

### Versioning

- **Version name** (`x.y.z`) — `pubspec.yaml`'s `version:` line is the single source of truth. A
  `mobile-v*` tag must name the version already in the pubspec; `ios/android release` abort with a
  clear error otherwise (`ensure_tag_matches_pubspec!`). So the release flow is: bump `pubspec.yaml`
  → merge → tag `mobile-v<that version>` → push tag.
- **Version code / build number** — `MOBILE_BUILD_NUMBER`, set by CI to `git rev-list --count HEAD`
  (this commit's position in history). Monotonic, derivable on any checkout, never hand-bumped.

## Secrets

Repository secrets, consumed by `mobile-release.yml` and passed through to the lanes. None is ever
committed; the workflow writes the file-shaped ones (`fastlane/play-store-key.json`,
`android/key.properties`, the keystore) at run time and `.gitignore` blocks all of them.

### Android

| Secret                                                                                       | What it is                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAY_STORE_JSON_KEY`                                                                        | Google Cloud service-account JSON with the _Release Manager_ role on the Play Console app. The workflow writes it to `fastlane/play-store-key.json`.                |
| `ANDROID_UPLOAD_KEYSTORE_BASE64`                                                             | `base64` of the upload keystore (`.jks`). **Upload key, not the app signing key** — Play App Signing holds the real distribution key and re-signs on Google's side. |
| `ANDROID_UPLOAD_STORE_PASSWORD` / `ANDROID_UPLOAD_KEY_ALIAS` / `ANDROID_UPLOAD_KEY_PASSWORD` | The keystore's store password, key alias, and key password.                                                                                                         |

### iOS

| Secret                                                     | What it is                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_STORE_CONNECT_KEY_ID` / `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect API key identifiers (Users and Access → Integrations → App Store Connect API).    |
| `APP_STORE_CONNECT_KEY_CONTENT`                            | `base64` of the `.p8` private key for that API key (`is_key_content_base64: true` in the Fastfile). |
| `APP_STORE_CONNECT_TEAM_ID`                                | App Store Connect team id (numeric).                                                                |
| `APPLE_ID` / `APPLE_DEVELOPER_TEAM_ID`                     | Apple account email and the 10-character Developer Program team id.                                 |
| `MATCH_GIT_URL`                                            | SSH/HTTPS URL of the private git repo holding the encrypted signing material.                       |
| `MATCH_PASSWORD`                                           | Passphrase `match` uses to decrypt that repo.                                                       |

## iOS signing

Managed with [`match`](https://docs.fastlane.tools/actions/match/) (`fastlane/Matchfile`): the App
Store distribution certificate and provisioning profile live encrypted in a dedicated git repo, and
every runner fetches them **read-only** (`readonly(true)`). Only a deliberate local run mints or
renews them:

```bash
cd apps/mobile
bundle exec fastlane match appstore          # first-time setup / renewal — NOT readonly
```

One-time Xcode wiring, needed before `ios beta` / `ios release` can succeed and not attempted blind
here (no Xcode in this environment to verify a `project.pbxproj` edit — same reason
`mobile-integration.yml`'s iOS leg is a documented manual step):

1. Set the `prod` scheme's Release build config to **manual** signing.
2. Point it at the `match AppStore com.studafy.studafyMobile` profile and the matching distribution
   certificate.
3. Confirm `flutter build ipa --flavor prod --export-method app-store` produces a signed IPA under
   `build/ios/ipa/`.

## Android signing

`android/app/build.gradle.kts` gained a real `release` `signingConfig` sourced from
`android/key.properties`. That file is written by `fastlane android signing` from the
`ANDROID_UPLOAD_*` secrets and is gitignored. **When it is absent, every build falls back to the
debug keystore** — so `flutter run --release` and CI test builds are unaffected. `key.properties.example`
is the template for producing a Play-signed build from a dev machine.

Play App Signing must be enabled for the app (Play Console → Setup → App integrity). The keystore in
`ANDROID_UPLOAD_KEYSTORE_BASE64` is then only the _upload_ key; Google holds and applies the
distribution key.

## Forced-update floor

The floor is **operational config, not code**: a build below it is blocked in-app, and raising it
must never require an app release.

### How it is served

`GET /api/mobile/config` (public, unauthenticated, un-scoped — the app calls it on launch before a
session exists) returns both platforms:

```json
{
  "ios": { "minimum_supported_version": "1.2.0", "latest_version": "1.4.1" },
  "android": { "minimum_supported_version": "1.3.0", "latest_version": "1.4.1" }
}
```

The values come from the **API service's own environment**:

| Variable                                        | Meaning                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `MOBILE_MIN_SUPPORTED_VERSION_IOS` / `_ANDROID` | the floor — a build strictly below it is blocked                   |
| `MOBILE_LATEST_VERSION_IOS` / `_ANDROID`        | advisory "newest published"; drives an optional non-blocking nudge |

An unset variable resolves to `0.0.0` ("no floor"), so nothing forces an update until an operator
sets one. `apps/api/src/env.ts` validates each as `x.y.z` and refuses to boot on a malformed value.

**Known gap:** the floor changes with an API environment update + restart, not with a single
command. Moving it to an object-storage JSON the `update_floor` lane writes and the API proxies
(so it changes with no deploy) is the follow-up — deliberately not built now, matching the "no
dynamic config store yet" state `apps/api/src/env.ts` already reflects.

### How the app enforces it

`apps/mobile/lib/src/core/update`:

- `updateStatusProvider` fetches the config on launch/resume, parses this build's `x.y.z` from
  `PackageInfo`, and compares against the floor for the running platform.
- Below the floor → the router's `redirect` (in `app_router.dart`, run **ahead of** the auth
  guard, which it skips entirely while blocking) pins every route to `ForcedUpdateScreen` — a
  blocking screen with no back-out (`PopScope(canPop: false)`) and an "Update now" button to the
  store listing.
- **Fail-open**: any error fetching the config, or an unparseable version, resolves to "up to
  date". The floor is a safety valve, never an availability dependency — a backend blip must not
  lock users out.

`IOS_APP_STORE_ID` (`--dart-define`) is the numeric App Store id for the "Update now" deep link;
until the listing exists the screen falls back to a name-based `apps.apple.com/app/studafy` URL.

### Raising the floor for a release

```bash
cd apps/mobile
bundle exec fastlane update_floor floor:1.3.0 latest:1.4.1
```

Prints the four `MOBILE_*` values (and writes them to the job summary in CI). Apply them to the API
service's environment — via `TF_VAR_secrets_app_secret_values` once the compute tier exists (see
`docs/runbooks/secrets-conventions.md`), or the ECS task environment directly — and restart the
service. `GET /api/mobile/config` then serves the new floor and below-floor clients block on their
next launch or resume.

## Verifying the acceptance criteria

1. **Internal builds auto-distribute on merge.** Merge a no-op change under `apps/mobile/**` to
   `main`. `mobile-release.yml` runs `android-internal` + `ios-beta`; a new build appears on the
   Play `internal` track and in TestFlight within the job's runtime.
2. **A release tag produces store submissions.** `git tag mobile-v<pubspec version> && git push
--tags`. `android-release` creates a `production` release at 10% rollout; `ios-release` submits
   the build for App Store review with phased release armed.
3. **The forced-update check blocks below-floor versions.** Set
   `MOBILE_MIN_SUPPORTED_VERSION_ANDROID` (or `_IOS`) above the installed build's version, restart
   the API, and relaunch the app: it lands on `ForcedUpdateScreen` and cannot navigate away.
   `apps/mobile/test/core/update/` and `apps/mobile/test/core/router/forced_update_guard_boot_test.dart`
   cover the comparison and the routing block.

## Toolchain

`apps/mobile/Gemfile` pins `fastlane` exactly (no `Gemfile.lock` yet — see [Status](#status)). CI
installs it with `ruby/setup-ruby` + `bundler-cache`. No fastlane plugins: version parsing and the
build-number are a few lines of `Fastfile`, so there is no plugin supply chain to pin.
