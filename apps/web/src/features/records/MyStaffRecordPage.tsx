import { Link } from "react-router-dom";

import { useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { holdsStaffRole } from "./queries";
import { RecordsPanel } from "./RecordsPanel";

/**
 * "My staff record" (`/account/staff-record`): what the school keeps about the signed-in member of
 * staff, read-only (`GET /api/me/staff-record`). No permission beyond holding a staff role, the way
 * the rest of `/account` is the caller's own; the API answers 403 to anyone else and sends only
 * the fields that are not sensitive, so a salary or an ID number never reaches this page.
 */
export default function MyStaffRecordPage() {
  const { t } = useTranslation();
  const { roles, userId } = useAuth();

  return (
    <>
      <p>
        <Link to="/account">{t("records.self.backToAccount")}</Link>
      </p>
      <h1>{t("records.self.title")}</h1>
      <p>{t("records.self.intro")}</p>
      {holdsStaffRole(roles) && userId ? (
        <RecordsPanel
          subject={{ kind: "staff", id: userId, self: true }}
          canEdit={false}
          canRevealSensitive={false}
        />
      ) : (
        <p role="status">{t("records.self.notStaff")}</p>
      )}
    </>
  );
}
