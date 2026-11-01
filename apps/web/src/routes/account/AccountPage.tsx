import { Link } from "react-router-dom";

import { holdsStaffRole } from "../../features/records/queries";
import { useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

/** Account settings page (`/account`) — the hub for the settings routes under it. */
export default function AccountPage() {
  const { t } = useTranslation();
  const { roles } = useAuth();

  return (
    <>
      <h1>{t("onboarding.account.title")}</h1>
      <p>{t("onboarding.account.description")}</p>
      <ul className="link-tiles">
        <li>
          <Link to="/account/sessions" className="link-tiles__item">
            {t("onboarding.account.sessionsLink")}
          </Link>
        </li>
        {holdsStaffRole(roles) ? (
          <li>
            <Link to="/account/staff-record" className="link-tiles__item">
              {t("onboarding.account.staffRecordLink")}
            </Link>
          </li>
        ) : null}
        <li>
          <Link to="/account/delete" className="link-tiles__item">
            {t("onboarding.account.deleteLink")}
          </Link>
        </li>
      </ul>
    </>
  );
}
