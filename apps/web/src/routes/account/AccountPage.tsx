import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

/** Account settings page (`/account`) — the hub for the settings routes under it. */
export default function AccountPage() {
  const { t } = useTranslation();

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
        <li>
          <Link to="/account/delete" className="link-tiles__item">
            {t("onboarding.account.deleteLink")}
          </Link>
        </li>
      </ul>
    </>
  );
}
