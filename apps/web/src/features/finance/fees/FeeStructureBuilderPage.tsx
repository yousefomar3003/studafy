import { Button, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { allRows } from "../../../lib/data-transfer";
import { useTranslation } from "../../../lib/i18n";

import { FeeStructureForm } from "./FeeStructureForm";
import { feeStructureStatusLabel, feeStructureStatusTone } from "./labels";
import {
  ACADEMIC_YEARS_KEY,
  fetchAcademicYears,
  fetchFeeStructures,
  feeStructuresQueryKey,
} from "./queries";

import "./fee-structure-builder.css";

import type { AcademicYear, FeeStructure } from "./queries";
import type { ExportColumn } from "../../../lib/data-transfer";
import type { SelectOption } from "@studafy/ui";

/**
 * Fee structure builder (`/portal/finance/fees`), gated by `billing:update` — the same permission
 * the gateway routes themselves require (see `apps/api/src/modules/finance/fee-structures/routes.ts`),
 * held by FINANCE and ORG_ADMIN. A year → structure drill-down: pick an academic year to scope the
 * list, select an existing structure to view/edit it, or start a new one. `FeeStructureForm` owns the
 * item composition, validation, and the invoice preview; this page owns which structure is loaded
 * into it.
 */
export default function FeeStructureBuilderPage() {
  const { t } = useTranslation();
  const [academicYearId, setAcademicYearId] = useState("");
  const [selectedErpnextName, setSelectedErpnextName] = useState<string | null>(null);

  const yearsQuery = useQuery({ queryKey: ACADEMIC_YEARS_KEY, queryFn: fetchAcademicYears });
  const structuresQuery = useQuery({
    queryKey: feeStructuresQueryKey(academicYearId),
    queryFn: () => fetchFeeStructures(academicYearId),
  });

  const years = (yearsQuery.data ?? []) as AcademicYear[];
  const structures = structuresQuery.data ?? [];
  const editing = structures.find((s) => s.erpnext_name === selectedErpnextName) ?? null;

  const yearFilterOptions: SelectOption<string>[] = [
    { value: "", label: t("finance.fees.builder.allYears") },
    ...years.map((year) => ({ value: year.id, label: year.name })),
  ];

  function handleSaved() {
    setSelectedErpnextName(null);
  }

  // The list is already loaded whole for the selected year, so export is just these rows.
  const exportColumns: ExportColumn<FeeStructure>[] = [
    { header: t("finance.fees.builder.colTitle"), value: (row) => row.title },
    { header: t("finance.fees.builder.colProgram"), value: (row) => row.program },
    { header: t("finance.common.total"), value: (row) => row.total_amount },
    { header: t("finance.common.currency"), value: (row) => row.currency },
    {
      header: t("finance.common.status"),
      value: (row) => feeStructureStatusLabel(row.erpnext_status, t),
    },
    { header: t("finance.common.erpnextDocument"), value: (row) => row.erpnext_name },
  ];

  return (
    <>
      <div className="fee-builder__header">
        <div>
          <h1>{t("finance.fees.builder.title")}</h1>
          <p>{t("finance.fees.builder.intro")}</p>
        </div>
        <div className="fee-builder__header-actions">
          <ExportCsvButton
            filename="fee-structures"
            columns={exportColumns}
            getRows={() => Promise.resolve(allRows(structures))}
            disabled={structuresQuery.isPending}
          />
          <Button variant="secondary" onClick={() => setSelectedErpnextName(null)}>
            {t("finance.fees.builder.newStructure")}
          </Button>
        </div>
      </div>

      <div className="fee-builder__filter">
        <Select
          label={t("finance.fees.builder.academicYear")}
          options={yearFilterOptions}
          value={academicYearId}
          onChange={(value) => {
            setAcademicYearId(value);
            setSelectedErpnextName(null);
          }}
        />
      </div>

      <div className="fee-builder__layout">
        <section className="fee-builder__list" aria-label={t("finance.fees.builder.existing")}>
          {structuresQuery.isPending ? (
            <p>{t("finance.common.loading")}</p>
          ) : structures.length === 0 ? (
            <p className="fee-builder__list-empty">{t("finance.fees.builder.empty")}</p>
          ) : (
            <table className="fee-builder__list-table">
              <caption className="sf-visually-hidden">{t("finance.fees.builder.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("finance.fees.builder.colTitle")}</th>
                  <th scope="col">{t("finance.fees.builder.colProgram")}</th>
                  <th scope="col">{t("finance.common.total")}</th>
                  <th scope="col">{t("finance.common.status")}</th>
                </tr>
              </thead>
              <tbody>
                {structures.map((structure) => (
                  <tr key={structure.erpnext_name}>
                    <td>
                      <button
                        type="button"
                        className="fee-builder__list-row-button"
                        aria-current={structure.erpnext_name === selectedErpnextName}
                        onClick={() => setSelectedErpnextName(structure.erpnext_name)}
                      >
                        {structure.title}
                      </button>
                    </td>
                    <td>{structure.program ?? "—"}</td>
                    <td>
                      {structure.total_amount} {structure.currency}
                    </td>
                    <td>
                      <span
                        className="fee-builder__status-pill"
                        data-tone={feeStructureStatusTone(structure.erpnext_status)}
                      >
                        {feeStructureStatusLabel(structure.erpnext_status, t)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <FeeStructureForm academicYears={years} editing={editing} onSaved={handleSaved} />
      </div>
    </>
  );
}
