import { ApiError } from "@studafy/api-client";
import { Button, Card, Input } from "@studafy/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { LinkButton } from "../../../../components/LinkButton";
import { useFormatters, useTranslation } from "../../../../lib/i18n";

import { useUpdateImportSettings } from "./mutations";
import {
  fetchImportHistoryPage,
  fetchImportSettings,
  IMPORT_HISTORY_KEY,
  IMPORT_SETTINGS_KEY,
} from "./queries";
import { SourceFileActions } from "./SourceFileActions";

import "./imports.css";

import type { ImportListItem } from "./queries";
import type { FormEvent } from "react";

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

/**
 * Import history (`/portal/admin/students/imports`): every student import, newest first, with its
 * outcome, who ran it, its original file (download, delete, or why it is gone) and how many of its
 * columns no field read. The retention card sets how long originals and leftover cells are kept --
 * shorter than the 180-day default, never longer (docs/modules/student-import-mapping-guide.md).
 */
export default function ImportHistoryPage() {
  const { t } = useTranslation();
  const [banner, setBanner] = useState<string | null>(null);

  const history = useInfiniteQuery({
    queryKey: IMPORT_HISTORY_KEY,
    queryFn: ({ pageParam }) => fetchImportHistoryPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const imports = history.data?.pages.flatMap((page) => page.imports) ?? [];

  return (
    <>
      <div className="import-history__header">
        <div>
          <h1>{t("adminPeople.students.importHistory.page.title")}</h1>
          <p>{t("adminPeople.students.importHistory.page.intro")}</p>
        </div>
        <LinkButton href="/portal/admin/students/import" variant="secondary">
          {t("adminPeople.students.importHistory.page.newImport")}
        </LinkButton>
      </div>

      {banner ? (
        <p role="alert" className="import-history__banner">
          {banner}
        </p>
      ) : null}

      <div className="import-history__cards">
        <RetentionCard onError={setBanner} />

        <Card as="section" aria-labelledby="import-history-list-heading">
          <Card.Body>
            <h2 id="import-history-list-heading">
              {t("adminPeople.students.importHistory.list.heading")}
            </h2>
            {history.isPending ? (
              <p role="status">{t("adminPeople.students.importHistory.common.loading")}</p>
            ) : history.isError ? (
              <p role="alert">{t("adminPeople.students.importHistory.list.loadError")}</p>
            ) : imports.length === 0 ? (
              <p>{t("adminPeople.students.importHistory.list.empty")}</p>
            ) : (
              <HistoryTable imports={imports} onError={setBanner} />
            )}
            {history.hasNextPage ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void history.fetchNextPage()}
                loading={history.isFetchingNextPage}
              >
                {t("adminPeople.students.importHistory.list.loadMore")}
              </Button>
            ) : null}
          </Card.Body>
        </Card>
      </div>
    </>
  );
}

function HistoryTable({
  imports,
  onError,
}: {
  imports: ImportListItem[];
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const base = "adminPeople.students.importHistory.list";

  return (
    <div className="import-history__table-wrap">
      <table className="import-history__table">
        <caption className="import-history__caption">{t(`${base}.caption`)}</caption>
        <thead>
          <tr>
            <th scope="col">{t(`${base}.columns.uploaded`)}</th>
            <th scope="col">{t(`${base}.columns.file`)}</th>
            <th scope="col">{t(`${base}.columns.status`)}</th>
            <th scope="col">{t(`${base}.columns.rows`)}</th>
            <th scope="col">{t(`${base}.columns.result`)}</th>
            <th scope="col">{t(`${base}.columns.by`)}</th>
            <th scope="col">{t(`${base}.columns.original`)}</th>
            <th scope="col">{t(`${base}.columns.unmapped`)}</th>
          </tr>
        </thead>
        <tbody>
          {imports.map((item) => (
            <tr key={item.id}>
              <td>
                {formatDate(new Date(item.created_at), { dateStyle: "medium", timeStyle: "short" })}
              </td>
              <td>
                <Link to={`/portal/admin/students/imports/${item.id}`}>{item.file_name}</Link>
              </td>
              <td>{t(`adminPeople.students.importHistory.status.${item.status}`)}</td>
              <td>
                {t(`${base}.rowCounts`, {
                  valid: formatNumber(item.valid_rows),
                  total: formatNumber(item.row_count),
                })}
                {item.error_rows > 0 ? (
                  <>
                    <br />
                    {t(`${base}.errorRows`, { count: item.error_rows })}
                  </>
                ) : null}
              </td>
              <td>
                {item.summary
                  ? t(`${base}.summary`, {
                      created: formatNumber(item.summary.students_created),
                      updated: formatNumber(item.summary.students_updated ?? 0),
                    })
                  : "—"}
              </td>
              <td>{item.uploaded_by_name ?? t(`${base}.unknownUser`)}</td>
              <td>
                <SourceFileActions record={item} onError={onError} />
              </td>
              <td>
                {item.unmapped_column_count > 0 ? (
                  <Link to={`/portal/admin/students/imports/${item.id}`}>
                    {t(`${base}.unmappedCount`, { count: item.unmapped_column_count })}
                  </Link>
                ) : (
                  t(`${base}.allMapped`)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How long originals and leftover cells are kept: a school can shorten it, never extend it. */
function RetentionCard({ onError }: { onError: (message: string) => void }) {
  const { t } = useTranslation();
  const base = "adminPeople.students.importHistory.retention";
  const settings = useQuery({ queryKey: IMPORT_SETTINGS_KEY, queryFn: fetchImportSettings });
  const update = useUpdateImportSettings();
  const [days, setDays] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) setDays(String(settings.data.source_retention_days));
  }, [settings.data]);

  const max = settings.data?.max_retention_days ?? 180;
  const parsed = Number(days);
  const invalid = !Number.isInteger(parsed) || parsed < 1 || parsed > max;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    setSaved(false);
    update.mutate(parsed, {
      onSuccess: () => setSaved(true),
      onError: (error) => onError(apiErrorMessage(error, t(`${base}.saveError`))),
    });
  }

  return (
    <Card as="section" aria-labelledby="import-retention-heading">
      <Card.Body>
        <h2 id="import-retention-heading">{t(`${base}.heading`)}</h2>
        <p>{t(`${base}.body`, { max })}</p>
        <form className="import-history__retention" onSubmit={handleSubmit} noValidate>
          <Input
            label={t(`${base}.label`)}
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
              setSaved(false);
            }}
            error={days !== "" && invalid ? t(`${base}.invalid`, { max }) : undefined}
            disabled={settings.isPending}
          />
          <Button type="submit" loading={update.isPending} disabled={invalid || settings.isPending}>
            {t(`${base}.save`)}
          </Button>
        </form>
        {saved ? <p role="status">{t(`${base}.saved`, { count: parsed })}</p> : null}
      </Card.Body>
    </Card>
  );
}
