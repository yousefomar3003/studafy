import { useQuery } from "@tanstack/react-query";

import { useTranslation } from "../../../lib/i18n";
import { StorageUsageTile } from "../tiles/StorageUsageTile";

import { AttendanceAlertsSection } from "./AttendanceAlertsSection";
import { GradingSchemeSection } from "./GradingSchemeSection";
import { InvitationExpirySection } from "./InvitationExpirySection";
import { LocaleTimezoneSection } from "./LocaleTimezoneSection";
import { ProfileSection } from "./ProfileSection";
import { fetchSchoolSettings, SCHOOL_SETTINGS_KEY } from "./queries";

import "../admin-dashboard.css";
import "./settings.css";

/**
 * Settings hub (`/portal/admin/settings`), gated by `organization:manageSettings` like the rest of
 * `/portal/admin`. Each section owns its own form and save action against
 * `GET/PATCH /api/schools/current/settings` — one query shared here, since every school-settings
 * section reads and writes the same row — except Profile, which is the signed-in admin's own
 * `PATCH /api/users/{userId}`, and storage usage, which is read-only (reuses the dashboard's
 * `StorageUsageTile`, hence the `admin-dashboard.css` import for its meter styles).
 */
export default function SchoolSettingsPage() {
  const { t } = useTranslation();
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
        <InvitationExpirySection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        <AttendanceAlertsSection settings={settingsQuery.data} loading={settingsQuery.isPending} />
        <StorageUsageTile />
      </div>
    </>
  );
}
