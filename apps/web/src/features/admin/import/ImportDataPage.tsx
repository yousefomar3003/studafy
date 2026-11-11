import { PERMISSIONS } from "@studafy/constants";
import { Card } from "@studafy/ui";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

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
 * everyone's login slips. Each step links to the page that does it.
 */
export default function ImportDataPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const steps = STEPS.filter((step) => !step.permission || permissions.has(step.permission));

  return (
    <>
      <h1>{t("adminPeople.importData.title")}</h1>
      <p>{t("adminPeople.importData.intro")}</p>

      <ol className="import-data__steps">
        {steps.map((step) => (
          <li key={step.key}>
            <Card as="section" aria-labelledby={`import-step-${step.key}`}>
              <Card.Body>
                <h2 id={`import-step-${step.key}`} className="import-data__step-title">
                  {t(`adminPeople.importData.steps.${step.key}.title`)}
                </h2>
                <p>{t(`adminPeople.importData.steps.${step.key}.body`)}</p>
                <Link className="import-data__step-link" to={step.to}>
                  {t(`adminPeople.importData.steps.${step.key}.action`)}
                </Link>
              </Card.Body>
            </Card>
          </li>
        ))}
      </ol>

      <p>
        <Link to="/portal/admin/students/imports">{t("adminPeople.importData.history")}</Link>
      </p>
    </>
  );
}
