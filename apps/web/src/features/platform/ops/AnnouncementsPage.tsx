import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { useAnnouncementsQuery, useCreateAnnouncement, useUpdateAnnouncement } from "./queries";

import "../platform.css";
import "./ops.css";

import type {
  PlatformAnnouncement,
  PlatformAnnouncementAudience,
  PlatformAnnouncementSeverity,
} from "./queries";
import type { DataGridColumn } from "@studafy/ui";
import type { FormEvent } from "react";

const HOUR = 60 * 60 * 1000;

/** `yyyy-mm-ddThh:mm` in local time, what a datetime-local input holds. */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Studafy-wide banners (`/portal/platform/announcements`): schedule a message every signed-in user,
 * or every school's staff, sees at the top of the portal (and the mobile app) between two times.
 * Maintenance banners can't be dismissed. Every change carries a reason for the audit log.
 */
export default function AnnouncementsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { data, isPending, isError } = useAnnouncementsQuery();
  const [ending, setEnding] = useState<PlatformAnnouncement | null>(null);

  const when = (iso: string) =>
    formatDate(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const columns: DataGridColumn<PlatformAnnouncement>[] = [
    {
      id: "message",
      header: t("platform.announcements.columns.message"),
      renderCell: (item) => (
        <div className="platform-cell-stack">
          <span>{item.messageEn}</span>
          {item.messageAr ? (
            <span dir="rtl" lang="ar" className="platform-muted">
              {item.messageAr}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "state",
      header: t("platform.announcements.columns.state"),
      renderCell: (item) => (
        <span className="platform-pill" data-status={item.state}>
          {t(`platform.announcements.state.${item.state}`)}
        </span>
      ),
    },
    {
      id: "severity",
      header: t("platform.announcements.columns.severity"),
      renderCell: (item) => t(`platform.announcements.severity.${item.severity}`),
    },
    {
      id: "audience",
      header: t("platform.announcements.columns.audience"),
      renderCell: (item) => t(`platform.announcements.audience.${item.audience}`),
    },
    {
      id: "window",
      header: t("platform.announcements.columns.window"),
      renderCell: (item) => `${when(item.startsAt)} – ${when(item.endsAt)}`,
    },
    {
      id: "actions",
      header: t("platform.announcements.columns.actions"),
      renderCell: (item) =>
        item.state === "ended" ? (
          "—"
        ) : (
          <Button type="button" variant="secondary" onClick={() => setEnding(item)}>
            {t("platform.announcements.endNow")}
          </Button>
        ),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.announcements.title")}
        description={t("platform.announcements.description")}
      />
      <CreateAnnouncementForm />
      <DataGrid
        caption={t("platform.announcements.caption")}
        columns={columns}
        rows={data ?? []}
        getRowId={(item) => item.id}
        getRowLabel={(item) => item.messageEn}
        loading={isPending}
        empty={isError ? t("platform.announcements.loadError") : t("platform.announcements.empty")}
      />
      <EndAnnouncementModal announcement={ending} onClose={() => setEnding(null)} />
    </>
  );
}

function CreateAnnouncementForm() {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateAnnouncement();
  const [messageEn, setMessageEn] = useState("");
  const [messageAr, setMessageAr] = useState("");
  const [audience, setAudience] = useState<PlatformAnnouncementAudience>("all");
  const [severity, setSeverity] = useState<PlatformAnnouncementSeverity>("info");
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => toLocalInput(new Date(Date.now() + 24 * HOUR)));
  const [reason, setReason] = useState("");

  const start = startsAt ? new Date(startsAt) : null;
  const end = endsAt ? new Date(endsAt) : null;
  const windowValid =
    start !== null && end !== null && end.getTime() > start.getTime() && end.getTime() > Date.now();
  const valid = messageEn.trim() !== "" && reason.trim().length >= 3 && windowValid;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !start || !end) return;
    create.mutate(
      {
        messageEn: messageEn.trim(),
        messageAr: messageAr.trim() || null,
        audience,
        severity,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platform.announcements.created") });
          setMessageEn("");
          setMessageAr("");
          setReason("");
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.announcements.saveError"),
            description: errorDetail(error),
          }),
      },
    );
  }

  return (
    <form
      className="platform-ops-form"
      onSubmit={submit}
      aria-label={t("platform.announcements.formLabel")}
    >
      <h2>{t("platform.announcements.newHeading")}</h2>
      <Input
        label={t("platform.announcements.messageEn")}
        value={messageEn}
        maxLength={500}
        required
        onChange={(event) => setMessageEn(event.target.value)}
      />
      <Input
        label={t("platform.announcements.messageAr")}
        helperText={t("platform.announcements.messageArHelp")}
        value={messageAr}
        maxLength={500}
        dir="rtl"
        lang="ar"
        onChange={(event) => setMessageAr(event.target.value)}
      />
      <div className="platform-ops-form__row">
        <Select<PlatformAnnouncementAudience>
          label={t("platform.announcements.audienceLabel")}
          value={audience}
          onChange={setAudience}
          options={[
            { value: "all", label: t("platform.announcements.audience.all") },
            { value: "staff", label: t("platform.announcements.audience.staff") },
          ]}
        />
        <Select<PlatformAnnouncementSeverity>
          label={t("platform.announcements.severityLabel")}
          helperText={
            severity === "maintenance" ? t("platform.announcements.maintenanceHelp") : undefined
          }
          value={severity}
          onChange={setSeverity}
          options={[
            { value: "info", label: t("platform.announcements.severity.info") },
            { value: "warning", label: t("platform.announcements.severity.warning") },
            { value: "maintenance", label: t("platform.announcements.severity.maintenance") },
          ]}
        />
      </div>
      <div className="platform-ops-form__row">
        <Input
          label={t("platform.announcements.startsAt")}
          type="datetime-local"
          value={startsAt}
          required
          onChange={(event) => setStartsAt(event.target.value)}
        />
        <Input
          label={t("platform.announcements.endsAt")}
          type="datetime-local"
          value={endsAt}
          required
          error={
            startsAt && endsAt && !windowValid ? t("platform.announcements.windowError") : undefined
          }
          onChange={(event) => setEndsAt(event.target.value)}
        />
      </div>
      <Input
        label={t("platform.common.reason")}
        helperText={t("platform.announcements.reasonHelp")}
        value={reason}
        maxLength={500}
        required
        onChange={(event) => setReason(event.target.value)}
      />
      <div>
        <Button type="submit" variant="primary" disabled={!valid} loading={create.isPending}>
          {t("platform.announcements.publish")}
        </Button>
      </div>
    </form>
  );
}

function EndAnnouncementModal({
  announcement,
  onClose,
}: {
  announcement: PlatformAnnouncement | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateAnnouncement();
  const [reason, setReason] = useState("");

  function close() {
    setReason("");
    onClose();
  }

  function confirm() {
    if (!announcement || reason.trim().length < 3) return;
    update.mutate(
      { announcementId: announcement.id, endNow: true, reason: reason.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platform.announcements.ended") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.announcements.saveError"),
            description: errorDetail(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={announcement !== null}
      onClose={close}
      title={t("platform.announcements.endTitle")}
      description={announcement?.messageEn}
    >
      <Modal.Body>
        <Input
          label={t("platform.common.reason")}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={reason.trim().length < 3}
          loading={update.isPending}
          onClick={confirm}
        >
          {t("platform.announcements.endNow")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
