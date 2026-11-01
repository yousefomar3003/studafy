import { Button, Checkbox, Input, Select } from "@studafy/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { errorDetail } from "./CustomListsPage";
import {
  COLUMN_TYPES,
  IMPORT_KEYS,
  LISTS_PATH,
  audiencesFor,
  customListsKey,
  listHref,
} from "./queries";
import { takePendingSheet } from "./sheet-handoff";

import "./custom-lists.css";

import type {
  ColumnFieldType,
  CustomListAudience,
  CustomListImportBody,
  CustomListImportKey,
  CustomListImportPreview,
} from "./queries";
import type { PendingSheet } from "./sheet-handoff";
import type { FormEvent } from "react";

/** Preview rows listed per page; the totals always cover every row. */
const ROWS_PER_PAGE = 100;

interface ColumnChoice {
  index: number;
  include: boolean;
  label_en: string;
  label_ar: string;
  field_type: ColumnFieldType;
  sensitivity: "standard" | "sensitive";
}

function baseName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, 120);
}

/**
 * "Create a custom list from a sheet" (`/portal/lists/import`, `customList:manage`). A CSV whose
 * first line names its columns becomes a new list: the API guesses each column's type and whether
 * it looks sensitive, staff confirm names, types and sensitivity, and may link rows by one column
 * of school-issued keys, matched exactly. The preview lists every row's proposed link or why it has
 * none. Nothing is written until "Create list", which sends the preview's token back; any edit
 * discards the preview, so what is created is always what was last previewed.
 */
export default function CustomListImportPage() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileId = useId();
  const audiences = audiencesFor(roles);
  const [sheet, setSheet] = useState<PendingSheet | null>(() => takePendingSheet());
  const [nameEn, setNameEn] = useState(() => (sheet ? baseName(sheet.fileName) : ""));
  const [nameAr, setNameAr] = useState(() => (sheet ? baseName(sheet.fileName) : ""));
  const [audience, setAudience] = useState<CustomListAudience>(audiences[0]!);
  const [columns, setColumns] = useState<ColumnChoice[] | null>(null);
  const [linkColumn, setLinkColumn] = useState("");
  const [linkKey, setLinkKey] = useState<CustomListImportKey>("admission_number");
  const [skipUnmatched, setSkipUnmatched] = useState(false);
  const [preview, setPreview] = useState<{
    body: CustomListImportBody;
    result: CustomListImportPreview;
  } | null>(null);
  const [rowPage, setRowPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Any edit discards the preview: nothing can be created that was not previewed. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setPreview(null);
      setError(null);
    };
  }

  async function chooseFile(file: File) {
    const csv = await file.text();
    setSheet({ fileName: file.name, csv });
    if (!nameEn) setNameEn(baseName(file.name));
    if (!nameAr) setNameAr(baseName(file.name));
    setColumns(null);
    setLinkColumn("");
    setPreview(null);
  }

  function requestBody(): CustomListImportBody | null {
    if (!sheet) return null;
    return {
      csv: sheet.csv,
      file_name: sheet.fileName,
      list: { name_en: nameEn.trim(), name_ar: nameAr.trim(), audience },
      ...(columns ? { columns } : {}),
      link: linkColumn === "" ? null : { column_index: Number(linkColumn), key: linkKey },
      skip_unmatched: skipUnmatched,
    };
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!sheet) {
      setError(t("customLists.import.chooseFileFirst"));
      return;
    }
    if (!nameEn.trim() || !nameAr.trim()) {
      setError(t("customLists.index.namesRequired"));
      return;
    }
    const body = requestBody()!;
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.POST("/api/custom-lists/imports/preview", { body });
      const result = data as CustomListImportPreview;
      setPreview({ body, result });
      setRowPage(0);
      if (!columns) {
        setColumns(
          result.columns.map((column) => ({
            index: column.index,
            include: column.include,
            label_en: column.label_en,
            label_ar: column.label_ar,
            field_type: column.field_type,
            sensitivity: column.sensitivity,
          })),
        );
      }
    } catch (caught) {
      setError(errorDetail(caught) ?? t("customLists.import.previewError"));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.POST("/api/custom-lists/imports/apply", {
        body: { ...preview.body, preview_token: preview.result.preview_token },
      });
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      if (data) navigate(listHref(data.list_id));
    } catch (caught) {
      setPreview(null);
      setError(errorDetail(caught) ?? t("customLists.import.applyError"));
    } finally {
      setBusy(false);
    }
  }

  const setColumn = (index: number, patch: Partial<ColumnChoice>) =>
    edit(setColumns)(
      (columns ?? []).map((column) => (column.index === index ? { ...column, ...patch } : column)),
    );

  const result = preview?.result;
  const guessed = new Map(result?.columns.map((column) => [column.index, column]) ?? []);
  const headers = result?.columns ?? [];
  const visibleRows = result?.rows.slice(rowPage * ROWS_PER_PAGE, (rowPage + 1) * ROWS_PER_PAGE);

  const statusText = (row: CustomListImportPreview["rows"][number]) => {
    if (row.status === "linked") {
      return t("customLists.import.status.linked", {
        name: row.link?.name ?? t("customLists.rows.notVisible"),
        kind: row.link ? t(`customLists.linkKinds.${row.link.kind}`) : "",
      });
    }
    if (row.reason) return t(`customLists.import.reasons.${row.reason}`);
    return t(`customLists.import.status.${row.status}`);
  };

  return (
    <>
      <p>
        <Link to={LISTS_PATH}>{t("customLists.list.back")}</Link>
      </p>
      <h1>{t("customLists.import.title")}</h1>
      <p className="custom-lists__muted">{t("customLists.import.intro")}</p>

      <form
        className="custom-lists__import"
        onSubmit={(event) => void runPreview(event)}
        noValidate
      >
        <div className="custom-lists__file">
          <label htmlFor={fileId}>{t("customLists.import.file")}</label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void chooseFile(file);
              event.target.value = "";
            }}
          />
          {sheet ? (
            <p className="custom-lists__muted">
              {t("customLists.import.chosen", { file: sheet.fileName })}
            </p>
          ) : null}
        </div>

        <Input
          label={t("customLists.settings.nameEn")}
          value={nameEn}
          onChange={(event) => edit(setNameEn)(event.target.value)}
          required
        />
        <Input
          label={t("customLists.settings.nameAr")}
          value={nameAr}
          dir="rtl"
          onChange={(event) => edit(setNameAr)(event.target.value)}
          required
        />
        <Select
          label={t("customLists.settings.audience")}
          options={audiences.map((value) => ({ value, label: t(`customLists.audience.${value}`) }))}
          value={audience}
          onChange={edit((value: string) => setAudience(value as CustomListAudience))}
        />

        {columns ? (
          <>
            <fieldset className="custom-lists__fieldset">
              <legend>{t("customLists.import.linkTitle")}</legend>
              <p className="custom-lists__muted">{t("customLists.import.linkHelp")}</p>
              <Select
                label={t("customLists.import.linkColumn")}
                options={[
                  { value: "", label: t("customLists.import.noLink") },
                  ...headers.map((column) => ({
                    value: String(column.index),
                    label: column.header,
                  })),
                ]}
                value={linkColumn}
                onChange={edit(setLinkColumn)}
              />
              {linkColumn !== "" ? (
                <>
                  <Select
                    label={t("customLists.import.linkKey")}
                    options={IMPORT_KEYS.map((key) => ({
                      value: key,
                      label: t(`customLists.import.keys.${key}`),
                    }))}
                    value={linkKey}
                    onChange={edit((value: string) => setLinkKey(value as CustomListImportKey))}
                  />
                  <Checkbox
                    label={t("customLists.import.skipUnmatched")}
                    checked={skipUnmatched}
                    onChange={(event) => edit(setSkipUnmatched)(event.target.checked)}
                  />
                </>
              ) : null}
            </fieldset>

            <div className="custom-lists__scroll">
              <table className="custom-lists__table">
                <caption>{t("customLists.import.columnsTitle")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("customLists.import.columns.keep")}</th>
                    <th scope="col">{t("customLists.import.columns.header")}</th>
                    <th scope="col">{t("customLists.import.columns.labels")}</th>
                    <th scope="col">{t("customLists.import.columns.type")}</th>
                    <th scope="col">{t("customLists.import.columns.sensitive")}</th>
                    <th scope="col">{t("customLists.import.columns.sample")}</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column) => {
                    const info = guessed.get(column.index);
                    const header = info?.header ?? String(column.index + 1);
                    return (
                      <tr key={column.index}>
                        <td>
                          <Checkbox
                            label={t("customLists.import.keepColumn", { column: header })}
                            checked={column.include}
                            onChange={(event) =>
                              setColumn(column.index, { include: event.target.checked })
                            }
                          />
                        </td>
                        <td>{header}</td>
                        <td>
                          <Input
                            label={t("customLists.import.labelEnFor", { column: header })}
                            value={column.label_en}
                            onChange={(event) =>
                              setColumn(column.index, { label_en: event.target.value })
                            }
                          />
                          <Input
                            label={t("customLists.import.labelArFor", { column: header })}
                            value={column.label_ar}
                            dir="rtl"
                            onChange={(event) =>
                              setColumn(column.index, { label_ar: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <Select
                            label={t("customLists.import.typeFor", { column: header })}
                            options={COLUMN_TYPES.map((type) => ({
                              value: type,
                              label: t(`customLists.types.${type}`),
                            }))}
                            value={column.field_type}
                            onChange={(value) =>
                              setColumn(column.index, { field_type: value as ColumnFieldType })
                            }
                            helperText={
                              info
                                ? t("customLists.import.guessed", {
                                    type: t(`customLists.types.${info.guessed_type}`),
                                  })
                                : undefined
                            }
                          />
                          {info && info.invalid_count > 0 ? (
                            <p className="custom-lists__error">
                              {t("customLists.import.invalidCells", {
                                count: info.invalid_count,
                                lines: info.invalid_lines.join(", "),
                              })}
                            </p>
                          ) : null}
                        </td>
                        <td>
                          <Checkbox
                            label={t("customLists.import.sensitiveFor", { column: header })}
                            checked={column.sensitivity === "sensitive"}
                            onChange={(event) =>
                              setColumn(column.index, {
                                sensitivity: event.target.checked ? "sensitive" : "standard",
                              })
                            }
                          />
                          {info?.suggested_sensitive ? (
                            <p className="custom-lists__muted">
                              {t("customLists.import.suggestedSensitive")}
                            </p>
                          ) : null}
                        </td>
                        <td>{info?.sample.join(", ") ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="custom-lists__error">
            {error}
          </p>
        ) : null}

        <div className="custom-lists__actions">
          <Button type="submit" variant="secondary" loading={busy && !preview}>
            {t(columns ? "customLists.import.previewAgain" : "customLists.import.preview")}
          </Button>
          {result ? (
            <Button
              type="button"
              loading={busy}
              disabled={result.totals.rows - result.totals.skipped === 0}
              onClick={() => void create()}
            >
              {t("customLists.import.create", {
                count: result.totals.rows - result.totals.skipped,
              })}
            </Button>
          ) : null}
        </div>
      </form>

      {result ? (
        <section aria-label={t("customLists.import.previewTitle")}>
          <h2>{t("customLists.import.previewTitle")}</h2>
          <p role="status">
            {t("customLists.import.summary", {
              count: result.totals.rows,
              linked: result.totals.linked,
              unmatched: result.totals.unmatched,
              skipped: result.totals.skipped,
            })}
          </p>
          {result.totals.invalid_cells > 0 ? (
            <p>{t("customLists.import.invalidTotal", { count: result.totals.invalid_cells })}</p>
          ) : null}
          <div className="custom-lists__scroll">
            <table className="custom-lists__table">
              <caption>{t("customLists.import.rowsTitle")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("customLists.import.rowColumns.line")}</th>
                  <th scope="col">{t("customLists.import.rowColumns.key")}</th>
                  <th scope="col">{t("customLists.import.rowColumns.outcome")}</th>
                </tr>
              </thead>
              <tbody>
                {(visibleRows ?? []).map((row) => (
                  <tr key={row.line}>
                    <td>{row.line}</td>
                    <td>{row.key ?? "—"}</td>
                    <td>{statusText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.rows.length > ROWS_PER_PAGE ? (
            <div className="custom-lists__pager">
              <p>
                {t("customLists.rows.range", {
                  first: rowPage * ROWS_PER_PAGE + 1,
                  last: Math.min(result.rows.length, (rowPage + 1) * ROWS_PER_PAGE),
                  total: result.rows.length,
                })}
              </p>
              <Button
                type="button"
                variant="tertiary"
                disabled={rowPage === 0}
                onClick={() => setRowPage(rowPage - 1)}
              >
                {t("customLists.rows.previous")}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                disabled={(rowPage + 1) * ROWS_PER_PAGE >= result.rows.length}
                onClick={() => setRowPage(rowPage + 1)}
              >
                {t("customLists.rows.next")}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
