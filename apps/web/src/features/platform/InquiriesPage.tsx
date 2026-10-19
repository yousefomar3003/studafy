import { Button, DataGrid, Input, Modal, Select } from "@studafy/ui";
import { useEffect, useId, useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useUpdateInquiry } from "./mutations";
import { PlatformPageHeader } from "./PlatformNav";
import { INQUIRIES_PAGE_SIZE, useInquiriesQuery } from "./queries";

import "./platform.css";

import type { PlatformInquiry, PlatformInquiryStatus } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;
const STATUSES: readonly PlatformInquiryStatus[] = ["new", "contacted", "won", "lost"];

const STATUS_TONE: Record<PlatformInquiryStatus, "warning" | "success" | "danger" | undefined> = {
  new: "warning",
  contacted: undefined,
  won: "success",
  lost: "danger",
};

/**
 * "Talk to us" inquiries from the marketing site (`/portal/platform/inquiries`). Each one is also
 * emailed to the sales inbox set in Platform settings (`sales.inquiry_notification_email`); this
 * page is where the team tracks it from `new` to `won` or `lost`.
 */
export default function InquiriesPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PlatformInquiryStatus | "">("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => setPage(0), [search, status]);

  const { data, isPending, isError } = useInquiriesQuery({ search, status, page });
  const total = data?.total ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / INQUIRIES_PAGE_SIZE) - 1);
  const open = data?.inquiries.find((inquiry) => inquiry.id === openId) ?? null;

  const statusOptions: SelectOption<PlatformInquiryStatus | "">[] = [
    { value: "", label: t("platform.inquiries.allStatuses") },
    ...STATUSES.map((value) => ({ value, label: t(`platform.inquiries.status.${value}`) })),
  ];

  const columns: DataGridColumn<PlatformInquiry>[] = [
    {
      id: "contact",
      header: t("platform.inquiries.columns.contact"),
      renderCell: (inquiry) => (
        <div className="platform-cell-stack">
          <Button variant="tertiary" onClick={() => setOpenId(inquiry.id)}>
            {inquiry.fullName}
          </Button>
          <a className="platform-muted" href={`mailto:${inquiry.email}`}>
            {inquiry.email}
          </a>
        </div>
      ),
    },
    {
      id: "school",
      header: t("platform.inquiries.columns.school"),
      renderCell: (inquiry) => (
        <div className="platform-cell-stack">
          <span>{inquiry.schoolName}</span>
          <span className="platform-muted">
            {[
              inquiry.country,
              inquiry.studentCount === null
                ? null
                : t("platform.inquiries.students", { count: inquiry.studentCount }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      ),
    },
    {
      id: "status",
      header: t("platform.inquiries.columns.status"),
      renderCell: (inquiry) => <InquiryStatusPill status={inquiry.status} />,
    },
    {
      id: "received",
      header: t("platform.inquiries.columns.received"),
      renderCell: (inquiry) =>
        formatDate(new Date(inquiry.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    },
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platform.inquiries.title")}
        description={t("platform.inquiries.description")}
      />

      {data && data.newCount > 0 ? (
        <p className="platform-muted" role="status">
          {t("platform.inquiries.newCount", { count: data.newCount })}
        </p>
      ) : null}

      <div className="platform-toolbar">
        <Input
          label={t("platform.inquiries.searchLabel")}
          placeholder={t("platform.inquiries.searchPlaceholder")}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          type="search"
        />
        <Select
          label={t("platform.inquiries.statusFilter")}
          options={statusOptions}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption={t("platform.inquiries.caption")}
        columns={columns}
        rows={data?.inquiries ?? []}
        getRowId={(inquiry) => inquiry.id}
        getRowLabel={(inquiry) => inquiry.fullName}
        loading={isPending}
        empty={isError ? t("platform.inquiries.loadError") : t("platform.inquiries.empty")}
      />

      <div className="platform-pagination">
        <span className="platform-muted">
          {t("platform.inquiries.pageSummary", {
            page: formatNumber(page + 1),
            pages: formatNumber(lastPage + 1),
            total: formatNumber(total),
          })}
        </span>
        <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
          {t("platform.common.previous")}
        </Button>
        <Button variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
          {t("platform.common.next")}
        </Button>
      </div>

      {open ? <InquiryModal key={open.id} inquiry={open} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

function InquiryStatusPill({ status }: { status: PlatformInquiryStatus }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-tone={STATUS_TONE[status]}>
      {t(`platform.inquiries.status.${status}`)}
    </span>
  );
}

/** Every detail the prospect gave, plus the team's status and private notes. */
function InquiryModal({ inquiry, onClose }: { inquiry: PlatformInquiry; onClose: () => void }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const update = useUpdateInquiry();
  const notesId = useId();
  const [status, setStatus] = useState<PlatformInquiryStatus>(inquiry.status);
  const [notes, setNotes] = useState(inquiry.internalNotes ?? "");

  const dirty = status !== inquiry.status || notes.trim() !== (inquiry.internalNotes ?? "");
  const save = () =>
    update.mutate(
      { inquiryId: inquiry.id, status, internalNotes: notes.trim() || null },
      { onSuccess: onClose },
    );

  const details: [string, React.ReactNode][] = [
    [
      t("platform.inquiries.detail.email"),
      <a key="email" href={`mailto:${inquiry.email}`}>
        {inquiry.email}
      </a>,
    ],
    [
      t("platform.inquiries.detail.phone"),
      inquiry.phone ? (
        <a key="phone" href={`tel:${inquiry.phone}`}>
          {inquiry.phone}
        </a>
      ) : (
        "—"
      ),
    ],
    [t("platform.inquiries.detail.school"), inquiry.schoolName],
    [t("platform.inquiries.detail.jobTitle"), inquiry.jobTitle ?? "—"],
    [t("platform.inquiries.detail.country"), inquiry.country ?? "—"],
    [
      t("platform.inquiries.detail.students"),
      inquiry.studentCount === null ? "—" : formatNumber(inquiry.studentCount),
    ],
    [t("platform.inquiries.detail.source"), inquiry.sourcePath ?? "—"],
    [
      t("platform.inquiries.detail.received"),
      formatDate(new Date(inquiry.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    ],
    [
      t("platform.inquiries.detail.emailed"),
      inquiry.notifiedAt
        ? formatDate(new Date(inquiry.notifiedAt), { dateStyle: "medium", timeStyle: "short" })
        : t("platform.inquiries.detail.notEmailed"),
    ],
  ];

  return (
    <Modal open onClose={onClose} title={inquiry.fullName} description={inquiry.schoolName}>
      <Modal.Body>
        <dl className="platform-dl">
          {details.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        {inquiry.message ? (
          <>
            <h3>{t("platform.inquiries.detail.message")}</h3>
            <p className="platform-inquiry-message">{inquiry.message}</p>
          </>
        ) : null}

        <Select
          label={t("platform.inquiries.columns.status")}
          options={STATUSES.map((value) => ({
            value,
            label: t(`platform.inquiries.status.${value}`),
          }))}
          value={status}
          onChange={(value) => setStatus(value)}
        />
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={notesId}>
            {t("platform.inquiries.detail.notes")}
          </label>
          <div className="sf-input platform-inquiry-notes">
            <textarea
              id={notesId}
              className="sf-input__control"
              rows={4}
              maxLength={5000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        {update.isError ? <p role="alert">{t("platform.inquiries.saveError")}</p> : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!dirty}
          loading={update.isPending}
          onClick={save}
        >
          {t("platform.common.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
