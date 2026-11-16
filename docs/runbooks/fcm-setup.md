# FCM push setup (ST-139)

The push channel in `apps/workers` sends notifications through Firebase Cloud Messaging. This runbook
covers provisioning Firebase, the one environment variable that switches the channel on, and how to
verify the acceptance criteria — push arrives on a test device, the deep link navigates, and stale
tokens are pruned.

## What the worker needs

Exactly one thing: a Google service-account JSON, passed as the `FIREBASE_SERVICE_ACCOUNT`
environment variable on the `workers` process. `apps/workers/src/env.ts` parses it; when it is unset
the push channel runs in **dry-run mode** — it resolves devices, applies the per-user cap, prunes
unregistered tokens and advances dispatch logs exactly as in production, but never calls FCM, and a
`warn` is logged at first use. This is the local-development and CI path, mirroring how the email
channel treats an unset `RESEND_API_KEY`. A deployed worker without the variable logs the same warning;
that is the signal the channel is not actually delivering.

In production it is the `FIREBASE_SERVICE_ACCOUNT` secret in the `prod` GitHub Environment, which
the deploy workflow copies to the workers fly app (`infra/fly/README.md`). The credential is a
secret and never belongs in the repo or in a fly.toml `[env]` entry.

## Provisioning Firebase

1. Create a Firebase project (or reuse the app's existing project) at
   <https://console.firebase.google.com>.
2. Project settings → Service accounts → **Generate new private key**. This downloads a JSON file
   containing `project_id`, `client_email` and `private_key`.
3. Store the entire JSON document as the `FIREBASE_SERVICE_ACCOUNT` secret for the `workers` service.
   The worker validates the JSON and those three fields on first use and fails fast on a bad value —
   the error names the field, so a mistyped secret fails loudly, not with silent non-delivery.
4. No other Firebase admin SDK setup is needed. The SDK uses the service account for application
   default credential OAuth; there is no API key involved server-side.

### Registration tokens

The mobile app registers its FCM token with `POST /api/auth/devices` after sign-in
(`apps/mobile/lib/src/core/push/push_service.dart`), stored in `app.user_devices` (migration 000017).
The worker reads those rows and soft-revokes a token when FCM says it is unregistered.

## The mobile app's Firebase config

The project is `studafy` (Spark plan, Google Analytics **off** -- the privacy labels declare no
analytics). It has one Android app per build flavor: `com.studafy.studafy_mobile` (prod),
`.dev` and `.staging`. Firebase -> Project settings -> Your apps -> **google-services.json** covers all
three; it goes in `apps/mobile/android/app/google-services.json`. Without it the Android build fails
(`processDevDebugGoogleServices`: "File google-services.json is missing").

The file is gitignored because the repository is public. Each developer downloads it; CI writes it
from the **`GOOGLE_SERVICES_JSON`** repository secret (the file's contents) in every Android build job
of `mobile-release.yml` and `mobile-integration.yml`, and fails with a clear error when the secret is
missing.

iOS (set up 2026-10-26):

- Firebase iOS app `com.studafy.studafyMobile` → **GoogleService-Info.plist**, also gitignored. CI
  writes it from the **`GOOGLE_SERVICE_INFO_PLIST`** secret and adds it to the Runner target on the
  runner's copy (`install_google_service_info` in `fastlane/Fastfile`); a store build fails without it.
  To build on a Mac, download it into `apps/mobile/ios/Runner/` and add it to the Runner target once.
- An **APNs auth key** (Apple Developer → Keys, "Studafy Push", Sandbox & Production, team scoped)
  uploaded to Firebase → Project settings → **Cloud Messaging** → Apple app configuration, with its
  Key ID and the team ID. One key serves every app in the team; it does not expire.
- The app declares push in `ios/Runner/Runner.entitlements` (`aps-environment` development, for
  Debug/Profile) and `RunnerRelease.entitlements` (production, for Release), plus the
  `remote-notification` background mode in `Info.plist`.

## iPhones stop getting notifications

Symptom: Android phones get notifications, iPhones get none (it happened twice before 2026-11-16).
Cause: Apple refuses the APNs credential Firebase holds -- the key was revoked in Apple Developer,
a yearly APNs **certificate** (.p12) was uploaded instead of the key and expired, or the key's Key ID
or Team ID is wrong. FCM then fails every iPhone token with `messaging/third-party-auth-error`. The
workers log it as **`notification_push_credential_rejected`** (error level, with the counts per
code); other per-token failures log as `notification_push_tokens_failed`.

Fix (about five minutes, no deploy):

1. Apple Developer -> Certificates, Identifiers & Profiles -> **Keys**. If "Studafy Push" is listed
   and not revoked, and you still have its `.p8`, reuse it. Otherwise **+** -> name "Studafy Push"
   -> tick **Apple Push Notifications service (APNs)** -> Configure: environment **Sandbox &
   Production**, key restriction **Team Scoped (All Topics)** -> Continue -> Register ->
   **Download** the `.p8` (it can be downloaded once only; keep it in the password manager). Note
   the **Key ID**. The **Team ID** is under Membership details (top right of the account page).
2. Firebase console -> project `studafy` -> gear -> **Project settings** -> **Cloud Messaging** ->
   Apple app configuration -> the app `com.studafy.studafyMobile`.
   - Delete any **APNs certificates** listed there (they expire every year).
   - Under **APNs Authentication Key**, delete the old key, then **Upload** the `.p8` with its Key
     ID and Team ID. If the page shows separate development and production slots, upload the same
     key to both.
3. Test: send something that notifies (an announcement to yourself) and check the iPhone; the
   worker log shows `notification_push_delivered` and no `notification_push_credential_rejected`.

Do not revoke the old key in Apple Developer until the new one works in Firebase, and do not create
APNs keys for anything else: a team may hold only two, and revoking the one Firebase uses is what
breaks iPhone notifications.

## An Android phone gets no notifications

Work down this list; each step rules out one layer.

1. **On the phone:** Account -> Notifications -> "Notifications on this phone".
   - "Off" / "Not turned on yet": the Android 13+ notification permission is missing. Turn it on
     there (or in Settings -> Apps -> studafy -> Notifications).
   - "Not available": Firebase did not start on this build. Sentry / Crashlytics has an event with
     reason `Firebase.initializeApp failed` or `push permission status unavailable`.
   - "On": tap **Send a test notification**. If the phone could not register, the message says why
     (`no push token: ...` is Firebase refusing to issue a token, `the server did not accept this
phone: HTTP ...` is the API). The same failure is in Sentry / Crashlytics with reason
     `FCM token unavailable` or `push token registration failed`.
2. **adb** (USB debugging on, phone plugged in):
   `adb logcat | grep -iE '\[push\]|FirebaseMessaging|Firebase-Installations|FIS_|FirebaseApp'`,
   then open the app signed in. `FIS_AUTH_ERROR` / `AUTHENTICATION_FAILED` mean the Android API key in
   `google-services.json` cannot reach the Firebase Installations / FCM Registration APIs (Google
   Cloud console -> APIs & Services -> Credentials -> the Android key's API and app restrictions;
   an app restriction must include the Play **app signing** SHA-1, not only the upload key's).
   `adb shell dumpsys notification | grep -A3 studafy` shows whether the `studafy_push` channel
   exists and its importance.
3. **Workers:** a send to an Android token from the wrong Firebase project fails with
   `messaging/mismatched-credential` or `messaging/sender-id-mismatch` and is logged as
   `notification_push_credential_rejected` — the `GOOGLE_SERVICES_JSON` secret then holds another
   project's file; download it again from project `studafy`. `sent:` counting the phone with no
   such log line means FCM accepted the message, so the problem is on the phone (step 1-2:
   permission, channel muted, battery restrictions).

## Dry run, on purpose only

A production-mode worker refuses to boot without `FIREBASE_SERVICE_ACCOUNT` unless
`PUSH_DRY_RUN=true`. Production sets `PUSH_DRY_RUN = "false"` (`infra/fly/workers.toml`), and the
deploy workflow refuses to run without the `FIREBASE_SERVICE_ACCOUNT` secret.

## The push payload

Each message is sent with `sendEachForMulticast`: a `notification` block the OS renders, and a
`data` block the app reads on tap:

| Data key            | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `route`             | Deep-link path, e.g. `/courses/{courseId}/grades`. Omitted when empty. |
| `notification_type` | The catalog type, e.g. `GRADE_POSTED`.                                 |
| `dispatch_log_id`   | The `app.notification_dispatch_logs` row this delivery belongs to.     |

The deep link rides in `data`, not `notification`, because `notification` is what the OS renders and
`data` is what the app receives when the notification is tapped. A notification that arrives but
navigates nowhere would fail the acceptance criterion, so the route travels beside the correlation
handles. The key names are the in-app metadata shape from 000017 — `route`, snake_case entity ids —
which is what the web/mobile clients already navigate on.

## Honest delivery

`app.notification_dispatch_logs` is the audit trail, and the push channel only advances a row to
`delivered` when FCM accepted at least one message. Zero accepted messages — every token pruned or
rejected — leaves the row at `enqueued`, so a person whose notification was never actually handed to
FCM is visibly unresolved rather than falsely recorded as delivered. A recipient with no live
devices is the same: `enqueued`, with a `notification_push_no_devices` warn and a `noTokens` metric
increment.

## Per-user device cap

A user can hold many live tokens (phone, tablet, web, re-registrations). FCM bills per message, so
the channel targets the five most-recently-seen live devices per recipient
(`MAX_DEVICES_PER_USER` in `delivery.worker.ts`) and counts the overflow in the `devicesSkippedCap`
metric. Overflow devices are real hardware and are never revoked.

## Verifying acceptance

1. **Push arrives on a test device.** Configure `FIREBASE_SERVICE_ACCOUNT` locally, register the
   test device's token in `app.user_devices` (an INSERT for now, until the registration endpoint
   exists), and trigger a grade publication. Check the worker log for `notification_push_delivered`
   and `app.notification_dispatch_logs.status = 'delivered'`, then confirm the notification on the
   device.
2. **The deep link works.** Tap the notification; the app must open the route from the payload's
   `route` key. The client-side tap handler is the mobile app's responsibility and is not yet
   implemented in this repo — until it is, verify the payload itself by checking the FCM `data`
   block contains the expected `route`.
3. **Stale tokens are pruned.** Uninstall the app (or rotate the installation id) and re-send. FCM
   returns a registration-token-not-registered error for that token; the worker logs
   `notification_push_tokens_pruned`, sets `revoked_at` on the `app.user_devices` row, and the
   `pruned` metric increments. The row is soft-revoked — the trail stays, only the route dies.

## Metrics

The push channel keeps in-process counters in `queues/notifications/push/metrics.ts`, exported as a
JSON snapshot: `sent` (messages FCM accepted), `pruned` (device rows revoked as unregistered),
`noTokens` (recipients with no live device), `devicesSkippedCap` (live devices over the cap that
were not targeted). There is no metrics wire-format yet; the snapshot is the same starting point the
outbox relay uses.

## Known gaps

- **No delivery-metrics exporter** — the counters exist in-process only.
