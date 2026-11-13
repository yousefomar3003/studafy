import { Button, Table, useToast } from "@studafy/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { NewPrivacyRequestModal } from "./NewPrivacyRequestModal";
import {
  PRIVACY_REQUESTS_KEY,
  fetchExportDownload,
  isExportDeleted,
  usePrivacyRequests,
} from "./queries";

import type { SchoolPrivacyRequest } from "./queries";

import "./privacy.css";

const COLUMN_COUNT = 6;

/** Erasure blanks a nullable name and overwrites a required one with `erased-<uuid>`; either way
 * there is no name left to show. */
function subjectName(request: SchoolPrivacyRequest): string | null {
  const name = request.subject_display_name;
  return name && !name.startsWith("erased-") ? name : null;
}

/**
 * Privacy requests (`/portal/admin/privacy`), gated on `privacy:manageDsr` (ORG_ADMIN): every
 * request to export or erase what the school holds about one person, with its status and the
 * 30-day deadline it must be finished by. A finished export is downloaded from here; the link is
 * signed on demand and expires after a few minutes. The bundle itself is deleted 30 days after the
 * export finished, after which the row says so instead of offering a download.
 */
export default function PrivacyRequestsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const requests = usePrivacyRequests();
  const [filing, setFiling] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const when = (value: string | null) =>
    value ? formatDate(new Date(value), { dateStyle: "medium" }) : "—";

  async function download(request: SchoolPrivacyRequest) {
    setDownloading(request.id);
    try {
      const { url, deleted } = await fetchExportDownload(request.id);
      if (deleted) {
        // Deleted since the list was loaded: say why, and refresh the row so it shows as such.
        show({
          variant: "error",
          title: t("adminSchool.privacy.exportDeletedToast.title"),
          description: t("adminSchool.privacy.exportDeletedToast.description"),
        });
        void queryClient.invalidateQueries({ queryKey: PRIVACY_REQUESTS_KEY });
        return;
      }
      if (!url) throw new Error("No download link.");
      window.open(url, "_blank", "noopener");
    } catch {
      show({ variant: "error", title: t("adminSchool.privacy.downloadFailed") });
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <div className="privacy-page__header">
        <div>
          <h1>{t("adminSchool.privacy.title")}</h1>
          <p>{t("adminSchool.privacy.description")}</p>
        </div>
        <Button type="button" onClick={() => setFiling(true)}>
          {t("adminSchool.privacy.newRequest")}
        </Button>
      </div>

      <Table caption={t("adminSchool.privacy.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.person")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.type")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.filed")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.due")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.privacy.columns.result")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={requests.isPending}
          empty={
            requests.isError ? t("adminSchool.privacy.loadError") : t("adminSchool.privacy.empty")
          }
        >
          {(requests.data ?? []).map((request) => (
            <Table.Row key={request.id}>
              <Table.Cell>
                {subjectName(request) ?? t("adminSchool.privacy.removedPerson")}
              </Table.Cell>
              <Table.Cell>{t(`adminSchool.privacy.type.${request.request_type}`)}</Table.Cell>
              <Table.Cell>
                <span className="privacy-page__status" data-status={request.status}>
                  {t(`adminSchool.privacy.status.${request.status}`)}
                </span>
              </Table.Cell>
              <Table.Cell>{when(request.created_at)}</Table.Cell>
              <Table.Cell>
                {request.status === "completed"
                  ? t("adminSchool.privacy.completedOn", { date: when(request.completed_at) })
                  : when(request.sla_due_at)}
              </Table.Cell>
              <Table.Cell>
                {request.status === "completed" && request.request_type === "export" ? (
                  isExportDeleted(request) ? (
                    <span className="privacy-page__expired">
                      {t("adminSchool.privacy.exportDeleted")}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="tertiary"
                      loading={downloading === request.id}
                      aria-label={t("adminSchool.privacy.downloadLabel", {
                        name: subjectName(request) ?? t("adminSchool.privacy.removedPerson"),
                      })}
                      onClick={() => void download(request)}
                    >
                      {t("adminSchool.privacy.download")}
                    </Button>
                  )
                ) : request.status === "failed" ? (
                  (request.failure_message ?? t("adminSchool.privacy.failedFallback"))
                ) : (
                  "—"
                )}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <NewPrivacyRequestModal open={filing} onClose={() => setFiling(false)} />
    </>
  );
}
