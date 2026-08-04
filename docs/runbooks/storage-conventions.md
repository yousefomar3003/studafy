# Object storage conventions

Source of the buckets: [`infra/terraform/modules/storage`](../../infra/terraform/modules/storage).
This doc is the key-scheme convention apps must follow — the Terraform module provisions the
buckets and their lifecycle rules; it has no way to enforce what key an application writes an
object under. A key that doesn't follow this scheme still uploads fine; it just silently misses
the lifecycle rule (or another school's tenant boundary) that the scheme exists to give it.

## Why category comes before schoolId, not after

The `temp-expiration` and `reports-expiration` lifecycle rules on `app-files`
(`modules/storage/main.tf`) each match on a single S3 key **prefix** — `temp/` and `reports/`.
S3 lifecycle prefix filters match literally from the start of the key; there is no wildcard or
"any depth" option. A key like `schools/<schoolId>/temp/<file>` would need one lifecycle rule
per `schoolId` to expire correctly, which isn't viable — schools are created and deleted by the
application at runtime, not by a Terraform apply.

Putting the lifecycle category first solves this with a fixed, small number of rules that cover
every school:

```
temp/<schoolId>/<objectId>/<filename>
reports/<schoolId>/<objectId>/<filename>
permanent/<schoolId>/<objectId>/<filename>
quarantine/<schoolId>/<objectId>/<filename>
```

## `app-files` bucket

| Top-level prefix | Purpose                                                                                          | Lifecycle                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `temp/`          | Staging area for pre-signed uploads before the app confirms/processes them                       | Expires after 1 day (24h)                                         |
| `reports/`       | Generated exports (e.g. PDF/CSV reports) offered for download                                    | Expires after 7 days                                              |
| `permanent/`     | Confirmed, long-lived user content (avatars, assignment attachments, etc.)                       | No expiration                                                     |
| `quarantine/`    | Objects a malware scan flagged. Never served; copied here, then the `permanent/` copy is deleted | No expiration (retain for forensics; expiry is a future decision) |

Flow for a pre-signed upload:

1. `apps/api` issues a pre-signed `PUT`/`POST` URL for a key under
   `temp/<schoolId>/<objectId>/<filename>`.
2. `apps/web` uploads directly to S3 using that URL (this is what `web_origin` in the CORS
   config exists for — the app's own frontend origin, not S3's).
3. Once `apps/api` confirms the upload (e.g. via a completion callback or a `HeadObject` check),
   it moves/copies the object to `permanent/<schoolId>/<objectId>/<filename>` — S3 doesn't have a
   true move, so this is a `CopyObject` + `DeleteObject` pair — after which it is out of `temp/`
   and no longer subject to the 24h rule.
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

## `backups-archive` bucket

No lifecycle-category prefix, because everything in this bucket is a durable backup, not a
short-lived category-of-the-moment object:

```
<schoolId>/<backupDate>/<snapshot-or-export-name>
```

e.g. `a1b2c3d4/2026-07-10/db-snapshot.sql.gz`. `schoolId` is still first — the same "fixed small
number of lifecycle rules" argument doesn't apply here (there are none), but keeping the prefix
order consistent with `app-files` means a script that lists "everything for school X" uses the
same `<schoolId>/` prefix convention in both buckets, rather than a different rule per bucket.

## `schoolId` format

Match whatever `apps/realtime` already uses for tenant scoping
(`school:<schoolId>:role:<role>` room keys, `apps/realtime/src/rooms.ts`) — treat it as an
opaque string identifier, not a slug you re-derive or reformat for storage keys. Don't URL-encode
or transform it; if it's already a valid room-key segment, it's already a valid S3 key segment.

## Access scoping

IAM policies for the role that generates pre-signed URLs should scope `s3:PutObject`/
`s3:GetObject` to `arn:aws:s3:::<app-files-bucket>/*/<schoolId>/*` where possible (per-request,
not a static policy — the `schoolId` isn't known until request time) so that a compromised or
buggy pre-signed-URL request for one school can't be pointed at another school's prefix. This is
an application-layer control (the pre-signing code decides what key it signs for); the Terraform
module has no visibility into which `schoolId` a given request is for.

## Known gaps

- No compute tier exists yet (`infra/terraform/README.md`), so nothing in this repo actually
  generates a pre-signed URL today. This doc describes the key scheme that code should follow
  when it's written, not something already exercised end-to-end.
- The `temp/` → `permanent/` move step is application logic that doesn't exist yet either. Until
  it does, verify the module's lifecycle rules with the manual test-object procedure in
  [`modules/storage/README.md`](../../infra/terraform/modules/storage/README.md#verifying-lifecycle-rules-with-test-objects).
