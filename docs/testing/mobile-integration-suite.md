# Mobile integration_test suite (ST-247)

`apps/mobile/integration_test/` — a real-backend Flutter `integration_test` suite covering the
five journeys the ticket names, run on a real Android emulator/device (and iOS, once the one
manual step in "iOS test target" below is done). It complements, not duplicates, the existing
`apps/mobile/test/` unit/widget suite and `apps/mobile/test_integration/` (ST-062's single live-
server healthz check) — this is the only layer that drives the real, on-device `StudafyApp` widget
tree against a real backend end to end.

## What's real, what's simulated, and why

| Seam                                              | Status                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres, Redis, `apps/api`, `apps/realtime`      | **Real**                                           | Same disposable stack `e2e-critical.yml` already uses (`db/compose.yml`), plus the realtime gateway this suite additionally needs.                                                                                                                                                                                                                                                                                                                                                              |
| Mock OAuth identity provider                      | **Real**, and newly mobile-capable                 | `dev/mock-idp.ts` already existed for web E2E (ST-246); it had no _mobile_ PKCE routes (`/mobile-start` + `/mobile-exchange`) for either login or invitation activation — only the browser-redirect ones. ST-247 added both (`oauth/mobile-oauth-routes.ts`'s and `routes/mobile-activation-oauth-routes.ts`'s `mock` branches), gated the same inert-by-default way as every other mock-OAuth surface.                                                                                         |
| System browser (login/activation)                 | **Simulated at the DI seam**                       | `OAuthBrowser.authorize` opens `ASWebAuthenticationSession`/Custom Tabs — no instrumented test can drive that chrome. `FakeOAuthBrowser` (`integration_test/support/fake_oauth_browser.dart`) does the one real HTTP hop a browser would (`GET .../authorize`, read `code`/`state` off the redirect) instead — the mock IdP has no consent screen to click through anyway. Everything downstream (`/mobile-exchange`, the mock IdP's `/token`, session issuance) is unmodified production code. |
| "Continue with Mock" login button                 | **Real, but `AppEnvironment.dev`-only**            | `LoginScreen` shows it only when `appConfig.environment == AppEnvironment.dev` — same posture as the web app's `VITE_ENABLE_MOCK_AUTH`-gated button. It calls the real `AuthNotifier.login('mock', loginHint: ...)`.                                                                                                                                                                                                                                                                            |
| Crash reporting / push (Sentry, Crashlytics, FCM) | **Faked at the DI seam**                           | `FakeCrashReporter`/`FakePushService` — the same two doubles `test/support/pumpStudafyApp` already uses, reused via a relative import rather than duplicated. No vendor project is configured for CI-run devices, and this suite has nothing to test in that code.                                                                                                                                                                                                                              |
| `authClientProvider`'s base URL                   | **Fixed, not simulated**                           | Was hardcoded to `http://localhost` — silently unreachable from any real device or emulator. ST-247 wired it to `appConfigProvider.apiBaseUrl` (`core/auth/auth_notifier.dart`), the same value every other API client in the app already uses. This was a real bug blocking exactly what this ticket needs, not a test-only concern — see the corresponding unit-test fixes below.                                                                                                             |
| Attendance "offline"                              | **Simulated, but via a real failure**              | `IntegrationTestApp.setApiBaseUrl` repoints `appConfigProvider` at an unroutable host (`http://127.0.0.1:1`) mid-test via `ProviderContainer.updateOverrides`. The resulting `DioException` (connection refused, no response) is indistinguishable from real airplane mode to `AttendanceSyncQueue._classifyFailure` — only _how_ the network goes away differs, since an instrumented test has no way to reach a device's OS-level airplane-mode toggle.                                       |
| AI upsell's outbound `launchUrl`                  | **Simulated at the platform-channel seam**         | `FakeUrlLauncher` swaps `UrlLauncherPlatform.instance` — the same substitution point `url_launcher`'s own tests use — so no real system browser opens mid-suite. The real `AiUpsellCard`, the real `aiCheckoutUrlProvider`, and the real tap are all exercised; only the final platform call is intercepted.                                                                                                                                                                                    |
| `currentStudentIdProvider`                        | **Overridden — a documented, test-sanctioned gap** | Always resolves to `null` in production today: there is no `/api/students/me` endpoint, and `StudentsClient.listStudents` has no self-resolving filter (see that provider's own doc comment, which explicitly invites "override... in tests"). The AI-upsell and grade-publish journeys override it to a real, API-resolved student id — unlike the realtime gap below, this is sanctioned by the code itself, not a workaround for a bug.                                                      |
| Grade-publish's realtime handshake                | **Not simulated — the journey is skipped**         | See "Known blocker" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Journey-by-journey

| #   | Journey                        | File                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Login                          | `login_test.dart`                     | Real UI, real mock-OAuth round trip, real backend.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | Invitation activation          | `activation_deep_link_test.dart`      | **API-only for the activation itself** — there is no invitation-activation screen anywhere in the Flutter app yet (`InvitationActivationResult`/`MobileAuthClient.startInvitationOAuth`/`exchangeInvitationCode` exist; no `AuthNotifier.activateInvitation` method, screen, or route calls them). This test proves the real backend contract (ST-247's new mock mobile-activation routes) end-to-end via the API, then signs the freshly-created account into the real app to prove it's genuinely usable. Building the actual mobile activation screen is a separate, substantial feature ticket, not something to improvise as a side effect of a test suite. |
| 3   | Attendance offline replay      | `attendance_offline_replay_test.dart` | Real UI throughout: navigate to a real class, go offline (see table above), submit, see the real offline snackbar and outbox row, go back online, retry, see the real success snackbar and an emptied outbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4   | Grade view on publish event    | `grade_publish_realtime_test.dart`    | **Skipped — see "Known blocker" below.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | AI upsell deep-link round trip | `ai_upsell_deep_link_test.dart`       | Outbound half is real UI through to a real (intercepted) `launchUrl` call, asserted against the real checkout URL. Return half: this app has no "purchase completed" deep link of its own yet (the checkout page lives entirely in `apps/web`); the one real return-trip mechanism it has for _any_ out-of-app event is a push-notification tap (`PushService.onNotificationTap`), so this half proves that exact mechanism lands on the AI usage screen, standing in for a completed-purchase notification.                                                                                                                                                     |

## Known blocker: grade-publish is skipped, not flaky

`grade_publish_realtime_test.dart` is `skip: true`, not merely slow or occasionally red. Root cause,
verified by reading both sides:

- `bootstrapApp` wires the realtime handshake token to the session's real RS256 access token
  (`realtimeTokenProvider.overrideWithValue(() => session.tokenProvider)`,
  `core/config/app_bootstrap.dart`).
- `apps/realtime/src/auth.ts` verifies only its own HS256 "stub" tokens, signed with a shared
  `WS_JWT_SECRET` it both issues and checks — its own file header says plainly: "there is no real
  identity provider yet... replace `signToken` with a call to the real issuer, and `verifyToken`'s
  secret lookup with JWKS verification, in the ticket that wires up real authentication."

A real mobile session's bearer token is therefore rejected by the gateway with `TOKEN_INVALID` in
every environment today, dev included — this is not a CI-only quirk. Two ways to make the test
"pass" were considered and rejected:

1. Mint a gateway-shaped HS256 token instead of the app's real bearer token for the test's
   handshake. This would make the test green while hiding that production's real wiring is broken
   — worse than an honest skip.
2. Fix `apps/realtime`'s auth to accept real RS256 tokens (e.g. via JWKS) as part of this ticket.
   That is a cross-service authentication change with its own review and risk surface, explicitly
   deferred to "the ticket that wires up real authentication" by the code that already exists — not
   something a test-suite ticket should do as a side effect.

The API sequence the test already runs (submit → approve/publish via
`POST /api/approvals/bulk-decision`) needs no changes once the realtime ticket lands — only
`skip: true` needs to come off.

## Backend additions this ticket made

- `apps/api/src/modules/auth/oauth/mobile-oauth-routes.ts`: a `mock` branch alongside `google`/
  `microsoft`'s existing mobile PKCE routes (`GET .../mock/mobile-start`,
  `POST .../mock/mobile-exchange`).
- `apps/api/src/modules/auth/routes/mobile-activation-oauth-routes.ts`: the same addition for
  invitation activation. `ActivationProvider` already included `"mock"` (the browser-redirect arm,
  `activation-oauth-routes.ts`, already had a mock branch for ST-246's web suite) — only the mobile
  JSON arm was missing.
- `core/auth/auth_notifier.dart`: `AuthNotifier.login` gained an optional `loginHint`, and
  `_buildAuthorizationUrl` gained a `mock` branch that derives the mock IdP's authorize endpoint
  from `appConfigProvider.apiBaseUrl` (`<api origin>/mock-idp`, matching `mock-config.ts`'s own
  issuer convention) rather than a separate build-time constant.
- `LoginScreen`: a "Continue with Mock" button, visible only when `AppEnvironment.dev`.
- `core/di/app_providers.dart` → `core/auth/auth_notifier.dart`'s `authClientProvider`: fixed a
  real bug (hardcoded `http://localhost` base URL, unreachable from any real device/emulator) by
  wiring it to `appConfigProvider.apiBaseUrl` like every other client in the app. This required
  adding an `appConfigProvider` override to three existing unit tests and two widget-test harnesses
  (`test/support/pump_app_shell.dart`, `test/features/shell/app_shell_golden_test.dart`, and the
  three `attendance_providers_test.dart`/`grade_report_test.dart`/`today_grades_provider_test.dart`
  cases that previously got away with a bare `ProviderContainer()`) — see each file's own comment
  for why a supposedly "cheap, dependency-only" `ref.watch(authSessionProvider)`
  (`currentStudentIdProvider`'s own doc comment) newly needed one.

## Running locally

```bash
cd apps/mobile
flutter pub get
bun run client:generate   # from repo root, or `bun run client:generate` here

# Backend: Postgres/Redis + apps/api (mock OAuth enabled) + apps/realtime, e.g.:
bun run db:up && bun run db:migrate && bun run db:seed
MOCK_OAUTH_ISSUER_URL=http://10.0.2.2:3000/mock-idp \
  MOCK_OAUTH_REDIRECT_URI=http://10.0.2.2:3000/api/auth/oauth/mock/callback \
  bun run --cwd apps/api dev &
bun run --cwd apps/realtime dev &

flutter test integration_test/ \
  --dart-define=API_BASE_URL=http://10.0.2.2:3000 \
  --dart-define=REALTIME_BASE_URL=ws://10.0.2.2:3001 \
  --dart-define=WEB_BASE_URL=http://10.0.2.2:5173 \
  --dart-define=AI_ADDON_PRICE_ID=any-non-empty-string \
  -d <emulator-or-simulator-id>
```

`AI_ADDON_PRICE_ID` only needs to be non-empty (`buildAiCheckoutUrl` puts it in the outbound URL as
an opaque query param) — the AI-upsell journey asserts on that URL, not on a live Stripe checkout,
so it doesn't need to be a real `plan_prices.id` synced to Stripe.

Use `10.0.2.2` for the Android emulator loopback alias, or `127.0.0.1` for an iOS simulator (which
shares the host's network namespace directly).

## CI device farm

`.github/workflows/mobile-integration.yml`:

- `android-emulator` needs no secrets — it runs today.
- `firebase-test-lab` (the literal device-farm leg of the acceptance criteria) needs two repository
  secrets: `FIREBASE_TEST_LAB_PROJECT_ID` and `FIREBASE_TEST_LAB_SA_KEY` (a GCP service-account key
  JSON with the Firebase Test Lab admin + Cloud Storage roles on that project — the app already
  depends on Firebase for push/Crashlytics, so this reuses an existing vendor relationship rather
  than starting a new one). Provision these before the job's first real run, the same posture
  `e2e-critical.yml` takes with its ERPNext secrets.
- The Android leg of `firebase-test-lab` tunnels the ephemeral backend out via `cloudflared` so
  Google's cloud devices (which cannot reach the runner's own `localhost`) can reach it — see the
  workflow's own comments for the exact mechanics and why. This exact approach has not yet been
  exercised against a real Firebase Test Lab account (this repo had none available while ST-247 was
  built); expect the first real run to need minor adjustment.

### iOS test target (one-time manual step)

`ios/RunnerUITests/RunnerUITests.swift` exists, but no `RunnerUITests` Xcode target references it
yet — adding one means editing `ios/Runner.xcodeproj/project.pbxproj`, which this repo does not
attempt by hand (no Xcode available to verify the edit doesn't corrupt the project file). Whoever
has Xcode installed needs to, once:

1. Open `ios/Runner.xcworkspace` in Xcode.
2. File → New → Target… → UI Testing Bundle, name it `RunnerUITests`, target it at `Runner`.
3. Remove the auto-generated `RunnerUITests.swift` Xcode creates and add this repo's own
   `ios/RunnerUITests/RunnerUITests.swift` to the new target instead.
4. Commit the resulting `project.pbxproj` changes.

Until then, `firebase-test-lab`'s iOS step fails on purpose (see its own comment) rather than
silently skipping iOS off the acceptance criteria.

## Flake rate

The acceptance criterion ("<3%") is a measured property of real CI runs against real devices/farm
hardware, not something this ticket can assert from a repo with neither running. What this suite
does instead, to keep that number achievable once it _is_ measured: no arbitrary `sleep`s (every
wait is `pumpUntil`, a polled condition with a real timeout), a pre-flight check in the attendance
journey that fails loudly instead of silently compounding state from a previous failed run, and
`extraOverrides` seams instead of ad hoc widget-tree hacks. Watch the first several real runs (local
or CI) and tighten timeouts/waits against what's actually observed.
