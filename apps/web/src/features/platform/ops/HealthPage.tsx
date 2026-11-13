import { Button, DataGrid } from "@studafy/ui";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { useSystemHealthQuery } from "./queries";

import "../platform.css";
import "./ops.css";

import type { PlatformSystemHealth } from "./queries";
import type { DataGridColumn } from "@studafy/ui";

type QueueRow = PlatformSystemHealth["jobs"]["queues"][number];
type ScheduledRow = PlatformSystemHealth["jobs"]["scheduled"][number];
type StorageRow = PlatformSystemHealth["storage"]["schools"][number];
type DeadLetterRow = PlatformSystemHealth["notificationDeadLetters"]["bySchool"][number];
type WebhookFailureRow = PlatformSystemHealth["webhooks"]["recentFailures"][number];

const KIB = 1024;

function formatBytes(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KB`;
  if (bytes < KIB * KIB * KIB) return `${(bytes / KIB / KIB).toFixed(1)} MB`;
  return `${(bytes / KIB / KIB / KIB).toFixed(1)} GB`;
}

/**
 * System health (`/portal/platform/health`): background jobs, notification dead letters, payment
 * webhook failures, email bounces and the latest storage reconciliation -- read-only, from what the
 * platform already records. Signals it doesn't record are listed at the bottom, not guessed.
 */
export default function HealthPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { data, isPending, isError, isFetching, refetch } = useSystemHealthQuery();

  const when = (iso: string | null) =>
    iso ? formatDate(new Date(iso), { dateStyle: "medium", timeStyle: "short" }) : "—";

  const queueColumns: DataGridColumn<QueueRow>[] = [
    {
      id: "queue",
      header: t("platform.health.columns.queue"),
      renderCell: (row) => (
        <span>
          <code>{row.queue}</code>
          {row.deadLetter ? ` · ${t("platform.health.deadLetter")}` : ""}
        </span>
      ),
    },
    {
      id: "waiting",
      header: t("platform.health.columns.waiting"),
      renderCell: (row) => formatNumber(row.waiting),
    },
    {
      id: "active",
      header: t("platform.health.columns.active"),
      renderCell: (row) => formatNumber(row.active),
    },
    {
      id: "delayed",
      header: t("platform.health.columns.delayed"),
      renderCell: (row) => formatNumber(row.delayed),
    },
    {
      id: "failed",
      header: t("platform.health.columns.failed"),
      renderCell: (row) => (
        <span data-alert={row.failed > 0 || undefined} className="platform-ops-count">
          {formatNumber(row.failed)}
        </span>
      ),
    },
    {
      id: "latest",
      header: t("platform.health.columns.latestFailure"),
      renderCell: (row) => {
        const latest = row.recentFailures[0];
        return latest ? (
          <div className="platform-cell-stack">
            <span>
              {latest.jobName} · {when(latest.failedAt)}
            </span>
            {latest.reason ? <span className="platform-muted">{latest.reason}</span> : null}
          </div>
        ) : (
          "—"
        );
      },
    },
  ];

  const scheduledColumns: DataGridColumn<ScheduledRow>[] = [
    {
      id: "job",
      header: t("platform.health.columns.job"),
      renderCell: (row) => (
        <div className="platform-cell-stack">
          <span>{row.jobName}</span>
          <span className="platform-muted">
            {row.queue} · {row.schedule ?? "—"}
          </span>
        </div>
      ),
    },
    {
      id: "last",
      header: t("platform.health.columns.lastRun"),
      renderCell: (row) =>
        row.lastRun ? (
          <div className="platform-cell-stack">
            <span data-alert={row.lastRun.outcome === "failed" || undefined}>
              {t(`platform.health.outcome.${row.lastRun.outcome}`)} · {when(row.lastRun.at)}
            </span>
            {row.lastRun.error ? <span className="platform-muted">{row.lastRun.error}</span> : null}
          </div>
        ) : (
          <span className="platform-muted">{t("platform.health.noRecentRun")}</span>
        ),
    },
    {
      id: "next",
      header: t("platform.health.columns.nextRun"),
      renderCell: (row) => when(row.nextRunAt),
    },
  ];

  const deadLetterColumns: DataGridColumn<DeadLetterRow>[] = [
    {
      id: "school",
      header: t("platform.health.columns.school"),
      renderCell: (row) => (
        <Link to={`/portal/platform/schools/${row.schoolId}`}>{row.schoolName}</Link>
      ),
    },
    {
      id: "count",
      header: t("platform.health.columns.count"),
      renderCell: (row) => formatNumber(row.count),
    },
    {
      id: "last",
      header: t("platform.health.columns.lastFailed"),
      renderCell: (row) => when(row.lastFailedAt),
    },
  ];

  const webhookColumns: DataGridColumn<WebhookFailureRow>[] = [
    {
      id: "event",
      header: t("platform.health.columns.event"),
      renderCell: (row) => (
        <div className="platform-cell-stack">
          <span>
            {row.provider} · <code>{row.eventType}</code>
          </span>
          {row.error ? <span className="platform-muted">{row.error}</span> : null}
        </div>
      ),
    },
    {
      id: "status",
      header: t("platform.health.columns.status"),
      renderCell: (row) => `${row.status} (${formatNumber(row.attempts)})`,
    },
    {
      id: "received",
      header: t("platform.health.columns.received"),
      renderCell: (row) => when(row.receivedAt),
    },
  ];

  const storageColumns: DataGridColumn<StorageRow>[] = [
    {
      id: "school",
      header: t("platform.health.columns.school"),
      renderCell: (row) =>
        row.schoolName === row.schoolId ? (
          <code>{row.schoolId}</code>
        ) : (
          <Link to={`/portal/platform/schools/${row.schoolId}`}>{row.schoolName}</Link>
        ),
    },
    {
      id: "used",
      header: t("platform.health.columns.used"),
      renderCell: (row) => (row.failed ? "—" : formatBytes(row.bytesUsed)),
    },
    {
      id: "orphans",
      header: t("platform.health.columns.orphans"),
      renderCell: (row) =>
        row.failed
          ? t("platform.health.reconcileFailed")
          : `${formatNumber(row.orphans)} · ${formatBytes(row.orphanBytes)}`,
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.health.title")}
        description={t("platform.health.description")}
        actions={
          <Button
            type="button"
            variant="secondary"
            loading={isFetching}
            onClick={() => void refetch()}
          >
            {t("platform.health.refresh")}
          </Button>
        }
      />
      {isPending ? <p className="platform-muted">{t("platform.health.loading")}</p> : null}
      {isError ? <p role="alert">{t("platform.health.loadError")}</p> : null}
      {data ? (
        <div className="platform-ops-sections">
          <p className="platform-muted">
            {t("platform.health.generated", {
              when: when(data.generatedAt),
              days: data.windowDays,
            })}
          </p>

          <section aria-labelledby="health-jobs">
            <h2 id="health-jobs">{t("platform.health.jobsHeading")}</h2>
            {data.jobs.available ? (
              <>
                <DataGrid
                  caption={t("platform.health.queuesCaption")}
                  columns={queueColumns}
                  rows={data.jobs.queues}
                  getRowId={(row) => row.queue}
                  getRowLabel={(row) => row.queue}
                  empty={t("platform.health.none")}
                />
                <DataGrid
                  caption={t("platform.health.scheduledCaption")}
                  columns={scheduledColumns}
                  rows={data.jobs.scheduled}
                  getRowId={(row) => `${row.queue}:${row.schedulerId}`}
                  getRowLabel={(row) => row.jobName}
                  empty={t("platform.health.none")}
                />
              </>
            ) : (
              <p className="platform-muted">{t("platform.health.jobsUnavailable")}</p>
            )}
          </section>

          <section aria-labelledby="health-dead-letters">
            <h2 id="health-dead-letters">
              {t("platform.health.deadLettersHeading", {
                count: data.notificationDeadLetters.total,
              })}
            </h2>
            <DataGrid
              caption={t("platform.health.deadLettersCaption")}
              columns={deadLetterColumns}
              rows={data.notificationDeadLetters.bySchool}
              getRowId={(row) => row.schoolId}
              getRowLabel={(row) => row.schoolName}
              empty={t("platform.health.none")}
            />
          </section>

          <section aria-labelledby="health-webhooks">
            <h2 id="health-webhooks">{t("platform.health.webhooksHeading")}</h2>
            <ul className="platform-ops-stats">
              {data.webhooks.failedEvents.map((row) => (
                <li key={row.provider}>
                  {t("platform.health.failedEvents", {
                    provider: row.provider,
                    count: row.count,
                  })}
                </li>
              ))}
              {data.webhooks.rejectedSignatures.map((row) => (
                <li key={row.type}>
                  {t(`platform.health.signature.${row.type}`, {
                    defaultValue: row.type,
                    count: row.count,
                  })}
                  : {formatNumber(row.count)}
                </li>
              ))}
              {data.webhooks.failedEvents.length === 0 &&
              data.webhooks.rejectedSignatures.length === 0 ? (
                <li>{t("platform.health.noWebhookFailures")}</li>
              ) : null}
            </ul>
            {data.webhooks.recentFailures.length > 0 ? (
              <DataGrid
                caption={t("platform.health.webhookFailuresCaption")}
                columns={webhookColumns}
                rows={data.webhooks.recentFailures}
                getRowId={(row) => `${row.provider}:${row.eventType}:${row.receivedAt}`}
                getRowLabel={(row) => row.eventType}
                empty={t("platform.health.none")}
              />
            ) : null}
          </section>

          <section aria-labelledby="health-email">
            <h2 id="health-email">{t("platform.health.emailHeading")}</h2>
            <ul className="platform-ops-stats">
              <li data-alert={data.email.bounces > 0 || undefined}>
                {t("platform.health.bounces")}: {formatNumber(data.email.bounces)}
              </li>
              <li data-alert={data.email.complaints > 0 || undefined}>
                {t("platform.health.complaints")}: {formatNumber(data.email.complaints)}
              </li>
              <li>
                {t("platform.health.deliveries")}: {formatNumber(data.email.deliveries)}
              </li>
            </ul>
          </section>

          <section aria-labelledby="health-storage">
            <h2 id="health-storage">{t("platform.health.storageHeading")}</h2>
            {!data.storage.available ? (
              <p className="platform-muted">{t("platform.health.storageUnavailable")}</p>
            ) : data.storage.lastRunAt === null ? (
              <p className="platform-muted">{t("platform.health.storageNoRun")}</p>
            ) : (
              <>
                <p>
                  {t("platform.health.storageSummary", {
                    when: when(data.storage.lastRunAt),
                    schools: data.storage.totals?.schools ?? 0,
                    orphans: data.storage.totals?.orphans ?? 0,
                    size: formatBytes(data.storage.totals?.orphanBytes ?? 0),
                  })}
                </p>
                <p className="platform-muted">{t("platform.health.storageReportOnly")}</p>
                <DataGrid
                  caption={t("platform.health.storageCaption")}
                  columns={storageColumns}
                  rows={data.storage.schools}
                  getRowId={(row) => row.schoolId}
                  getRowLabel={(row) => row.schoolName}
                  empty={t("platform.health.noOrphans")}
                />
              </>
            )}
          </section>

          {data.notAvailable.length > 0 ? (
            <section aria-labelledby="health-not-available">
              <h2 id="health-not-available">{t("platform.health.notAvailableHeading")}</h2>
              <ul className="platform-ops-stats">
                {data.notAvailable.map((key) => (
                  <li key={key}>
                    {t(`platform.health.notAvailable.${key}`, { defaultValue: key })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
