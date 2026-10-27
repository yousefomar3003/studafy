import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, DataGrid, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { SummaryStrip } from "../../../components/home/SummaryStrip";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PAYMENT_MODE_LABEL_KEYS, PAYMENT_STATUS_LABEL_KEYS, paymentStatusTone } from "../labels";
import { ReceiptButton } from "../ReceiptButton";

import { childPositionLabel, moneyText } from "./family-format";
import {
  FAMILIES_KEY,
  fetchFamilyProfile,
  fetchHousehold,
  useSendReminder,
  useSendStatement,
} from "./queries";

import "./families.css";

import type {
  FamilyChild,
  FamilySendResult,
  FinanceCommunication,
  HouseholdInvoice,
  HouseholdPayment,
  HouseholdStudent,
} from "./queries";
import type { SummaryItem } from "../../../components/home/SummaryStrip";
import type { DataGridColumn } from "@studafy/ui";
import type { TFunction } from "i18next";

/** The outcome of a reminder or statement, as a toast. */
function sendToast(t: TFunction, kind: "reminder" | "statement", result: FamilySendResult) {
  if (result.status === "sent") {
    return {
      variant: "success" as const,
      title: t(`finance.families.detail.${kind}Sent`, { count: result.delivered }),
      description:
        result.suppressed > 0
          ? t("finance.families.detail.suppressed", { count: result.suppressed })
          : undefined,
    };
  }
  return {
    variant: "warning" as const,
    title: t(`finance.families.detail.notSent.${result.status}`),
  };
}

/**
 * One family (`/portal/finance/families/:familyId`), gated by `billing:read`: guardians and how to
 * reach them, the family's balance, each child's invoices and payments (receipts open from here),
 * and every fee message sent to the guardians. Finance (`billing:update`) records one payment across
 * the children's invoices, reminds the family of what is overdue, or sends its statement.
 *
 * Two reads: the family's finance profile (names, sibling ranking, totals, messages) and the
 * household view the parent app uses (the invoices, installments and payments themselves).
 */
export default function FamilyDetailPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.BILLING_UPDATE);
  const { familyId = "" } = useParams<{ familyId: string }>();
  const reminder = useSendReminder();
  const statement = useSendStatement();

  const profile = useQuery({
    queryKey: [...FAMILIES_KEY, familyId, "profile"],
    queryFn: () => fetchFamilyProfile(familyId),
    enabled: Boolean(familyId),
  });
  const household = useQuery({
    queryKey: [...FAMILIES_KEY, familyId, "household"],
    queryFn: () => fetchHousehold(familyId),
    enabled: Boolean(familyId),
  });

  if (profile.isPending) return <p role="status">{t("finance.common.loading")}</p>;
  if (profile.isError) return <p role="alert">{t("finance.families.detail.loadError")}</p>;

  const family = profile.data;
  const owes = family.balances.some((balance) => balance.outstanding_minor > 0);
  const byStudent = new Map<string, HouseholdStudent>(
    (household.data ?? []).map((section) => [section.student_id, section]),
  );

  const summary: SummaryItem[] = [
    {
      key: "outstanding",
      label: t("finance.families.columns.outstanding"),
      value: moneyText(family.balances, "outstanding"),
      hint: t("finance.families.detail.acrossChildren", { count: family.children.length }),
      status: "ready",
    },
    {
      key: "overdue",
      label: t("finance.families.columns.overdue"),
      value: moneyText(family.balances, "overdue"),
      hint: t("finance.families.detail.overdueInvoices", { count: family.overdue_invoice_count }),
      attention: family.overdue_invoice_count > 0,
      status: "ready",
    },
    {
      key: "billed",
      label: t("finance.families.detail.billed"),
      value: moneyText(family.balances, "billed"),
      hint: family.last_payment_date
        ? t("finance.families.detail.lastPaid", { date: family.last_payment_date })
        : t("finance.families.detail.noPayments"),
      status: "ready",
    },
  ];

  return (
    <div className="families-detail">
      <div className="families-header">
        <div>
          <h1>{family.display_name}</h1>
          <ul className="families-guardians">
            {family.guardians.map((guardian) => (
              <li key={guardian.user_id}>
                <span>{guardian.name}</span>
                {guardian.is_primary ? (
                  <span className="families-badge">{t("finance.families.detail.primary")}</span>
                ) : null}
                <a href={`mailto:${guardian.email}`}>{guardian.email}</a>
              </li>
            ))}
          </ul>
        </div>
        {canManage ? (
          <div className="families-actions">
            {owes ? (
              <Link to={`/portal/finance/families/${family.id}/payments/new`}>
                <Button type="button">{t("finance.families.detail.recordPayment")}</Button>
              </Link>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              loading={reminder.isPending}
              disabled={family.overdue_invoice_count === 0}
              onClick={() =>
                reminder.mutate(family.id, {
                  onSuccess: (result) => show(sendToast(t, "reminder", result)),
                  onError: () => show({ variant: "error", title: t("finance.families.sendError") }),
                })
              }
            >
              {t("finance.families.detail.sendReminder")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              loading={statement.isPending}
              onClick={() =>
                statement.mutate(family.id, {
                  onSuccess: (result) => show(sendToast(t, "statement", result)),
                  onError: () => show({ variant: "error", title: t("finance.families.sendError") }),
                })
              }
            >
              {t("finance.families.detail.sendStatement")}
            </Button>
          </div>
        ) : null}
      </div>

      {family.last_reminder_at ? (
        <p className="families-cell__muted">
          {t("finance.families.detail.lastReminded", {
            date: formatDate(new Date(family.last_reminder_at)),
          })}
        </p>
      ) : null}

      <SummaryStrip items={summary} />

      <h2>{t("finance.families.detail.childrenHeading")}</h2>
      {household.isError ? <p role="alert">{t("finance.families.detail.householdError")}</p> : null}
      {family.children.map((child) => (
        <ChildSection
          key={child.student_id}
          child={child}
          section={byStudent.get(child.student_id)}
          loading={household.isPending}
        />
      ))}

      <h2>{t("finance.families.detail.messagesHeading")}</h2>
      <CommunicationsTable rows={family.communications} />
    </div>
  );
}

function ChildSection({
  child,
  section,
  loading,
}: {
  child: FamilyChild;
  section: HouseholdStudent | undefined;
  loading: boolean;
}) {
  const { t } = useTranslation();

  const invoiceColumns: DataGridColumn<HouseholdInvoice>[] = [
    {
      id: "number",
      header: t("finance.common.invoice"),
      renderCell: (row) => (
        <Link to={`/portal/finance/invoices/${row.id}`}>{row.erpnext_docname}</Link>
      ),
    },
    { id: "issued", header: t("finance.common.issued"), renderCell: (row) => row.issued_date },
    {
      id: "due",
      header: t("finance.common.due"),
      renderCell: (row) => {
        const overdue =
          row.outstanding_amount_minor > 0 &&
          row.due_date !== null &&
          row.due_date < new Date().toISOString().slice(0, 10);
        return (
          <span className={overdue ? "families-overdue" : undefined}>
            {row.due_date ?? "—"}
            {overdue ? ` · ${t("finance.families.detail.overdueTag")}` : ""}
          </span>
        );
      },
    },
    {
      id: "total",
      header: t("finance.common.total"),
      align: "end",
      renderCell: (row) => `${row.total_amount} ${row.currency}`,
    },
    {
      id: "outstanding",
      header: t("finance.common.outstanding"),
      align: "end",
      renderCell: (row) =>
        row.outstanding_amount_minor > 0 ? `${row.outstanding_amount} ${row.currency}` : "—",
    },
  ];

  const paymentColumns: DataGridColumn<HouseholdPayment>[] = [
    { id: "date", header: t("finance.common.date"), renderCell: (row) => row.payment_date },
    {
      id: "invoice",
      header: t("finance.common.invoice"),
      renderCell: (row) => row.erpnext_invoice_id ?? "—",
    },
    {
      id: "amount",
      header: t("finance.common.amount"),
      align: "end",
      renderCell: (row) => `${row.amount} ${row.currency}`,
    },
    {
      id: "method",
      header: t("finance.common.method"),
      renderCell: (row) => (row.payment_mode ? t(PAYMENT_MODE_LABEL_KEYS[row.payment_mode]) : "—"),
    },
    {
      id: "status",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="families-badge" data-tone={paymentStatusTone(row.status)}>
          {t(PAYMENT_STATUS_LABEL_KEYS[row.status])}
        </span>
      ),
    },
    {
      id: "receipt",
      header: t("finance.payments.list.receipt"),
      renderCell: (row) => (row.receipt_url ? <ReceiptButton paymentId={row.id} /> : "—"),
    },
  ];

  return (
    <div className="families-child">
      <Card as="section" aria-label={child.name}>
        <Card.Header>
          <div className="families-child__title">
            <h3>{child.name}</h3>
            <span className="families-cell__muted">
              {child.admission_number} · {childPositionLabel(t, child.child_position)}
            </span>
            {child.sibling_discount_percentage !== null ? (
              <span className="families-badge" data-tone="success">
                {t("finance.families.detail.siblingDiscount", {
                  percentage: child.sibling_discount_percentage,
                })}
              </span>
            ) : null}
          </div>
        </Card.Header>
        <Card.Body>
          <DataGrid
            caption={t("finance.families.detail.invoicesCaption", { name: child.name })}
            columns={invoiceColumns}
            rows={section?.invoices ?? []}
            getRowId={(row) => row.erpnext_docname}
            getRowLabel={(row) => row.erpnext_docname}
            loading={loading}
            empty={t("finance.families.detail.noInvoices")}
          />
          <DataGrid
            caption={t("finance.families.detail.paymentsCaption", { name: child.name })}
            columns={paymentColumns}
            rows={section?.payments ?? []}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.erpnext_payment_entry_id ?? row.id}
            loading={loading}
            empty={t("finance.families.detail.noPayments")}
          />
        </Card.Body>
      </Card>
    </div>
  );
}

function CommunicationsTable({ rows }: { rows: FinanceCommunication[] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const columns: DataGridColumn<FinanceCommunication>[] = [
    {
      id: "date",
      header: t("finance.common.date"),
      renderCell: (row) => formatDate(new Date(row.created_at)),
    },
    {
      id: "kind",
      header: t("finance.families.messages.kind"),
      renderCell: (row) =>
        `${t(`finance.families.messages.kinds.${row.kind}`)}${row.reference ? ` · ${row.reference}` : ""}`,
    },
    {
      id: "recipient",
      header: t("finance.families.messages.recipient"),
      renderCell: (row) => row.recipient_name,
    },
    {
      id: "delivery",
      header: t("finance.common.status"),
      renderCell: (row) => (
        <span className="families-badge" data-tone={row.delivered ? "success" : "warning"}>
          {t(
            row.delivered
              ? "finance.families.messages.delivered"
              : "finance.families.messages.turnedOff",
          )}
        </span>
      ),
    },
    {
      id: "sentBy",
      header: t("finance.families.messages.sentBy"),
      renderCell: (row) => row.sent_by_name ?? t("finance.families.messages.automatic"),
    },
  ];
  return (
    <DataGrid
      caption={t("finance.families.messages.caption")}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      getRowLabel={(row) => `${row.kind} ${row.created_at}`}
      empty={t("finance.families.messages.empty")}
    />
  );
}
