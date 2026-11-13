import { PERMISSIONS } from "@studafy/constants";
import { Button, Chip, Input, Modal, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { usePortalBack } from "../../layouts/portal/PortalBackLink";
import { api } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { useLocale, useTranslation } from "../../lib/i18n";

import { cellText, columnLabel, listName } from "./cells";
import { errorDetail } from "./CustomListsPage";
import { downloadBlob } from "./download";
import { ListSettingsModal } from "./ListSettingsModal";
import { ManageColumnsModal } from "./ManageColumnsModal";
import {
  LISTS_PATH,
  customListQueryKey,
  customListRowsQueryKey,
  customListsKey,
  fetchCustomList,
  fetchCustomListRows,
  fetchExport,
  revealCell,
} from "./queries";
import { RowModal } from "./RowModal";

import "./custom-lists.css";

import type { CellValue, CustomListColumn, CustomListRow, RowsQuery } from "./queries";

/** How long a revealed sensitive cell stays on screen before it is masked again. */
export const REVEAL_DURATION_MS = 30_000;
const PAGE_SIZE = 25;

/**
 * One custom list (`/portal/lists/:listId`): its rows as a table with search, one column filter,
 * sorting by column and pages, plus add / edit / delete and CSV export for anyone in its audience.
 * Sensitive cells arrive masked; `customList:readSensitive` holders can reveal one at a time, the
 * value living only in this page's state and masked again after {@link REVEAL_DURATION_MS}.
 * Leadership (`customList:manage`) also manages the columns and the list's settings here.
 */
export default function CustomListPage() {
  const { listId = "" } = useParams<{ listId: string }>();
  const { t, i18n } = useTranslation();
  const { locale } = useLocale();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.CUSTOM_LIST_MANAGE);
  const canReveal = permissions.has(PERMISSIONS.CUSTOM_LIST_READ_SENSITIVE);
  usePortalBack(LISTS_PATH);
  const language = i18n.language;
  const words = { yes: t("customLists.common.yes"), no: t("customLists.common.no") };

  const [search, setSearch] = useState("");
  const [filterColumn, setFilterColumn] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [applied, setApplied] = useState<{ column: string; value: string } | null>(null);
  const [sort, setSort] = useState<{ by: string; order: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<CustomListRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<CustomListRow | null>(null);
  const [managing, setManaging] = useState<"columns" | "settings" | null>(null);
  const [revealed, setRevealed] = useState<ReadonlyMap<string, CellValue | null>>(new Map());
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const list = useQuery({
    queryKey: customListQueryKey(listId),
    queryFn: () => fetchCustomList(listId),
    enabled: listId !== "",
  });

  const rowsQuery: RowsQuery = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(sort ? { sort: sort.by, order: sort.order } : {}),
    ...(applied ? { filter_column: applied.column, filter_value: applied.value } : {}),
  };
  const rows = useQuery({
    queryKey: customListRowsQueryKey(listId, rowsQuery),
    queryFn: () => fetchCustomListRows(listId, rowsQuery),
    enabled: listId !== "",
    placeholderData: keepPreviousData,
  });

  const remove = useMutation({
    mutationFn: async (rowId: string) => {
      await api.DELETE("/api/custom-lists/{listId}/rows/{rowId}", {
        params: { path: { listId, rowId } },
      });
    },
    onSuccess: () => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      show({ variant: "success", title: t("customLists.rows.deleted") });
    },
    onError: (caught) =>
      show({ variant: "error", title: errorDetail(caught) ?? t("customLists.rows.deleteError") }),
  });

  if (list.isPending) return <p role="status">{t("customLists.common.loading")}</p>;
  if (list.isError) return <p role="alert">{t("customLists.list.loadError")}</p>;

  const detail = list.data;
  const columns = detail.columns.filter((column) => !column.archived);
  const filterable = columns.filter((column) => column.sensitivity !== "sensitive");
  const hasLinks = Object.values(detail.links).some(Boolean);

  async function reveal(row: CustomListRow, column: CustomListColumn) {
    const key = `${row.id}:${column.id}`;
    try {
      const value = await revealCell(listId, row.id, column.id);
      setRevealed((current) => new Map(current).set(key, value));
      timers.current.push(
        window.setTimeout(() => {
          setRevealed((current) => {
            const next = new Map(current);
            next.delete(key);
            return next;
          });
        }, REVEAL_DURATION_MS),
      );
    } catch (caught) {
      show({ variant: "error", title: errorDetail(caught) ?? t("customLists.rows.revealError") });
    }
  }

  async function exportCsv() {
    try {
      const lang = language.startsWith("ar") ? "ar" : "en";
      downloadBlob(`${detail.name_en || "custom-list"}.csv`, await fetchExport(listId, lang));
    } catch (caught) {
      show({ variant: "error", title: errorDetail(caught) ?? t("customLists.list.exportError") });
    }
  }

  function toggleSort(columnId: string) {
    setPage(0);
    setSort((current) =>
      current?.by === columnId
        ? { by: columnId, order: current.order === "asc" ? "desc" : "asc" }
        : { by: columnId, order: "asc" },
    );
  }

  const ariaSort = (columnId: string) =>
    sort?.by === columnId ? (sort.order === "asc" ? "ascending" : "descending") : undefined;

  const sortHeader = (columnId: string, label: string) => (
    <th key={columnId} scope="col" aria-sort={ariaSort(columnId)}>
      <button type="button" className="custom-lists__sort" onClick={() => toggleSort(columnId)}>
        {label}
        <span aria-hidden="true">
          {sort?.by === columnId ? (sort.order === "asc" ? " ▲" : " ▼") : ""}
        </span>
      </button>
    </th>
  );

  const cell = (row: CustomListRow, column: CustomListColumn) => {
    const stored = row.cells.find((candidate) => candidate.column_id === column.id);
    if (!stored) return "";
    if (stored.masked) {
      const key = `${row.id}:${column.id}`;
      if (revealed.has(key)) return cellText(column, revealed.get(key), language, words);
      return (
        <span className="custom-lists__masked">
          <span>{stored.mask}</span>
          {canReveal ? (
            <Button
              type="button"
              variant="tertiary"
              onClick={() => void reveal(row, column)}
              aria-label={t("customLists.rows.revealLabel", {
                column: columnLabel(column, language),
              })}
            >
              {t("customLists.rows.reveal")}
            </Button>
          ) : null}
        </span>
      );
    }
    return cellText(column, stored.value, language, words);
  };

  const total = rows.data?.total ?? 0;
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <>
      <div className="custom-lists__header">
        <div>
          <h1>
            {listName(detail, language)}{" "}
            {detail.archived ? <Chip>{t("customLists.common.archived")}</Chip> : null}
          </h1>
          {detail.description ? <p>{detail.description}</p> : null}
          <p className="custom-lists__muted">
            {t("customLists.list.audienceLine", {
              audience: t(`customLists.audience.${detail.audience}`),
            })}
          </p>
        </div>
        <div className="custom-lists__actions">
          <Button variant="secondary" onClick={() => void exportCsv()}>
            {t("customLists.list.export")}
          </Button>
          {canManage ? (
            <>
              <Button variant="secondary" onClick={() => setManaging("columns")}>
                {t("customLists.list.manageColumns")}
              </Button>
              <Button variant="secondary" onClick={() => setManaging("settings")}>
                {t("customLists.list.settings")}
              </Button>
            </>
          ) : null}
          {!detail.archived ? (
            <Button onClick={() => setEditing("new")} disabled={columns.length === 0}>
              {t("customLists.rows.add")}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="custom-lists__muted">{t("customLists.list.exportNote")}</p>

      <div className="custom-lists__toolbar">
        <Input
          label={t("customLists.list.search")}
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
        <form
          className="custom-lists__filter"
          aria-label={t("customLists.list.filter")}
          onSubmit={(event) => {
            event.preventDefault();
            setPage(0);
            setApplied(
              filterColumn && filterValue.trim()
                ? { column: filterColumn, value: filterValue.trim() }
                : null,
            );
          }}
        >
          <Select
            label={t("customLists.list.filterColumn")}
            options={[
              { value: "", label: t("customLists.list.noFilter") },
              ...filterable.map((column) => ({
                value: column.id,
                label: columnLabel(column, language),
              })),
            ]}
            value={filterColumn}
            onChange={setFilterColumn}
          />
          <Input
            label={t("customLists.list.filterValue")}
            value={filterValue}
            onChange={(event) => setFilterValue(event.target.value)}
          />
          <Button type="submit" variant="secondary">
            {t("customLists.list.applyFilter")}
          </Button>
          {applied ? (
            <Button
              type="button"
              variant="tertiary"
              onClick={() => {
                setApplied(null);
                setFilterValue("");
                setPage(0);
              }}
            >
              {t("customLists.list.clearFilter")}
            </Button>
          ) : null}
        </form>
      </div>

      {columns.length === 0 ? (
        <p>{t(canManage ? "customLists.list.noColumnsManager" : "customLists.list.noColumns")}</p>
      ) : rows.isError ? (
        <p role="alert">{errorDetail(rows.error) ?? t("customLists.rows.loadError")}</p>
      ) : (
        <>
          <div className="custom-lists__scroll">
            <table className="custom-lists__table">
              <caption className="custom-lists__visually-hidden">
                {listName(detail, language)}
              </caption>
              <thead>
                <tr>
                  {hasLinks ? sortHeader("link", t("customLists.rows.linkedTo")) : null}
                  {columns.map((column) =>
                    column.sensitivity === "sensitive" ? (
                      <th key={column.id} scope="col">
                        {columnLabel(column, language)}
                      </th>
                    ) : (
                      sortHeader(column.id, columnLabel(column, language))
                    ),
                  )}
                  <th scope="col">
                    <span className="custom-lists__visually-hidden">
                      {t("customLists.rows.actions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(rows.data?.rows ?? []).map((row) => (
                  <tr key={row.id}>
                    {hasLinks ? (
                      <td>
                        {row.link
                          ? (row.link.name ?? t("customLists.rows.notVisible"))
                          : t("customLists.rows.noLink")}
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td key={column.id}>{cell(row, column)}</td>
                    ))}
                    <td className="custom-lists__row-actions">
                      <Button type="button" variant="tertiary" onClick={() => setEditing(row)}>
                        {t("customLists.rows.edit")}
                      </Button>
                      <Button type="button" variant="tertiary" onClick={() => setDeleting(row)}>
                        {t("customLists.rows.delete")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.isPending ? (
            <p role="status">{t("customLists.common.loading")}</p>
          ) : total === 0 ? (
            <p>{t("customLists.rows.empty")}</p>
          ) : (
            <div className="custom-lists__pager">
              <p role="status">{t("customLists.rows.range", { first, last, total })}</p>
              <Button
                type="button"
                variant="tertiary"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                {t("customLists.rows.previous")}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                disabled={last >= total}
                onClick={() => setPage(page + 1)}
              >
                {t("customLists.rows.next")}
              </Button>
            </div>
          )}
        </>
      )}

      {editing ? (
        <RowModal
          list={detail}
          columns={columns}
          row={editing === "new" ? null : editing}
          locale={locale}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t("customLists.rows.deleteTitle")}
        description={t("customLists.rows.deleteBody")}
      >
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setDeleting(null)}>
            {t("customLists.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting.id)}
          >
            {t("customLists.rows.deleteConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>

      {canManage ? (
        <>
          <ManageColumnsModal
            list={detail}
            open={managing === "columns"}
            onClose={() => setManaging(null)}
          />
          <ListSettingsModal
            list={detail}
            open={managing === "settings"}
            onClose={() => setManaging(null)}
          />
        </>
      ) : null}
    </>
  );
}
