# Async report framework

ST-175 unifies the attendance and finance export processors behind one registry-driven lifecycle.
A "report type" is a data object — payload schema, state store, renderer, storage key, content
headers — and the generic runner sequences the shared steps the two workers previously
copy-pasted: claim the lifecycle row, render, upload, optionally persist a signed URL, mark ready.
The expiry sweep is the DB-driven closure for report artifacts.

All framework code lives in `apps/workers/src/queues/reports/`. The registry and dispatch
(`report-registry.ts`) is what `QUEUE_REGISTRY`'s `reports` processor hands every job to
(`apps/workers/src/registry.ts`).

## How a report job is processed

```
BullMQ job on QUEUE_NAMES.REPORTS
  └─ processReportJob(job, config)        report-registry.ts
       ├─ name == PURGE_EXPIRED_REPORTS → purgeExpiredReports(...)     (scheduled, not a report)
       └─ lookupReportType(name) → ReportTypeDefinition
            ├─ unknown → { processed: false, reason: "unknown report job" }
            └─ openReportPorts(config) → runReport(job, definition, config, ports)
                 parse payload with definition.schema
                   → { processed: false, reason: "invalid job data" } on parse failure
                 store.claim(sql, ctx)                  lock row FOR UPDATE, mark processing
                   → terminal (already completed/failed): skip, { processed: true }
                 definition.render(deps)                the report body, under replica scope
                 s3.put(storageKey, artifact, { contentType, contentDisposition })
                 if store.persistsSignedUrl → s3.presignGet(key) (24h TTL)
                 store.complete(sql, ctx, key, signedUrl)
                 → { processed: true, storageKey, bytes }
                 on error: store.fail only on the final BullMQ attempt, then rethrow
                 finally: closeReportPorts (primary + replica pools end)
```

The `reports` queue has concurrency 3; each job owns one primary pool (max 2) and, when a read
replica is configured, one replica pool (max 3), opened and closed per job in `openReportPorts` /
`closeReportPorts`. Pools connect lazily, so a job that short-circuits (unknown name, unparseable
payload) never touches the database.

## The ports

`report-types.ts` defines the contracts; `report-state-store.ts` is the lifecycle-row port.
The runner knows nothing about either report table's schema.

- `ReportTypeDefinition<TData, TRecord>` — one registry entry. `jobName`, `schema`
  (`z.ZodType<TData>`), `store`, `render`, `storageKey(data, record)`, `contentType(data, record)`,
  `contentDisposition(data, record)`.
- `ReportStateStore<TRecord>` — `persistsSignedUrl` (whether the runner must persist a signed URL
  after upload), `claim(sql, ctx)` → `ReportClaim`, `complete(sql, ctx, key, signedUrl?)`, `fail`.
- `ReportClaim` — `{ state: "new", record? }` (locked and processing; `record` is whatever the
  store read at claim time the renderer/storage key need) or `{ state: "terminal" }` (the row was
  already completed/failed, so a duplicate delivery is a no-op).
- `ReportS3Client` — `put` / `remove` / `presignGet`. Narrow on purpose: tests hand the runner an
  in-memory fake.
- `ReportRenderDeps<TData, TRecord>` — what a renderer receives: `primary`, `replica?`, `context`
  (`jobId`, `schoolId`, `requestedByUserId`), `data` (parsed payload), `record?`, `now`, `config`.

Canonical statuses are `queued | processing | ready | failed`; each store maps its table's native
enum onto them. `ready` is the completed, downloadable state.

### State stores

- `attendance-report-store.ts` → `createAttendanceReportStore()` against
  `app.report_export_jobs`. `persistsSignedUrl: false` — attendance downloads go through the API
  which re-signs on demand. `claim` treats `completed` as terminal and resets
  `storage_key/error_message/completed_at` on re-claim, so a retried job writes a fresh artifact.
- `finance-report-store.ts` → `createFinanceReportStore()` against `app.finance_report_jobs`.
  `persistsSignedUrl: true` — the durable 24-hour signed URL is what `GET /api/finance/reports/
export/{jobId}/download` serves. `record` is the `FinanceReportJobRow` (report type, format,
  parameters, created_at) the renderer needs; `claim` preserves the first `started_at` and uses
  `clock_timestamp()`.

## Adding a report type

A third report type is one registry entry plus a store and a renderer — no lifecycle code.

1. **Schema** — the BullMQ payload. It must carry `jobId`, `schoolId`, `requestedByUserId`
   (`ReportJobContext`), e.g. an existing zod schema in `@studafy/*-reporting`.
2. **Store** — a `ReportStateStore` adapter over the report's lifecycle table (copy
   `attendance-report-store.ts` or `finance-report-store.ts`), mapping the native status enum onto
   the canonical statuses and deciding `persistsSignedUrl`.
3. **Renderer** — `render(deps) => Promise<Uint8Array>`. Reads whatever it needs under
   `withTenantTx`/`withSystemTenantTx` and returns the artifact bytes. Reuse `./render.ts`'s
   `renderXlsx`/`renderPdf` where the shape fits.
4. **Key + headers** — deterministic `storageKey(data, record)`, `contentType`, `contentDisposition`.
5. **Register** — add the entry to `REPORT_TYPE_REGISTRY` in `report-registry.ts`. The functional
   fields are declared as methods (not arrow properties) so TypeScript's bivariant method
   parameter checking lets entries for different report tables sit side by side under the erased
   `ReportTypeDefinition<ReportJobContext>` array type without a cast.
6. **Job name** — add it to `JOB_NAMES` in `packages/constants/src/queues.ts` and rebuild the
   constants package (`bun run --cwd packages/constants build`): its `exports.types` points at
   `dist/`, so the workers typecheck reads the built declarations.

Retries reuse the same object key (keys are a pure function of the payload/job row), completed
jobs are idempotent, and only a generic failure is persisted on the final attempt — earlier
attempts leave the row `processing` so a later delivery can pick it up.

## Expiry sweep

The app-files bucket lifecycle rule expires `reports/<schoolId>/...` objects after 7 days, but it
only matches that prefix — legacy finance keys under `tenant-<schoolId>/reports/` are invisible to
it (see `docs/runbooks/storage-conventions.md` "Known gaps"). The daily sweep
(`purge-expired-reports`, `report-expiry-sweep.ts`) is the DB-driven closure for both prefixes.

- Runs once a day (07:00 UTC, `REPORT_EXPIRY_CRON_PATTERN` in `report-expiry-scheduler.ts`,
  registered in `apps/workers/src/index.ts`).
- For each school, in its own transaction: select completed rows older than
  `REPORT_RETENTION_DAYS` (7) with an artifact key from both tables, `s3.remove` each key, then
  delete the rows — the API reports a clean 404 instead of a URL that 403s.
- Crash-safe and idempotent: a school that fails mid-way (S3 or database error) is counted in
  `result.failed` and simply selected again next run; `DeleteObject` on a missing key is a no-op.
- The finance rows removed here are the legacy `tenant-<schoolId>/reports/` keys; canonical
  `reports/<schoolId>/...` keys are removed through the same predicate when their DB row is old
  enough that the bucket lifecycle rule hasn't already reclaimed the object.

## Storage keys

| Report            | Key                                                                  | Signed URL |
| ----------------- | -------------------------------------------------------------------- | ---------- |
| Attendance export | `reports/<schoolId>/<jobId>/attendance-summary.<xlsx\|pdf>`          | no         |
| Finance export    | `tenant-<schoolId>/reports/<UTC-year>/<jobId>.<csv\|pdf\|xml\|json>` | yes (24h)  |

See `docs/runbooks/storage-conventions.md` for the bucket scheme.

## Tests

- `report-runner.test.ts` — the shared lifecycle against in-memory fakes: claim → render → put →
  complete, terminal claims skip, the signed URL only when `persistsSignedUrl`, failure marks the
  row only on the final attempt, and the async-verified ordering that a concurrent client sees
  `processing` before the artifact exists.
- `report-registry.test.ts` — registry shape, lookup by job name, full report-type surface per
  entry, and the no-database short-circuits of `processReportJob`.
- `report-expiry-sweep.test.ts` — DB integration (`skipIf(!TEST_DATABASE_URL)`): purges only old
  completed artifacts from both tables, keeps decoys, and isolates a failing school.
- `attendance-export.worker.test.ts` / `finance-export.worker.test.ts` — the renderers and storage
  keys, unchanged by the refactor (`isFinalExportAttempt` is re-exported from the runner).
