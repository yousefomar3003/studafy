import { PERMISSIONS } from "@studafy/constants";
import { Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

import { AttendanceAlertsSection } from "./AttendanceAlertsSection";
import { ExamStructureSection } from "./ExamStructureSection";
import { GradingSchemeSection } from "./GradingSchemeSection";
import { LocaleTimezoneSection } from "./LocaleTimezoneSection";
import { ProfileSection } from "./ProfileSection";
import { fetchSchoolSettings, SCHOOL_SETTINGS_KEY } from "./queries";

import "./settings.css";

/**
 * Settings hub (`/portal/admin/settings`), gated by `organization:manageSettings` like the rest of
 * `/portal/admin`. Each section owns its own form and save action against
 * `GET/PATCH /api/schools/current/settings` — one query shared here, since every school-settings
 * section reads and writes the same row — except Profile, which is the signed-in admin's own
 * `PATCH /api/users/{userId}`.
 */
export default function SchoolSettingsPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const settingsQuery = useQuery({
    queryKey: SCHOOL_SETTINGS_KEY,
    queryFn: fetchSchoolSettings,
  });

  return (
    <>
      <h1>{t("adminSchool.settings.title")}</h1>
      <p>{t("adminSchool.settings.intro")}</p>

      {settingsQuery.isError ? (
        <p className="settings-page__error" role="alert">
          {t("adminSchool.settings.loadError")}
        </p>
      ) : null}

      <div className="settings-page__grid">
        <ProfileSection />
        <LocaleTimezoneSection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        <GradingSchemeSection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        <ExamStructureSection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        <AttendanceAlertsSection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        {permissions.has(PERMISSIONS.RECORD_TEMPLATE_MANAGE) ? (
          <Card as="section" aria-label={t("recordTemplates.links.templates")}>
            <Card.Header>
              <h2>{t("recordTemplates.links.templates")}</h2>
              <p className="settings-card__description">
                {t("recordTemplates.links.templatesDescription")}
              </p>
            </Card.Header>
            <Card.Body>
              <Link to="/portal/admin/settings/records">
                {t("recordTemplates.links.openEditor")}
              </Link>
            </Card.Body>
          </Card>
        ) : null}
      </div>
    </>
  );
}
