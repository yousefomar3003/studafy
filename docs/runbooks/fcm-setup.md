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
channel treats an unset `SES_REGION`. A deployed worker without the variable logs the same warning;
that is the signal the channel is not actually delivering.

The workers ECS task's secret container is named per `secrets-conventions.md`
(`<name_prefix>/workers/app-secrets`); add `FIREBASE_SERVICE_ACCOUNT` there. The credential is a
secret and never belongs in the repo or in a plain ECS environment entry.

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

### Registration tokens (not in this repo yet)

The worker only _reads_ device tokens from `app.user_devices` (migration 000017), soft-revoking them
when FCM says a token is unregistered. Nothing in this repo yet _writes_ those rows — token
registration is the mobile/web clients' job, and the API endpoint to persist a token is an open
follow-up. Until that exists the channel has devices only in tests, and everything downstream is
exercised in dry-run.

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

- **No token registration endpoint** — `app.user_devices` is populated by nothing in this repo yet.
- **No client-side tap handling** — the deep-link navigation on tap is the mobile app's job.
- **No ECS secret wiring** — `FIREBASE_SERVICE_ACCOUNT` must be added to the workers task's secret
  container before a deployed worker leaves dry-run mode.
- **No delivery-metrics exporter** — the counters exist in-process only.
