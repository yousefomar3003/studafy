import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Input } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import { LinkChildrenModal } from "./LinkChildrenModal";
import {
  fetchUnlinkedParents,
  fetchUnlinkedStudents,
  UNLINKED_KEY,
  UNLINKED_PAGE_SIZE,
} from "./queries";

import "../families/families.css";

import type { UnlinkedParent, UnlinkedStudent } from "./queries";
import type { DataGridColumn } from "@studafy/ui";
import type { ReactNode } from "react";

/**
 * Unlinked (`/portal/finance/unlinked`), gated by `billing:read` like the families list whose gap
 * it shows: enrolled students no guardian is linked to, and parent accounts linked to no child.
 * Neither is part of a family, so finance cannot reach them through one (no sibling discount, no
 * family statement or reminder, no parent who can see or pay the invoice).
 *
 * Fixing a row is linking it, which is the school admin's job (`student:update`), not finance's:
 * a student row opens the student's Guardians tab, a parent row opens a picker for their children.
 * Without that permission the rows are listed with a note to ask an admin. Staff always pick who to
 * link; nothing is matched for them.
 */
export default function UnlinkedPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  // The student profile route is behind organization:manageSettings; the link call needs
  // student:update, and the children picker reads /api/students (student:read).
  const canFix =
    permissions.has(PERMISSIONS.STUDENT_UPDATE) &&
    permissions.has(PERMISSIONS.STUDENT_READ) &&
    permissions.has(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS);
  const [linkingParent, setLinkingParent] = useState<UnlinkedParent | null>(null);

  const studentColumns: DataGridColumn<UnlinkedStudent>[] = [
    {
      id: "student",
      header: t("finance.common.student"),
      renderCell: (row) => row.name,
    },
    {
      id: "admission",
      header: t("finance.common.admissionNumber"),
      renderCell: (row) => row.admission_number,
    },
    {
      id: "fix",
      header: t("finance.unlinked.columns.fix"),
      renderCell: (row) =>
        canFix ? (
          <Link to={`/portal/admin/students/${row.id}?tab=guardians`}>
            {t("finance.unlinked.students.addGuardian")}
          </Link>
        ) : (
          <span className="families-cell__muted">{t("finance.unlinked.askAdmin")}</span>
        ),
    },
  ];

  const parentColumns: DataGridColumn<UnlinkedParent>[] = [
    {
      id: "parent",
      header: t("finance.unlinked.columns.parent"),
      renderCell: (row) => (
        <div className="families-cell">
          <span>{row.name}</span>
          {row.email ? <span className="families-cell__muted">{row.email}</span> : null}
        </div>
      ),
    },
    {
      id: "fix",
      header: t("finance.unlinked.columns.fix"),
      renderCell: (row) =>
        canFix ? (
          <Button variant="secondary" onClick={() => setLinkingParent(row)}>
            {t("finance.unlinked.parents.linkChildren", { name: row.name })}
          </Button>
        ) : (
          <span className="families-cell__muted">{t("finance.unlinked.askAdmin")}</span>
        ),
    },
  ];

  return (
    <>
      <div className="families-header">
        <div>
          <h1>{t("finance.unlinked.title")}</h1>
          <p>{t("finance.unlinked.intro")}</p>
        </div>
        <Link to="/portal/finance/families">{t("finance.unlinked.backToFamilies")}</Link>
      </div>

      <UnlinkedSection<UnlinkedStudent>
        kind="students"
        title={t("finance.unlinked.students.title")}
        intro={t("finance.unlinked.students.intro")}
        searchLabel={t("finance.unlinked.students.search")}
        caption={t("finance.unlinked.students.caption")}
        empty={t("finance.unlinked.students.empty")}
        fetchPage={fetchUnlinkedStudents}
        columns={studentColumns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
      />

      <UnlinkedSection<UnlinkedParent>
        kind="parents"
        title={t("finance.unlinked.parents.title")}
        intro={t("finance.unlinked.parents.intro")}
        searchLabel={t("finance.unlinked.parents.search")}
        caption={t("finance.unlinked.parents.caption")}
        empty={t("finance.unlinked.parents.empty")}
        fetchPage={fetchUnlinkedParents}
        columns={parentColumns}
        getRowId={(row) => row.user_id}
        getRowLabel={(row) => row.name}
      />

      {canFix ? (
        <LinkChildrenModal parent={linkingParent} onClose={() => setLinkingParent(null)} />
      ) : null}
    </>
  );
}

interface UnlinkedSectionProps<T> {
  kind: "students" | "parents";
  title: string;
  intro: ReactNode;
  searchLabel: string;
  caption: string;
  empty: string;
  fetchPage: (search: string, offset: number) => Promise<{ items: T[]; total: number }>;
  columns: DataGridColumn<T>[];
  getRowId: (row: T) => string;
  getRowLabel: (row: T) => string;
}

function UnlinkedSection<T>({
  kind,
  title,
  intro,
  searchLabel,
  caption,
  empty,
  fetchPage,
  columns,
  getRowId,
  getRowLabel,
}: UnlinkedSectionProps<T>) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: [...UNLINKED_KEY, kind, search, offset],
    queryFn: () => fetchPage(search, offset),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  function applySearch() {
    setSearch(searchInput);
    setOffset(0);
  }

  return (
    <section aria-labelledby={`unlinked-${kind}`} className="unlinked-section">
      <h2 id={`unlinked-${kind}`}>
        {title}{" "}
        {query.data ? (
          <span className="families-badge" data-tone={total > 0 ? "warning" : "success"}>
            {formatNumber(total)}
          </span>
        ) : null}
      </h2>
      <p>{intro}</p>

      <form
        className="families-toolbar"
        role="search"
        aria-label={searchLabel}
        onSubmit={(event) => {
          event.preventDefault();
          applySearch();
        }}
      >
        <Input
          label={searchLabel}
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onBlur={applySearch}
        />
      </form>

      <DataGrid
        caption={caption}
        columns={columns}
        rows={items}
        getRowId={getRowId}
        getRowLabel={getRowLabel}
        loading={query.isPending}
        empty={query.isError ? t("finance.unlinked.loadError") : empty}
      />

      <div className="families-pagination">
        <Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - UNLINKED_PAGE_SIZE))}
        >
          {t("finance.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={offset + items.length >= total}
          onClick={() => setOffset(offset + UNLINKED_PAGE_SIZE)}
        >
          {t("finance.common.next")}
        </Button>
      </div>
    </section>
  );
}
