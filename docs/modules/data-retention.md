# Automatic data retention

Every period after which Studafy deletes data on its own, without anyone asking, and the code that
enforces it. All sweeps run daily in `apps/workers` (times UTC), per school where the data is
tenant data, in batches, and a failure for one school or category is logged and skipped while the
rest continue. Erasure on request (account deletion, data subject requests) is described in
[account-deletion.md](./account-deletion.md) and `docs/security/data_retention_and_dsr_policy.md`.

| Data                                                           | Deleted                                                                   | Enforced by                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Staged uploads (`temp/` prefix)                                | 1 day after upload                                                        | Bucket lifecycle rule `temp-expiration` (`infra/terraform/modules/storage`)                                        |
| Abandoned student imports (uploaded, never confirmed)          | 48 hours after upload                                                     | `queues/imports/abandoned-import-sweep.ts`, `purge-abandoned-imports`, 08:00                                       |
| Student import files and leftover cells                        | 180 days after upload (a school may shorten it, 1–180 days)               | `queues/imports/import-source-retention-sweep.ts`, same job, 08:00                                                 |
| Report artifacts (attendance, finance, audit exports)          | 7 days after generation                                                   | `queues/reports/report-expiry-sweep.ts`, `purge-expired-reports`, 07:00; plus the `reports/` bucket lifecycle rule |
| Ask AI chat messages                                           | 90 days after they were sent (`expires_at`)                               | `queues/maintenance/ai-message-retention-sweep.ts`, `purge-expired-ai-messages`, 08:45                             |
| Sensitive student, parent and staff record fields              | 12 months after the person left (or the field's own period, 1–120 months) | `queues/maintenance/record-retention-sweep.ts`, `purge-expired-sensitive-records`, 08:50                           |
| A school closed by its administrator or its subscription       | Erased 30 days after its closure export completed                         | `queues/maintenance/closure-sweep.ts` (`CLOSURE_ERASURE_RETENTION_HOLD_DAYS`), `run-tenant-closure-sweep`, 08:30   |
| An account its owner deleted                                   | Detached and its erasure filed 14 days after the request                  | `queues/maintenance/account-deletion-sweep.ts`, `run-account-deletion-sweep`, 09:00                                |
| Security events (`app.security_events`)                        | 12 months after they were recorded                                        | `queues/maintenance/data-retention-sweep.ts`, `purge-expired-retained-data`, 03:15                                 |
| "Talk to us" sales inquiries (`app.sales_inquiries`)           | 12 months after they arrived                                              | same                                                                                                               |
| Rejected school applications and their proof-of-ownership file | 12 months after the rejection (`reviewed_at`)                             | same                                                                                                               |
| In-app notifications (`app.notifications`), read or unread     | 12 months after they were created                                         | same                                                                                                               |
| Data subject request export bundles (`dsr-exports/…`)          | 30 days after the request finished (completed or failed)                  | same                                                                                                               |

## The data retention sweep

`apps/workers/src/queues/maintenance/data-retention-sweep.ts` holds the last five rows. Their periods
are named constants listed together in `DATA_RETENTION_RULES`; the scheduler is
`data-retention-sweep-scheduler.ts`. Rows are deleted 1000 per statement, one
transaction per batch, until a batch comes back short. The job returns and logs a count per
category.

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

## Not covered

- The notification dispatch log keeps the rendered title and body of every notification it sent,
  with no retention period. Deleting an inbox row does not delete that copy.
- The web admin's privacy page still shows a Download button for an export older than 30 days; it
  answers "download failed".
- Grades and attendance are kept for as long as the school exists: their period is set by each
  school's education authority and is not encoded.
