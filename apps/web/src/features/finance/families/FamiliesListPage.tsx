import { PERMISSIONS } from "@studafy/constants";
import { Button, Checkbox, DataGrid, Input, Modal, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { fetchUnlinkedSummary, UNLINKED_KEY } from "../unlinked/queries";

import { childPositionLabel, MoneyLines } from "./family-format";
import {
  FAMILIES_KEY,
  FAMILIES_PAGE_SIZE,
  fetchFamiliesPage,
  useSendBulkReminders,
} from "./queries";

import "./families.css";

import type { FamilyFilters, FinanceFamily } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const INITIAL_FILTERS: FamilyFilters = {
  search: "",
  siblingsOnly: false,
  balance: "",
  sort: "name",
};

/**
 * Families (`/portal/finance/families`), gated by `billing:read`: every household with its
 * guardians, its children (eldest first, with the sibling discount each one's next invoice gets)
 * and what it owes across all of them. Finance (`billing:update`) can remind every family with an
 * overdue balance from here; a family's own page records one payment across its children's
 * invoices and sends reminders and statements to that family. Above the list, a count of the
 * students and parents no family reaches links to the unlinked page.
 */
export default function FamiliesListPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.BILLING_UPDATE);
  const bulkReminders = useSendBulkReminders();

  const [filters, setFilters] = useState<FamilyFilters>(INITIAL_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [confirmBulk, setConfirmBulk] = useState(false);

  const query = useQuery({
    queryKey: [...FAMILIES_KEY, "list", filters, offset],
    queryFn: () => fetchFamiliesPage(filters, offset),
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  // People no family reaches: shown here so the school notices them, fixed from the unlinked page.
  const unlinked = useQuery({
    queryKey: [...UNLINKED_KEY, "summary"],
    queryFn: fetchUnlinkedSummary,
  });
  const unlinkedTotal = (unlinked.data?.students ?? 0) + (unlinked.data?.parents ?? 0);

  function update(next: Partial<FamilyFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setOffset(0);
  }

  function sendBulk() {
    bulkReminders.mutate(undefined, {
      onSuccess: (result) => {
        setConfirmBulk(false);
        show({
          variant: "success",
          title: t("finance.families.bulk.sentTitle", { count: result.sent }),
          description: t("finance.families.bulk.sentDetail", {
            guardians: result.delivered,
            skipped: result.recently_reminded,
          }),
        });
      },
      onError: () => show({ variant: "error", title: t("finance.families.bulk.error") }),
    });
  }

  const balanceOptions: SelectOption<FamilyFilters["balance"]>[] = [
    { value: "", label: t("finance.families.filters.allBalances") },
    { value: "outstanding", label: t("finance.families.filters.outstanding") },
    { value: "overdue", label: t("finance.families.filters.overdue") },
  ];
  const sortOptions: SelectOption<FamilyFilters["sort"]>[] = [
    { value: "name", label: t("finance.families.filters.sortName") },
    { value: "outstanding", label: t("finance.families.filters.sortOutstanding") },
  ];

  const columns: DataGridColumn<FinanceFamily>[] = [
    {
      id: "family",
      header: t("finance.families.columns.family"),
      renderCell: (row) => {
        const primary = row.guardians.find((guardian) => guardian.is_primary) ?? row.guardians[0];
        return (
          <div className="families-cell">
            <Link to={`/portal/finance/families/${row.id}`}>{row.display_name}</Link>
            {primary ? (
              <span className="families-cell__muted">
                {primary.name} · <a href={`mailto:${primary.email}`}>{primary.email}</a>
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "children",
      header: t("finance.families.columns.children"),
      renderCell: (row) => (
        <ul className="families-children">
          {row.children.map((child) => (
            <li key={child.student_id}>
              <span>{child.name}</span>
              {child.sibling_discount_percentage !== null ? (
                <span className="families-badge" data-tone="success">
                  {t("finance.families.siblingDiscountBadge", {
                    percentage: child.sibling_discount_percentage,
                    position: childPositionLabel(t, child.child_position),
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "outstanding",
      header: t("finance.families.columns.outstanding"),
      align: "end",
      renderCell: (row) => <MoneyLines balances={row.balances} field="outstanding" />,
    },
    {
      id: "overdue",
      header: t("finance.families.columns.overdue"),
      align: "end",
      renderCell: (row) =>
        row.overdue_invoice_count > 0 ? (
          <span className="families-overdue">
            <MoneyLines balances={row.balances} field="overdue" />
          </span>
        ) : (
          "—"
        ),
    },
    {
      id: "lastPayment",
      header: t("finance.families.columns.lastPayment"),
      renderCell: (row) => row.last_payment_date ?? "—",
    },
    {
      id: "lastReminder",
      header: t("finance.families.columns.lastReminder"),
      renderCell: (row) =>
        row.last_reminder_at ? formatDate(new Date(row.last_reminder_at)) : "—",
    },
  ];

  return (
    <>
      <div className="families-header">
        <div>
          <h1>{t("finance.families.list.title")}</h1>
          <p>{t("finance.families.list.intro")}</p>
        </div>
        {canManage ? (
          <Button variant="secondary" onClick={() => setConfirmBulk(true)}>
            {t("finance.families.bulk.button")}
          </Button>
        ) : null}
      </div>

      {unlinked.data && unlinkedTotal > 0 ? (
        <div className="families-unlinked" role="status">
          <p>
            {t("finance.families.unlinked.summary", {
              students: unlinked.data.students,
              parents: unlinked.data.parents,
            })}
          </p>
          <Link to="/portal/finance/unlinked">{t("finance.families.unlinked.review")}</Link>
        </div>
      ) : null}

      <form
        className="families-toolbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          update({ search: searchInput });
        }}
      >
        <Input
          label={t("finance.families.filters.search")}
          type="search"
          value={searchInput}
          placeholder={t("finance.families.filters.searchPlaceholder")}
          onChange={(event) => setSearchInput(event.target.value)}
          onBlur={() => update({ search: searchInput })}
        />
        <Select
          label={t("finance.families.filters.balance")}
          options={balanceOptions}
          value={filters.balance}
          onChange={(balance) => update({ balance })}
        />
        <Select
          label={t("finance.families.filters.sort")}
          options={sortOptions}
          value={filters.sort}
          onChange={(sort) => update({ sort })}
        />
        <Checkbox
          label={t("finance.families.filters.siblingsOnly")}
          checked={filters.siblingsOnly}
          onChange={(event) => update({ siblingsOnly: event.target.checked })}
        />
      </form>

      <DataGrid
        caption={t("finance.families.list.caption")}
        columns={columns}
        rows={items}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.display_name}
        loading={query.isPending}
        empty={
          query.isError ? t("finance.families.list.loadError") : t("finance.families.list.empty")
        }
      />

      <div className="families-pagination">
        <Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - FAMILIES_PAGE_SIZE))}
        >
          {t("finance.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={offset + items.length >= total}
          onClick={() => setOffset(offset + FAMILIES_PAGE_SIZE)}
        >
          {t("finance.common.next")}
        </Button>
      </div>

      <Modal
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={t("finance.families.bulk.confirmTitle")}
        description={t("finance.families.bulk.confirmBody")}
      >
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setConfirmBulk(false)}>
            {t("finance.common.cancel")}
          </Button>
          <Button type="button" loading={bulkReminders.isPending} onClick={sendBulk}>
            {t("finance.families.bulk.confirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
