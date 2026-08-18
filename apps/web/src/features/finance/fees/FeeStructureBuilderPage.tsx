import { Button, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { FeeStructureForm } from "./FeeStructureForm";
import { feeStructureStatusLabel, feeStructureStatusTone } from "./labels";
import {
  ACADEMIC_YEARS_KEY,
  fetchAcademicYears,
  fetchFeeStructures,
  feeStructuresQueryKey,
} from "./queries";

import "./fee-structure-builder.css";

import type { AcademicYear } from "./queries";
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
    { value: "", label: "All academic years" },
    ...years.map((year) => ({ value: year.id, label: year.name })),
  ];

  function handleSaved() {
    setSelectedErpnextName(null);
  }

  return (
    <>
      <div className="fee-builder__header">
        <div>
          <h1>Fee structures</h1>
          <p>
            Build fee structures, see how they price out for a sample student, and track versions.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setSelectedErpnextName(null)}>
          New fee structure
        </Button>
      </div>

      <div className="fee-builder__filter">
        <Select
          label="Academic year"
          options={yearFilterOptions}
          value={academicYearId}
          onChange={(value) => {
            setAcademicYearId(value);
            setSelectedErpnextName(null);
          }}
        />
      </div>

      <div className="fee-builder__layout">
        <section className="fee-builder__list" aria-label="Existing fee structures">
          {structuresQuery.isPending ? (
            <p>Loading…</p>
          ) : structures.length === 0 ? (
            <p className="fee-builder__list-empty">No fee structures yet for this filter.</p>
          ) : (
            <table className="fee-builder__list-table">
              <caption className="sf-visually-hidden">Fee structures</caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Program</th>
                  <th scope="col">Total</th>
                  <th scope="col">Status</th>
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
                        {feeStructureStatusLabel(structure.erpnext_status)}
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
