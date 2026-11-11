# Object storage conventions

Production stores files in one Cloudflare R2 bucket, `studafy-prod-files`, reached through the S3
API (`S3_APP_FILES_BUCKET`, `S3_ENDPOINT`; [`infra/fly/README.md`](../../infra/fly/README.md)). This
doc is the key-scheme convention apps must follow — bucket lifecycle rules have no way to enforce
what key an application writes an object under. A key that doesn't follow this scheme still uploads fine; it just silently misses
the lifecycle rule (or another school's tenant boundary) that the scheme exists to give it.

## Why category comes before schoolId, not after

The scheme was designed for two bucket lifecycle rules (`temp-expiration` and
`reports-expiration`), each matching a single key **prefix** — `temp/` and `reports/`. Lifecycle
prefix filters match literally from the start of the key; there is no wildcard or "any depth"
option. A key like `schools/<schoolId>/temp/<file>` would need one lifecycle rule per `schoolId` to
expire correctly, which isn't viable — schools are created and deleted by the application at
runtime. (Whether those rules are configured on the R2 bucket is not recorded in this repo; see
"Known gaps".)

Putting the lifecycle category first solves this with a fixed, small number of rules that cover
every school:

```
temp/<schoolId>/<objectId>/<filename>
reports/<schoolId>/<objectId>/<filename>
permanent/<schoolId>/<objectId>/<filename>
quarantine/<schoolId>/<objectId>/<filename>
```

## `app-files` bucket (`studafy-prod-files`)

| Top-level prefix | Purpose                                                                                                                                                                                | Lifecycle                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `temp/`          | Staging area for pre-signed uploads before the app confirms/processes them                                                                                                             | Expires after 1 day (24h)                                         |
| `reports/`       | Generated exports (e.g. PDF/CSV reports) offered for download                                                                                                                          | Expires after 7 days                                              |
| `permanent/`     | Confirmed, long-lived user content (avatars, assignment attachments, etc.)                                                                                                             | No expiration                                                     |
| `quarantine/`    | Objects a malware scan flagged. Never served; copied here, then the `permanent/` copy is deleted                                                                                       | No expiration (retain for forensics; expiry is a future decision) |
| `dsr-exports/`   | Data subject request exports: one ZIP archive per request, `dsr-exports/<schoolId>/<requestId>/export.zip` ([policy](../security/data_retention_and_dsr_policy.md#the-export-archive)) | No bucket rule (see the policy)                                   |

Flow for a pre-signed upload:

1. `apps/api` issues a pre-signed `PUT`/`POST` URL for a key under
   `temp/<schoolId>/<objectId>/<filename>`.
2. `apps/web` uploads directly to R2 using that URL (this is what the bucket's CORS policy exists
   for — it must list every browser domain; [`infra/fly/README.md`](../../infra/fly/README.md#file-storage-r2-cors)).
3. Once `apps/api` confirms the upload (e.g. via a completion callback or a `HeadObject` check),
   it moves/copies the object to `permanent/<schoolId>/<objectId>/<filename>` — the S3 API doesn't
   have a true move, so this is a `CopyObject` + `DeleteObject` pair — after which it is out of `temp/`
   and no longer subject to the 24h rule.

   No database transaction is held open across these S3 calls
   (`apps/api/src/modules/storage/staged-promotion.ts`): a confirm HEADs the staged object, then
   one short transaction authorizes and charges the storage quota, then the `CopyObject` runs,
   then a second short transaction writes the row that names the permanent key, and only after it
   commits is the staged copy deleted. A failure after the copy leaves an unreferenced object in
   `permanent/` (counted by the meter, as the bucket counts it), never a row pointing at a missing
   object; a failed copy hands the reserved bytes back and leaves the staged object for a retry.

4. If the app never confirms the upload (abandoned form, crashed tab), the object ages out of
   `temp/` on its own after 24h. This is the mechanism, not a fallback — nothing else cleans up
   unconfirmed uploads.

Objects under `reports/<schoolId>/...` are written directly by whatever generates the report and
are expected to be re-generated on demand, so a 7-day expiry is a storage-cost bound, not a data
loss risk.

Objects under `quarantine/<schoolId>/...` are written only by the workers' `file-scan` queue when
ClamAV flags a confirmed material. The worker copies the object from `permanent/` to
`quarantine/` first, then deletes the `permanent/` copy, then flips the material to `quarantined`
— that ordering is the crash-recovery checkpoint: a run that dies between the delete and the flip
is retried by re-scanning the `quarantine/` copy rather than being mis-labelled as a scan failure.
Nothing in the app ever serves from this prefix, so an infected object is unreachable the moment
the `permanent/` copy is gone.

Every other upload another person can download goes through the same queue (`scan-upload` jobs,
F-14, migration 000192): submission and assignment files, question pictures, message images,
record documents (sensitive ones included), expense and license receipts, school application
proofs (`quarantine/school-applications/...`) and student import files. Each of those rows carries
an `app.upload_scan_status`: the write that stores the key sets `scanning`, the API enqueues the
job after commit, and the worker sets `clean`, `quarantined` (same copy -> delete -> flip order) or
`failed` (retries exhausted). Every read path signs a URL only for `clean` or `unscanned` (a file
uploaded before 000192, which stays downloadable; a `scan-upload` job for it scans it like a new
one). Not covered: license payment receipts uploaded by platform staff (only platform staff read them)
and user avatars (never stored against a row or served by the API).

## `schoolId` format

Match whatever `apps/realtime` already uses for tenant scoping
(`school:<schoolId>:role:<role>` room keys, `apps/realtime/src/rooms.ts`) — treat it as an
opaque string identifier, not a slug you re-derive or reformat for storage keys. Don't URL-encode
or transform it; if it's already a valid room-key segment, it's already a valid S3 key segment.

## Access scoping

The R2 API token the api and workers use can read and write the whole bucket, so per-school scoping
is an application-layer control: the pre-signing code decides what key it signs for, and must only
ever sign a key under the requesting school's own `<schoolId>` segment, so that a compromised or
buggy pre-signed-URL request for one school can't be pointed at another school's prefix. Nothing at
the bucket level knows which `schoolId` a given request is for.

## Known gaps

- **The `temp/` and `reports/` expiry rules are not recorded for R2.** They were defined in the
  retired AWS Terraform; whether equivalent lifecycle rules exist on `studafy-prod-files` is not
  captured anywhere in this repo. Until confirmed on the bucket in the Cloudflare
  dashboard, assume abandoned uploads under `temp/`
  are not expiring on their own.
- **No per-object encryption key.** R2 has no per-object KMS; sensitive documents rely on the
  bucket's own encryption (ADR-019's field encryption covers the record values, not the files).
- The lifecycle rule design matches only the `reports/` prefix. Legacy finance exports live
  under `tenant-<schoolId>/reports/` (see [`docs/modules/report-framework.md`](../modules/report-framework.md))
  and are invisible to that rule; the workers' daily `purge-expired-reports` sweep (ST-175) is the
  DB-driven closure for both prefixes.

## Student and parent record documents

The file behind a record's document field (docs/modules/student-records.md) is staged and promoted
like any other upload, under `temp/` then `permanent/<schoolId>/…`, through two content classes in
`apps/api/src/modules/storage/content-classes.ts`. The records module confirms the upload inside the
write that attaches it (`gatewayConfirm: false`).

- `record.document`: PDF, JPEG, PNG or HEIC, up to 10 MiB, downloaded through five-minute URLs.
- `record.sensitiveDocument`: PDF, JPEG or PNG, up to 5 MiB. The promotion `CopyObject` re-encrypts
  the object with the sensitive-documents KMS key (`STORAGE_SENSITIVE_KMS_KEY_ID`, Bucket Key
  enabled, ADR-019) on AWS S3. On Tigris and other S3-compatible endpoints there is no KMS; the key
  is refused at startup and the object keeps the provider's encryption at rest (ADR-019, decision 7
  amendment). Downloads are one-minute URLs that need `studentRecord:readSensitive` and are
  audited.

A replaced or removed document's object is deleted after its row change commits. The retention
sweep and DSR erasure delete objects the same way, once their transaction has committed.
