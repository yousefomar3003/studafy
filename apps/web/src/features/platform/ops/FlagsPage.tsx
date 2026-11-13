import { Link } from "react-router-dom";

import { useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader, SchoolStatusPill } from "../PlatformNav";

import { useFlagsOverviewQuery } from "./queries";

import "../platform.css";
import "./ops.css";

/**
 * Every feature flag across every school (`/portal/platform/flags`): the deployment default and the
 * schools that override it. Read-only by design -- the default is an env setting, and a school's
 * override is changed on that school's page, so there is no fleet-wide switch to flip here.
 */
export default function FlagsPage() {
  const { t } = useTranslation();
  const { data, isPending, isError } = useFlagsOverviewQuery();
  const onOff = (value: boolean) => (value ? t("platform.common.on") : t("platform.common.off"));

  return (
    <>
      <PlatformPageHeader
        title={t("platform.flags.title")}
        description={t("platform.flags.description")}
      />
      {isPending ? <p className="platform-muted">{t("platform.flags.loading")}</p> : null}
      {isError ? <p role="alert">{t("platform.flags.loadError")}</p> : null}
      <div className="platform-ops-sections">
        {(data ?? []).map((flag) => (
          <section
            key={flag.name}
            aria-labelledby={`flag-${flag.name}`}
            className="platform-ops-flag"
          >
            <h2 id={`flag-${flag.name}`}>
              <code>{flag.name}</code>
            </h2>
            <p>{flag.description}</p>
            <ul className="platform-ops-stats">
              <li>
                {t("platform.flags.deploymentDefault")}: {onOff(flag.deploymentDefault)}
                {flag.deploymentDefault !== flag.registryDefault
                  ? ` (${t("platform.flags.registryDefault")}: ${onOff(flag.registryDefault)})`
                  : ""}
              </li>
              <li>
                {t("platform.flags.enabledIn", {
                  count: flag.enabledSchools,
                  total: flag.totalSchools,
                })}
              </li>
            </ul>
            {flag.overrides.length === 0 ? (
              <p className="platform-muted">{t("platform.flags.noOverrides")}</p>
            ) : (
              <table className="platform-ops-table">
                <caption>{t("platform.flags.overridesCaption", { name: flag.name })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("platform.flags.school")}</th>
                    <th scope="col">{t("platform.flags.override")}</th>
                  </tr>
                </thead>
                <tbody>
                  {flag.overrides.map((override) => (
                    <tr key={override.schoolId}>
                      <td>
                        <Link to={`/portal/platform/schools/${override.schoolId}`}>
                          {override.schoolName}
                        </Link>{" "}
                        <SchoolStatusPill status={override.schoolStatus} />
                      </td>
                      <td>{onOff(override.enabled)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
      <p className="platform-muted">{t("platform.flags.howToChange")}</p>
    </>
  );
}
