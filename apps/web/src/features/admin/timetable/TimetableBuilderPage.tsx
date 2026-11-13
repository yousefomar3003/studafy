import { PERMISSIONS } from "@studafy/constants";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { helpPath } from "../../help/content";
import { HelpLink } from "../../help/HelpLink";

import { TimetableWorkspace } from "./TimetableWorkspace";

/**
 * Timetable (`/portal/admin/timetable`), behind `organization:manageSettings` like the rest of
 * `/portal/admin`. The screen itself is the shared `TimetableWorkspace`; editing is gated on
 * `timetable:manage`, the same permission the API enforces on every timetable write.
 */
export default function TimetableBuilderPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();

  return (
    <TimetableWorkspace
      title={t("adminSchool.timetable.title")}
      intro={t("adminSchool.timetable.intro")}
      canManage={permissions.has(PERMISSIONS.TIMETABLE_MANAGE)}
      aside={
        <p>
          <HelpLink to={helpPath("timetable")}>{t("adminSchool.timetable.guide")}</HelpLink>
        </p>
      }
    />
  );
}
