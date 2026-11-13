import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useCreateSchoolExport, useSchoolExportLink, useSchoolExportsQuery } from "./school-admin";

import type { PlatformSchoolExport } from "./school-admin";

/**
 * Whole-school data exports (`/api/platform/schools/{schoolId}/exports`): a ZIP of every table and
 * stored file the school owns, built in the background and deleted 30 days after it completes.
 * Download links are fetched on click, because each one issued is audited.
 */
export function SchoolExportsCard({
  schoolId,
  schoolName,
}: {
  schoolId: string;
  schoolName: string;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const { data: exports, isPending, isError } = useSchoolExportsQuery(schoolId);
  const link = useSchoolExportLink(schoolId);
  const [requesting, setRequesting] = useState(false);
  const running = exports?.some((item) => item.status === "queued" || item.status === "processing");

  const date = (value: string | null) =>
    value ? formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" }) : "—";

  function download(item: PlatformSchoolExport) {
    link.mutate(item.id, {
      onSuccess: (fresh) => {
        if (fresh.downloadUrl) {
          window.location.assign(fresh.downloadUrl);
        } else {
          show({ variant: "error", title: t("platform.school.exports.noLink") });
        }
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("platform.school.exports.linkError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <Card as="section" aria-labelledby="platform-exports-title">
      <Card.Header>
        <h2 id="platform-exports-title">{t("platform.school.exports.title")}</h2>
      </Card.Header>
      <Card.Body>
        <p className="platform-muted">{t("platform.school.exports.description")}</p>
        <div className="platform-actions">
          <Button variant="secondary" disabled={running} onClick={() => setRequesting(true)}>
            {t("platform.school.exports.request")}
          </Button>
        </div>
        {isPending ? (
          <p role="status">{t("site.common.loading")}</p>
        ) : isError ? (
          <p role="alert">{t("platform.school.exports.loadError")}</p>
        ) : !exports || exports.length === 0 ? (
          <p className="platform-muted">{t("platform.school.exports.empty")}</p>
        ) : (
          <table className="platform-usage-table">
            <caption className="sf-visually-hidden">{t("platform.school.exports.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("platform.school.exports.requested")}</th>
                <th scope="col">{t("platform.school.exports.status")}</th>
                <th scope="col">{t("platform.school.exports.expires")}</th>
                <th scope="col">
                  <span className="sf-visually-hidden">{t("platform.school.exports.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {exports.map((item) => (
                <tr key={item.id}>
                  <td>{date(item.createdAt)}</td>
                  <td>
                    {t(`platform.school.exports.statuses.${item.status}`)}
                    {item.status === "failed" && item.failureMessage ? (
                      <span className="platform-muted"> · {item.failureMessage}</span>
                    ) : null}
                  </td>
                  <td>
                    {item.deletedAt
                      ? t("platform.school.exports.deleted")
                      : item.expiresAt
                        ? date(item.expiresAt)
                        : "—"}
                  </td>
                  <td>
                    {item.status === "completed" && !item.deletedAt ? (
                      <Button
                        variant="tertiary"
                        loading={link.isPending && link.variables === item.id}
                        onClick={() => download(item)}
                      >
                        {t("platform.school.exports.download")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card.Body>
      <RequestExportDialog
        schoolId={schoolId}
        schoolName={schoolName}
        open={requesting}
        onClose={() => setRequesting(false)}
      />
    </Card>
  );
}

function RequestExportDialog({
  schoolId,
  schoolName,
  open,
  onClose,
}: {
  schoolId: string;
  schoolName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateSchoolExport(schoolId);
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3;

  function close() {
    setReason("");
    onClose();
  }

  function submit() {
    if (!reasonValid) return;
    create.mutate(reason.trim(), {
      onSuccess: () => {
        show({ variant: "success", title: t("platform.school.exports.queued") });
        close();
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("platform.school.exports.requestError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("platform.school.exports.request")}
      description={schoolName}
    >
      <Modal.Body>
        <p>{t("platform.school.exports.consequence")}</p>
        <Input
          label={t("platform.school.exports.reasonLabel")}
          helperText={t("platform.school.exports.reasonHelp")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!reasonValid}
          loading={create.isPending}
          onClick={submit}
        >
          {t("platform.school.exports.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
