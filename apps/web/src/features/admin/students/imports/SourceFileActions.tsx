import { ApiError } from "@studafy/api-client";
import { Button, Modal, ModalBody, ModalFooter } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../../lib/i18n";

import { useDeleteImportSource, useDownloadImportSource } from "./mutations";

import type { ImportRecord } from "./queries";

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

interface SourceFileActionsProps {
  record: Pick<ImportRecord, "id" | "source_file">;
  onError: (message: string) => void;
}

/**
 * The original file of one import: download (a one-minute signed URL, audited) and delete, or why it
 * is no longer there. Deleting asks first; it cannot be undone.
 */
export function SourceFileActions({ record, onError }: SourceFileActionsProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const download = useDownloadImportSource();
  const remove = useDeleteImportSource();
  const [confirming, setConfirming] = useState(false);
  const file = record.source_file;

  if (!file) {
    return <span>{t("adminPeople.students.importHistory.file.notKept")}</span>;
  }
  if (!file.stored) {
    const when = file.removed_at
      ? formatDate(new Date(file.removed_at), { dateStyle: "medium" })
      : "";
    return (
      <span>
        {t(`adminPeople.students.importHistory.file.removed.${file.removed_reason ?? "deleted"}`, {
          date: when,
        })}
      </span>
    );
  }

  function handleDownload() {
    download.mutate(record.id, {
      onSuccess: (url) => window.location.assign(url),
      onError: (error) =>
        onError(apiErrorMessage(error, t("adminPeople.students.importHistory.file.downloadError"))),
    });
  }

  function handleDelete() {
    remove.mutate(record.id, {
      onSuccess: () => setConfirming(false),
      onError: (error) => {
        setConfirming(false);
        onError(apiErrorMessage(error, t("adminPeople.students.importHistory.file.deleteError")));
      },
    });
  }

  return (
    <div className="import-history__file-actions">
      <Button
        type="button"
        variant="secondary"
        onClick={handleDownload}
        loading={download.isPending}
        aria-label={t("adminPeople.students.importHistory.file.downloadNamed", {
          name: file.file_name,
        })}
      >
        {t("adminPeople.students.importHistory.file.download")}
      </Button>
      <Button
        type="button"
        variant="tertiary"
        onClick={() => setConfirming(true)}
        aria-label={t("adminPeople.students.importHistory.file.deleteNamed", {
          name: file.file_name,
        })}
      >
        {t("adminPeople.students.importHistory.file.delete")}
      </Button>
      {file.expires_at ? (
        <small>
          {t("adminPeople.students.importHistory.file.expires", {
            date: formatDate(new Date(file.expires_at), { dateStyle: "medium" }),
          })}
        </small>
      ) : null}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("adminPeople.students.importHistory.file.confirmTitle")}
      >
        <ModalBody>
          <p>
            {t("adminPeople.students.importHistory.file.confirmBody", { name: file.file_name })}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="tertiary" onClick={() => setConfirming(false)}>
            {t("adminPeople.students.importHistory.common.cancel")}
          </Button>
          <Button type="button" onClick={handleDelete} loading={remove.isPending}>
            {t("adminPeople.students.importHistory.file.confirmDelete")}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
