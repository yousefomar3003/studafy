import { PERMISSIONS } from "@studafy/constants";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { Permission } from "@studafy/constants";

import "./import-data.css";

interface Step {
  key: "setup" | "students" | "teachers" | "slips";
  to: string;
  /** Hidden when the admin lacks this permission (the page behind it would refuse them). */
  permission?: Permission;
}

const STEPS: readonly Step[] = [
  { key: "setup", to: "/portal/principal/sections", permission: PERMISSIONS.TIMETABLE_MANAGE },
  { key: "students", to: "/portal/admin/students/import" },
  { key: "teachers", to: "/portal/admin/teachers" },
  { key: "slips", to: "/portal/admin/import/slips", permission: PERMISSIONS.USER_UPDATE },
];

/**
 * "Import data" (`/portal/admin/import`): the one place a school starts from to bring its people
 * onto Studafy, in the order that works -- grades and sections first (so students land in their
 * class), then students with their parents from the Excel template, then teachers, then printing
 * everyone's login slips. Each step is a card that links to the page that does it; past imports
 * sit in the header, out of the way of the steps.
 */
export default function ImportDataPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const permissions = usePermissions();
  const steps = STEPS.filter((step) => !step.permission || permissions.has(step.permission));

  return (
    <div className="import-data">
      <header className="import-data__header">
        <div className="import-data__heading">
          <h1>{t("adminPeople.importData.title")}</h1>
          <p className="import-data__intro">{t("adminPeople.importData.intro")}</p>
        </div>
        <Link className="import-data__button" to="/portal/admin/students/imports">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t("adminPeople.importData.history")}
        </Link>
      </header>

      <ol className="import-data__steps">
        {steps.map((step, index) => (
          <li key={step.key} className="import-data__step">
            <section className="import-data__card" aria-labelledby={`import-step-${step.key}`}>
              <span className="import-data__number" aria-hidden="true">
                {formatNumber(index + 1)}
              </span>
              <h2 id={`import-step-${step.key}`} className="import-data__step-title">
                {t(`adminPeople.importData.steps.${step.key}.title`)}
              </h2>
              <p className="import-data__step-body">
                {t(`adminPeople.importData.steps.${step.key}.body`)}
              </p>
              <Link className="import-data__step-link" to={step.to}>
                {t(`adminPeople.importData.steps.${step.key}.action`)}
                <span className="import-data__arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </section>
          </li>
        ))}
      </ol>
    </div>
  );
}
