# Automatic data retention

Every period after which Studafy deletes data on its own, without anyone asking, and the code that
enforces it. All sweeps run daily in `apps/workers` (times UTC), per school where the data is
tenant data, in batches, and a failure for one school or category is logged and skipped while the
rest continue. Erasure on request (account deletion, data subject requests) is described in
[account-deletion.md](./account-deletion.md) and `docs/security/data_retention_and_dsr_policy.md`.

| Data                                                                                           | Deleted                                                                                       | Enforced by                                                                                                        |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Staged uploads (`temp/` prefix)                                                                | 1 day after upload                                                                            | Bucket lifecycle rule `temp-expiration` (`infra/terraform/modules/storage`)                                        |
| Abandoned student imports (uploaded, never confirmed)                                          | 48 hours after upload                                                                         | `queues/imports/abandoned-import-sweep.ts`, `purge-abandoned-imports`, 08:00                                       |
| Student import files and leftover cells                                                        | 180 days after upload (a school may shorten it, 1–180 days)                                   | `queues/imports/import-source-retention-sweep.ts`, same job, 08:00                                                 |
| Report artifacts (attendance, finance, audit exports)                                          | 7 days after generation                                                                       | `queues/reports/report-expiry-sweep.ts`, `purge-expired-reports`, 07:00; plus the `reports/` bucket lifecycle rule |
| Ask AI chat messages                                                                           | 90 days after they were sent (`expires_at`)                                                   | `queues/maintenance/ai-message-retention-sweep.ts`, `purge-expired-ai-messages`, 08:45                             |
| Sensitive student, parent and staff record fields                                              | 12 months after the person left (or the field's own period, 1–120 months)                     | `queues/maintenance/record-retention-sweep.ts`, `purge-expired-sensitive-records`, 08:50                           |
| A school closed by its administrator or its subscription                                       | Erased 30 days after its closure export completed                                             | `queues/maintenance/closure-sweep.ts` (`CLOSURE_ERASURE_RETENTION_HOLD_DAYS`), `run-tenant-closure-sweep`, 08:30   |
| An account its owner deleted                                                                   | Detached and its erasure filed 14 days after the request                                      | `queues/maintenance/account-deletion-sweep.ts`, `run-account-deletion-sweep`, 09:00                                |
| Security events (`app.security_events`)                                                        | 12 months after they were recorded                                                            | `queues/maintenance/data-retention-sweep.ts`, `purge-expired-retained-data`, 03:15                                 |
| "Talk to us" sales inquiries (`app.sales_inquiries`)                                           | 12 months after they arrived                                                                  | same                                                                                                               |
| Rejected school applications and their proof-of-ownership file                                 | 12 months after the rejection (`reviewed_at`)                                                 | same                                                                                                               |
| In-app notifications (`app.notifications`), read or unread                                     | 12 months after they were created                                                             | same                                                                                                               |
| Data subject request export bundles (`dsr-exports/…`)                                          | 30 days after the request finished (completed or failed)                                      | same                                                                                                               |
| Email provider events (`app.email_events`: bounces, complaints, deliveries)                    | 12 months after they arrived; the suppression list built from them is kept                    | same                                                                                                               |
| Email delivery records (`app.email_deliveries`)                                                | 12 months after the send, once its domain event is gone and the send is no longer in progress | same                                                                                                               |
| Notification dispatch log (`app.notification_dispatch_logs`), with its rendered title and body | 12 months after it was written                                                                | same                                                                                                               |
| Notification idempotency keys and dead letters                                                 | 12 months after the key was reserved / the job failed                                         | same                                                                                                               |
| Attendance alert log (`app.attendance_alert_logs`)                                             | 12 months after the alert                                                                     | same                                                                                                               |
| Domain events (`app.outbox_events`)                                                            | 14 days after they were written, once every consumer has processed them                       | same                                                                                                               |
| Sign-in sessions (`app.refresh_tokens`)                                                        | 90 days after the session's last token expired                                                | same                                                                                                               |

## The data retention sweep

`apps/workers/src/queues/maintenance/data-retention-sweep.ts` holds the last twelve rows. Their periods
are named constants listed together in `DATA_RETENTION_RULES`; the scheduler is
`data-retention-sweep-scheduler.ts`. Rows are deleted 1000 per statement (sessions: 200 token
families per statement), one transaction per batch, until a batch comes back short. Every batch is
a range scan of an index that leads with the school (000201 added the four that were missing). Each
category runs on its own for each school, so one that fails is logged and retried the next day
without holding up the others. The job returns and logs a count per category.

### Why these periods

No legal document states a period for the logs, ledgers, domain events or sessions below; the
privacy policy (section 10) keeps them "as long as needed for security and legal purposes", and
says Studafy keeps "a copy of each notification and a record of each email's delivery". The
periods were chosen to match what is already documented, never shorter:

- **12 months** for every log of a notification or email — the period the in-app notifications
  themselves are kept, and the period for security events. A log outliving the inbox row it
  describes would keep the same personal data (names, marks, message previews) longer than the
  inbox does.
- **14 days** for a processed domain event: long past any consumer's retry window, and short
  because events carry names and email addresses in their payload that the domain tables already
  hold.
- **90 days** after expiry for a session: the period after which its IP address is removed, and
  longer than any session can stay idle (30 days), so no session the user could still resume is
  ever deleted.

- **Security events, sales inquiries, school applications** are global tables, reached as
  `studafy_admin` (`withSystemTx`). None has an append-only trigger or a foreign key pointing at it.
- **School applications.** Only `rejected` ones are deleted. A pending application is undecided; an
  approved one is the record of the school's acceptance and is never deleted. The proof file is
  deleted from storage after the rows' transaction commits, unless another application still points
  at the same key.
- **Notifications.** Per school. Three logs point at an inbox row — the notification dispatch log,
  announcement recipients and the attendance alert log. Their links were `ON DELETE RESTRICT`, which
  blocked the delete; migration 000189 changed them to `ON DELETE SET NULL (notification_id)` and
  indexed them. The log rows stay; only the link is cleared.
- **Export bundles.** Per school. Every object under `dsr-exports/<school>/<request>/` is deleted;
  files the manifest only references (materials, attachments) live elsewhere and are not touched.
  The `app.data_subject_requests` row is the compliance record and stays. Its `storage_key` cannot
  be cleared — `ck_data_subject_requests_terminal_state` requires it on a completed export — so the
  sweep sets `export_deleted_at` (000189) once every object is gone. A bundle with an object that
  failed to delete stays unmarked and is retried the next day. From then on
  `GET /api/privacy/dsr/{requestId}` returns the request without a download link. A closure export
  is deleted after the same 30 days its school has to download it before the erasure.
- Without object storage configured, the two categories that own stored files are skipped rather
  than deleting rows and leaving their files behind.
- **Domain events.** Per school. An event is deleted only once every consumer has finished with it:
  `relayed_at` set (the relay claims every event); `email_dispatched_at` set if the email dispatcher
  (`EMAIL_EVENT_NAMES`) or the digest producer (`DIGEST_SOURCE_EVENTS`) claims its name;
  `entitlement_applied_at` set if the entitlement invalidator (`ENTITLEMENT_EVENT_NAMES`,
  `USER_ENTITLEMENT_EVENT_NAME`) does. The sweep imports those lists from the consumers, so a new
  event a consumer starts claiming is protected without touching the sweep. An event a consumer
  never finishes is kept, as the backlog to investigate.
- **Email deliveries.** Per school. A delivery row is the email dispatcher's guard against sending
  the same event to the same address twice, so it is deleted only once its domain event is gone and
  it has left `claimed` (a send in progress or waiting for a retry).
- **Email provider events.** Global (`withSystemTx`). The suppression list derived from them
  (`app.email_suppressions`) is never deleted, so a bounced or complaining address stays
  suppressed.
- **Notification ledgers.** Per school: the dispatch log (`created_at`), idempotency keys
  (`reserved_at`), dead letters (`failed_at`) and the attendance alert log (`sent_at`). Past 12
  months nothing dispatches the same event again — the dead letter that could replay it goes on the
  same schedule. The alert log is also the alert's dedup claim, keyed by the date of the absence; an
  alert for an absence more than a year old is not raised again in practice.
- **Sessions.** Per school. Rotation links a session's tokens to each other (`parent_token_id`,
  `replaced_by_token_id`, `ON DELETE RESTRICT`), so a session is deleted as a whole token family in
  one statement, once every token in it expired 90 days ago. Families are walked in `family_id`
  order with a cursor, so a run reads each school's tokens once and always moves forward. Devices
  (`app.user_devices`) are not touched.

## Not covered

- `app.erpnext_webhook_dedup` is never deleted. ERPNext signs the webhook body with no timestamp, so
  this table is the only thing that stops a captured webhook from being replayed. Its rows hold an
  event id, a document type and an action — no personal data.
- Audit-log and attendance partitions are never dropped automatically; the period is a compliance
  decision that has not been made (`docs/database/audit-log-partition-maintenance.md`).
- A domain event a consumer never processes is never deleted, and neither are its email deliveries.
- The web admin's privacy page still shows a Download button for an export older than 30 days; it
  answers "download failed".
- Grades and attendance are kept for as long as the school exists: their period is set by each
  school's education authority and is not encoded.
