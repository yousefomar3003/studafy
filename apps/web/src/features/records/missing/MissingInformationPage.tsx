import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, Input, Select, Tabs } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import {
  fetchMissingClasses,
  fetchMissingParents,
  fetchMissingStaff,
  fetchMissingStudents,
  MISSING_KEY,
  MISSING_PAGE_SIZE,
} from "./queries";

import "../../finance/families/families.css";
import "./missing.css";

import type {
  MissingPage,
  RecordMissingField,
  RecordMissingIssue,
  RecordMissingClass,
  RecordMissingParent,
  RecordMissingStaff,
  RecordMissingStudent,
} from "./queries";
import type { DataGridColumn } from "@studafy/ui";

export interface MissingInformationPageProps {
  /** Which portal mounted the page: decides where a row's Records link goes. */
  portal?: "admin" | "principal";
}

const ISSUES: readonly RecordMissingIssue[] = ["missing", "expired", "expiring"];

/** Where each portal shows one person's (or class's) Records. */
export function recordsLinkFor(
  portal: "admin" | "principal",
  subject: { kind: "student" | "parent" | "staff" | "class"; id: string },
): string {
  if (subject.kind === "staff") return `/portal/${portal}/staff/${subject.id}/records`;
  if (subject.kind === "class") return `/portal/${portal}/classes/${subject.id}/records`;
  if (portal === "admin") {
    return subject.kind === "student"
      ? `/portal/admin/students/${subject.id}?tab=records`
      : `/portal/admin/parents/${subject.id}/records`;
  }
  return subject.kind === "student"
    ? `/portal/principal/students/${subject.id}`
    : `/portal/principal/parents/${subject.id}`;
}

/**
 * Missing information (`/portal/admin/records/missing`, `/portal/principal/records/missing`), gated
 * on `studentRecord:read`: current students and parents -- and, for whoever holds
 * `staffRecord:read` / `classRecord:read`, staff and classes -- whose required fields or documents
 * are missing, and documents that have expired or expire within 30 days. Field labels only, never a
 * value, and only the fields the caller may read (the API narrows by visibility and sensitivity).
 * Each row opens that Records page, where staff fix it. Laid out like Finance > Unlinked.
 */
export default function MissingInformationPage({ portal = "admin" }: MissingInformationPageProps) {
  const { t, i18n } = useTranslation();
  const { formatDate } = useFormatters();
  const permissions = usePermissions();
  const showStaff = permissions.has(PERMISSIONS.STAFF_RECORD_READ);
  const showClasses = permissions.has(PERMISSIONS.CLASS_RECORD_READ);
  const [issue, setIssue] = useState<RecordMissingIssue | null>(null);

  const labelOf = (field: RecordMissingField) =>
    i18n.language === "ar" ? field.label_ar : field.label_en;

  function renderIssues(row: {
    missing: RecordMissingField[];
    expired: RecordMissingField[];
    expiring: RecordMissingField[];
  }) {
    const groups: { key: RecordMissingIssue; fields: RecordMissingField[] }[] = [
      { key: "missing", fields: row.missing },
      { key: "expired", fields: row.expired },
      { key: "expiring", fields: row.expiring },
    ];
    return (
      <ul className="records-missing__issues">
        {groups
          .filter((group) => group.fields.length > 0)
          .map((group) => (
            <li key={group.key}>
              <span
                className="families-badge"
                data-tone={group.key === "expiring" ? "warning" : "danger"}
              >
                {t(`recordTemplates.missing.issues.${group.key}`)}
              </span>{" "}
              {group.fields
                .map((field) =>
                  field.expires_on
                    ? t("recordTemplates.missing.withDate", {
                        label: labelOf(field),
                        date: formatDate(new Date(`${field.expires_on}T00:00:00`), {
                          dateStyle: "medium",
                        }),
                      })
                    : labelOf(field),
                )
                .join(t("recordTemplates.missing.separator"))}
            </li>
          ))}
      </ul>
    );
  }

  const studentColumns: DataGridColumn<RecordMissingStudent>[] = [
    {
      id: "student",
      header: t("recordTemplates.missing.columns.student"),
      renderCell: (row) => (
        <div className="families-cell">
          <span>{row.name}</span>
          <span className="families-cell__muted">{row.admission_number}</span>
        </div>
      ),
    },
    {
      id: "issues",
      header: t("recordTemplates.missing.columns.issues"),
      renderCell: renderIssues,
    },
    {
      id: "open",
      header: t("recordTemplates.missing.columns.open"),
      renderCell: (row) => (
        <Link to={recordsLinkFor(portal, { kind: "student", id: row.student_id })}>
          {t("recordTemplates.missing.openRecord", { name: row.name })}
        </Link>
      ),
    },
  ];

  const parentColumns: DataGridColumn<RecordMissingParent>[] = [
    {
      id: "parent",
      header: t("recordTemplates.missing.columns.parent"),
      renderCell: (row) => (
        <div className="families-cell">
          <span>{row.name}</span>
          {row.email ? <span className="families-cell__muted">{row.email}</span> : null}
        </div>
      ),
    },
    {
      id: "issues",
      header: t("recordTemplates.missing.columns.issues"),
      renderCell: renderIssues,
    },
    {
      id: "open",
      header: t("recordTemplates.missing.columns.open"),
      renderCell: (row) => (
        <Link to={recordsLinkFor(portal, { kind: "parent", id: row.user_id })}>
          {t("recordTemplates.missing.openRecord", { name: row.name })}
        </Link>
      ),
    },
  ];

  const staffColumns: DataGridColumn<RecordMissingStaff>[] = [
    {
      id: "staff",
      header: t("recordTemplates.missing.columns.staff"),
      renderCell: (row) => (
        <div className="families-cell">
          <span>{row.name}</span>
          {row.email ? <span className="families-cell__muted">{row.email}</span> : null}
        </div>
      ),
    },
    {
      id: "issues",
      header: t("recordTemplates.missing.columns.issues"),
      renderCell: renderIssues,
    },
    {
      id: "open",
      header: t("recordTemplates.missing.columns.open"),
      renderCell: (row) => (
        <Link to={recordsLinkFor(portal, { kind: "staff", id: row.user_id })}>
          {t("recordTemplates.missing.openRecord", { name: row.name })}
        </Link>
      ),
    },
  ];

  const classColumns: DataGridColumn<RecordMissingClass>[] = [
    {
      id: "class",
      header: t("recordTemplates.missing.columns.class"),
      renderCell: (row) => (
        <div className="families-cell">
          <span>{row.code}</span>
          <span className="families-cell__muted">{row.course_name}</span>
        </div>
      ),
    },
    {
      id: "issues",
      header: t("recordTemplates.missing.columns.issues"),
      renderCell: renderIssues,
    },
    {
      id: "open",
      header: t("recordTemplates.missing.columns.open"),
      renderCell: (row) => (
        <Link to={recordsLinkFor(portal, { kind: "class", id: row.class_id })}>
          {t("recordTemplates.missing.openClassRecord", { code: row.code })}
        </Link>
      ),
    },
  ];

  const issueOptions = [
    { value: "all", label: t("recordTemplates.missing.issueAll") },
    ...ISSUES.map((value) => ({ value, label: t(`recordTemplates.missing.issues.${value}`) })),
  ];

  return (
    <>
      <div className="families-header">
        <div>
          <h1>{t("recordTemplates.missing.title")}</h1>
          <p>{t("recordTemplates.missing.intro")}</p>
        </div>
      </div>

      <div className="families-toolbar">
        <Select
          label={t("recordTemplates.missing.issueFilter")}
          options={issueOptions}
          value={issue ?? "all"}
          onChange={(value) => setIssue(value === "all" ? null : (value as RecordMissingIssue))}
        />
      </div>

      <Tabs defaultValue="students">
        <Tabs.List aria-label={t("recordTemplates.missing.subjects")}>
          <Tabs.Tab value="students">{t("recordTemplates.missing.students.tab")}</Tabs.Tab>
          <Tabs.Tab value="parents">{t("recordTemplates.missing.parents.tab")}</Tabs.Tab>
          {showStaff ? (
            <Tabs.Tab value="staff">{t("recordTemplates.missing.staff.tab")}</Tabs.Tab>
          ) : null}
          {showClasses ? (
            <Tabs.Tab value="classes">{t("recordTemplates.missing.classes.tab")}</Tabs.Tab>
          ) : null}
        </Tabs.List>
        <Tabs.Panel value="students">
          <MissingSection<RecordMissingStudent>
            kind="students"
            issue={issue}
            title={t("recordTemplates.missing.students.title")}
            searchLabel={t("recordTemplates.missing.students.search")}
            caption={t("recordTemplates.missing.students.caption")}
            empty={t("recordTemplates.missing.students.empty")}
            fetchPage={fetchMissingStudents}
            columns={studentColumns}
            getRowId={(row) => row.student_id}
            getRowLabel={(row) => row.name}
          />
        </Tabs.Panel>
        <Tabs.Panel value="parents">
          <MissingSection<RecordMissingParent>
            kind="parents"
            issue={issue}
            title={t("recordTemplates.missing.parents.title")}
            searchLabel={t("recordTemplates.missing.parents.search")}
            caption={t("recordTemplates.missing.parents.caption")}
            empty={t("recordTemplates.missing.parents.empty")}
            fetchPage={fetchMissingParents}
            columns={parentColumns}
            getRowId={(row) => row.user_id}
            getRowLabel={(row) => row.name}
          />
        </Tabs.Panel>
        {showStaff ? (
          <Tabs.Panel value="staff">
            <MissingSection<RecordMissingStaff>
              kind="staff"
              issue={issue}
              title={t("recordTemplates.missing.staff.title")}
              searchLabel={t("recordTemplates.missing.staff.search")}
              caption={t("recordTemplates.missing.staff.caption")}
              empty={t("recordTemplates.missing.staff.empty")}
              fetchPage={fetchMissingStaff}
              columns={staffColumns}
              getRowId={(row) => row.user_id}
              getRowLabel={(row) => row.name}
            />
          </Tabs.Panel>
        ) : null}
        {showClasses ? (
          <Tabs.Panel value="classes">
            <MissingSection<RecordMissingClass>
              kind="classes"
              issue={issue}
              title={t("recordTemplates.missing.classes.title")}
              searchLabel={t("recordTemplates.missing.classes.search")}
              caption={t("recordTemplates.missing.classes.caption")}
              empty={t("recordTemplates.missing.classes.empty")}
              fetchPage={fetchMissingClasses}
              columns={classColumns}
              getRowId={(row) => row.class_id}
              getRowLabel={(row) => row.code}
            />
          </Tabs.Panel>
        ) : null}
      </Tabs>
    </>
  );
}

interface MissingSectionProps<T> {
  kind: "students" | "parents" | "staff" | "classes";
  issue: RecordMissingIssue | null;
  title: string;
  searchLabel: string;
  caption: string;
  empty: string;
  fetchPage: (
    search: string,
    issue: RecordMissingIssue | null,
    offset: number,
  ) => Promise<MissingPage<T>>;
  columns: DataGridColumn<T>[];
  getRowId: (row: T) => string;
  getRowLabel: (row: T) => string;
}

function MissingSection<T>({
  kind,
  issue,
  title,
  searchLabel,
  caption,
  empty,
  fetchPage,
  columns,
  getRowId,
  getRowLabel,
}: MissingSectionProps<T>) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [lastIssue, setLastIssue] = useState(issue);

  // A new issue filter starts again from the first page.
  if (lastIssue !== issue) {
    setLastIssue(issue);
    setOffset(0);
  }

  const query = useQuery({
    queryKey: [...MISSING_KEY, kind, search, issue, offset],
    queryFn: () => fetchPage(search, issue, offset),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  function applySearch() {
    setSearch(searchInput);
    setOffset(0);
  }

  return (
    <section aria-labelledby={`records-missing-${kind}`} className="unlinked-section">
      <h2 id={`records-missing-${kind}`}>
        {title}{" "}
        {query.data ? (
          <span className="families-badge" data-tone={total > 0 ? "warning" : "success"}>
            {formatNumber(total)}
          </span>
        ) : null}
      </h2>

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
        // The section's h2 already names the table on screen.
        hideCaption
        columns={columns}
        rows={items}
        getRowId={getRowId}
        getRowLabel={getRowLabel}
        loading={query.isPending}
        empty={query.isError ? t("recordTemplates.missing.loadError") : empty}
      />

      <div className="families-pagination">
        <Button
          variant="secondary"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - MISSING_PAGE_SIZE))}
        >
          {t("recordTemplates.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={offset + items.length >= total}
          onClick={() => setOffset(offset + MISSING_PAGE_SIZE)}
        >
          {t("recordTemplates.common.next")}
        </Button>
      </div>
    </section>
  );
}
