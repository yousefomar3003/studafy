import { PERMISSIONS } from "@studafy/constants";

import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";
import { TimetableWorkspace } from "../../admin/timetable/TimetableWorkspace";

/**
 * Timetable (`/portal/principal/timetable`): the same screen as the admin console's, via the shared
 * `TimetableWorkspace`. A principal holds `timetable:manage`, so they edit, publish, and set the
 * school week here directly; leadership roles without it get the read-only view.
 */
export default function PrincipalTimetablePage() {
  const { t } = useTranslation();
  const permissions = usePermissions();

  return (
    <TimetableWorkspace
      title={t("principal.timetable.title")}
      intro={t("principal.timetable.description")}
      canManage={permissions.has(PERMISSIONS.TIMETABLE_MANAGE)}
    />
  );
}
