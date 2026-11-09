import { useFormatters, useTranslation } from "../../../lib/i18n";

import type { SetupCode } from "./mutations";

export interface SetupCodeDetailsProps {
  usernames: string[];
  /** Null when no code could be issued; the admin is pointed at "Reset password". */
  setup: SetupCode | null;
}

/**
 * What an administrator hands a member: the ID they sign in with and their one-time setup code
 * (QA-11). The API returns the code once, so this is the only time it can be shown.
 */
export function SetupCodeDetails({ usernames, setup }: SetupCodeDetailsProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();

  return (
    <>
      <dl className="members-credentials">
        <dt>{t("adminPeople.members.username")}</dt>
        <dd>
          <code>{usernames.join(", ")}</code>
        </dd>
        {setup ? (
          <>
            <dt>{t("adminPeople.members.setupCode")}</dt>
            <dd>
              <code>{setup.setupCode}</code>
            </dd>
            <dt>{t("adminPeople.members.setupCodeExpires")}</dt>
            <dd>{formatDate(new Date(setup.expiresAt), { dateStyle: "long" })}</dd>
          </>
        ) : null}
      </dl>
      <p>
        {setup ? t("adminPeople.members.setupCodeNote") : t("adminPeople.members.setupCodeMissing")}
      </p>
    </>
  );
}
