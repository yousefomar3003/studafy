import { Button, useToast } from "@studafy/ui";
import { useState } from "react";

import { downloadCsv } from "../lib/csv";
import {
  buildExportCsv,
  exportFilename,
  importErrorMessage,
  MAX_EXPORT_ROWS,
} from "../lib/data-transfer";
import { useTranslation } from "../lib/i18n";

import type { CollectedRows, ExportColumn } from "../lib/data-transfer";

export interface ExportCsvButtonProps<TRow> {
  /** File name stem; the date and `.csv` are appended. */
  filename: string;
  columns: readonly ExportColumn<TRow>[];
  /** Resolves every row matching the page's current filters (see `collectCursorPages` and co.). */
  getRows: () => Promise<CollectedRows<TRow>>;
  disabled?: boolean;
}

/**
 * Downloads the table as CSV — all rows matching the current filters, not only the visible page.
 * Values are written as plain text (no translated labels where the API has a stable code), so a
 * re-import or spreadsheet formula sees the same values the API does.
 */
export function ExportCsvButton<TRow>({
  filename,
  columns,
  getRows,
  disabled,
}: ExportCsvButtonProps<TRow>) {
  const { t } = useTranslation();
  const { show } = useToast();
  const [busy, setBusy] = useState(false);

  const handleExport = async () => {
    setBusy(true);
    try {
      const { rows, truncated } = await getRows();
      if (rows.length === 0) {
        show({ variant: "info", title: t("dataTransfer.export.empty") });
        return;
      }
      downloadCsv(exportFilename(filename), buildExportCsv(columns, rows));
      show(
        truncated
          ? {
              variant: "warning",
              title: t("dataTransfer.export.truncated", { count: MAX_EXPORT_ROWS }),
            }
          : { variant: "success", title: t("dataTransfer.export.done", { count: rows.length }) },
      );
    } catch (error) {
      show({
        variant: "error",
        title: t("dataTransfer.export.failed"),
        description: importErrorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      loading={busy}
      disabled={disabled}
      onClick={() => void handleExport()}
    >
      {t("dataTransfer.export.button")}
    </Button>
  );
}
