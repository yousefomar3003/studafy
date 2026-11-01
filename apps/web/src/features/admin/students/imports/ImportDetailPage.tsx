import { Button, Card, Chip } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../../lib/i18n";

import { MapColumnPanel } from "./MapColumnPanel";
import { fetchImport, fetchImportColumns, importColumnsKey, importDetailKey } from "./queries";
import { SourceFileActions } from "./SourceFileActions";

import "./imports.css";

import type { UnmappedColumn, UnmappedColumns } from "./queries";

/**
 * One import (`/portal/admin/students/imports/:importId`): its outcome, its original file, and the
 * columns no field read. A completed import's column can be mapped to a student or parent record
 * field -- an existing one, or a new one created from the column -- and written to the people this
 * import created or updated, after a preview (MapColumnPanel).
 */
export default function ImportDetailPage() {
  const { importId = "" } = useParams<{ importId: string }>();
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const [banner, setBanner] = useState<string | null>(null);
  const [mapping, setMapping] = useState<UnmappedColumn | null>(null);
  const base = "adminPeople.students.importHistory.detail";

  const record = useQuery({
    queryKey: importDetailKey(importId),
    queryFn: () => fetchImport(importId),
  });
  const columns = useQuery({
    queryKey: importColumnsKey(importId),
    queryFn: () => fetchImportColumns(importId),
  });

  if (record.isPending) {
    return <p role="status">{t("adminPeople.students.importHistory.common.loading")}</p>;
  }
  if (record.isError || !record.data) {
    return <p role="alert">{t(`${base}.loadError`)}</p>;
  }
  const data = record.data;

  return (
    <>
      <p>
        <Link to="/portal/admin/students/imports">{t(`${base}.back`)}</Link>
      </p>
      <h1>{t(`${base}.title`, { name: data.file_name })}</h1>
      <p>
        {t(`${base}.uploadedOn`, {
          date: formatDate(new Date(data.created_at), { dateStyle: "medium", timeStyle: "short" }),
        })}{" "}
        · {t(`adminPeople.students.importHistory.status.${data.status}`)}
      </p>

      {banner ? (
        <p role="alert" className="import-history__banner">
          {banner}
        </p>
      ) : null}

      <Card as="section" aria-labelledby="import-original-heading">
        <Card.Body>
          <h2 id="import-original-heading">{t(`${base}.originalHeading`)}</h2>
          <SourceFileActions record={data} onError={setBanner} />
        </Card.Body>
      </Card>

      <Card as="section" aria-labelledby="import-columns-heading">
        <Card.Body>
          <h2 id="import-columns-heading">{t(`${base}.columnsHeading`)}</h2>
          {columns.isPending ? (
            <p role="status">{t("adminPeople.students.importHistory.common.loading")}</p>
          ) : columns.isError || !columns.data ? (
            <p role="alert">{t(`${base}.columnsError`)}</p>
          ) : (
            <ColumnList columns={columns.data} onMap={setMapping} />
          )}
        </Card.Body>
      </Card>

      {mapping && columns.data ? (
        <MapColumnPanel importId={importId} column={mapping} onClose={() => setMapping(null)} />
      ) : null}
    </>
  );
}

function ColumnList({
  columns,
  onMap,
}: {
  columns: UnmappedColumns;
  onMap: (column: UnmappedColumn) => void;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const base = "adminPeople.students.importHistory.columns";

  if (columns.columns.length === 0) return <p>{t(`${base}.none`)}</p>;

  const notice = columns.can_apply
    ? columns.cells_expire_at
      ? t(`${base}.expires`, {
          date: formatDate(new Date(columns.cells_expire_at), { dateStyle: "medium" }),
        })
      : null
    : columns.status === "completed"
      ? t(`${base}.cellsGone`)
      : t(`${base}.notCompleted`);

  return (
    <>
      {notice ? <p className="import-history__notice">{notice}</p> : null}
      <ul className="import-history__columns">
        {columns.columns.map((column) => (
          <li key={column.position} className="import-history__column">
            <div>
              <strong>{column.header}</strong>{" "}
              {column.suggested_sensitive ? (
                <Chip variant="outlined">{t(`${base}.looksSensitive`)}</Chip>
              ) : null}
              <p>
                {t(`${base}.values`, { count: column.non_empty_count })} ·{" "}
                {t(`${base}.suggested`, {
                  type: t(`recordTemplates.types.${column.suggested_field_type}`),
                })}
              </p>
              {column.applied ? (
                <p>
                  {t(`${base}.applied`, {
                    field: column.applied.label_en,
                    count: column.applied.count,
                    count_formatted: formatNumber(column.applied.count),
                    date: formatDate(new Date(column.applied.applied_at), { dateStyle: "medium" }),
                  })}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={!columns.can_apply}
              onClick={() => onMap(column)}
              aria-label={t(`${base}.mapNamed`, { header: column.header })}
            >
              {t(`${base}.map`)}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
