import { PERMISSIONS } from "@studafy/constants";
import { Select } from "@studafy/ui";
import { NavLink, Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { pickCurrentYear, useAcademicYears } from "../school/queries";

import { ApprovalsTab } from "./ApprovalsTab";
import { CertificateView } from "./CertificateView";
import { YearStatusBadge } from "./components";
import { SETUP_BASE } from "./context";
import { OverviewTab } from "./OverviewTab";
import { useGradingOverview } from "./queries";
import { ResultsTab } from "./ResultsTab";
import { ScalesTab } from "./ScalesTab";
import { SectionsTab } from "./SectionsTab";
import { SubjectsTab } from "./SubjectsTab";

import type { SetupContext } from "./context";

import "../school/principal-school.css";
import "./academic-setup.css";

interface TabDef {
  path: string;
  key: string;
  show: (ctx: SetupContext) => boolean;
}

const TABS: readonly TabDef[] = [
  { path: "", key: "overview", show: () => true },
  { path: "subjects", key: "subjects", show: () => true },
  { path: "sections", key: "sections", show: () => true },
  { path: "scales", key: "scales", show: () => true },
  { path: "approvals", key: "approvals", show: (ctx) => ctx.can.review },
  { path: "results", key: "results", show: (ctx) => ctx.can.finalize || ctx.can.certify },
];

/**
 * Academic setup (`/portal/principal/academic-setup/*`), gated on `academicConfig:read`: one
 * academic year's grading configuration from first set-up to certificates. The year is picked once
 * here (and kept in `?year=` across the tabs); each tab is its own screen:
 *
 * - overview — readiness counts, publish/finalize/archive, issues, the guided checklist, copy a year;
 * - subjects — per grade: grade policies and the default subjects every section inherits;
 * - sections — what each section inherits, overrides or excludes, its teachers and electives;
 * - scales — the year's grading scales;
 * - approvals — submitted mark sheets and teacher-proposed assessments;
 * - results — preview, finalize, correct, and certificates; `certificates/:id` prints one.
 *
 * Writes are gated per permission (manage, review, finalize, certify) as well as by the API.
 */
export default function AcademicSetupPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const years = useAcademicYears();
  const yearList = years.data ?? [];
  const year = yearList.find((y) => y.id === params.get("year")) ?? pickCurrentYear(yearList);
  const overview = useGradingOverview(year?.id);
  const status = overview.data?.year.grading_config_status;
  const printing = location.pathname.includes("/certificates/");

  const ctx: SetupContext | null = year
    ? {
        year,
        years: yearList,
        overview: overview.data,
        status,
        configEditable: status === "draft" || status === "active",
        can: {
          manage: permissions.has(PERMISSIONS.ACADEMIC_CONFIG_MANAGE),
          finalize: permissions.has(PERMISSIONS.RESULT_FINALIZE),
          certify: permissions.has(PERMISSIONS.ACADEMIC_CERTIFICATE_ISSUE),
          review: permissions.has(PERMISSIONS.APPROVAL_REVIEW),
        },
        search: `?year=${year.id}`,
      }
    : null;

  return (
    <>
      {printing ? null : (
        <>
          <div className="principal-school__header">
            <h1>{t("academicGrading.title")}</h1>
            {status ? <YearStatusBadge status={status} /> : null}
          </div>
          <p>{t("academicGrading.description")}</p>
          <div className="principal-school__filters">
            <Select
              label={t("academicGrading.yearLabel")}
              options={yearList.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
              }))}
              value={year?.id}
              onChange={(id) => setParams({ year: id })}
              placeholder={t("academicGrading.noYears")}
              disabled={yearList.length === 0}
            />
          </div>
          {ctx ? (
            <nav className="ag-tabs" aria-label={t("academicGrading.tabs.label")}>
              {TABS.filter((tab) => tab.show(ctx)).map((tab) => (
                <NavLink
                  key={tab.key}
                  to={`${SETUP_BASE}${tab.path ? `/${tab.path}` : ""}${ctx.search}`}
                  end={tab.path === ""}
                  className={({ isActive }) => `ag-tab${isActive ? " ag-tab--active" : ""}`}
                >
                  {t(`academicGrading.tabs.${tab.key}`)}
                </NavLink>
              ))}
            </nav>
          ) : null}
        </>
      )}

      {years.isPending ? (
        <p className="ag-muted" role="status">
          {t("academicGrading.common.loading")}
        </p>
      ) : years.isError ? (
        <p className="ag-error" role="alert">
          {t("academicGrading.yearsError")}
        </p>
      ) : !ctx ? (
        <p className="ag-muted">{t("academicGrading.noYearsHint")}</p>
      ) : overview.isError && !printing ? (
        <p className="ag-error" role="alert">
          {t("academicGrading.overviewError")}
        </p>
      ) : (
        <Routes>
          <Route index element={<OverviewTab ctx={ctx} />} />
          <Route path="subjects" element={<SubjectsTab ctx={ctx} />} />
          <Route path="sections" element={<SectionsTab ctx={ctx} />} />
          <Route path="scales" element={<ScalesTab ctx={ctx} />} />
          {ctx.can.review ? <Route path="approvals" element={<ApprovalsTab ctx={ctx} />} /> : null}
          {ctx.can.finalize || ctx.can.certify ? (
            <Route path="results" element={<ResultsTab ctx={ctx} />} />
          ) : null}
          <Route path="certificates/:certificateId" element={<CertificateView ctx={ctx} />} />
          <Route path="*" element={<Navigate to={`${SETUP_BASE}${ctx.search}`} replace />} />
        </Routes>
      )}
    </>
  );
}
