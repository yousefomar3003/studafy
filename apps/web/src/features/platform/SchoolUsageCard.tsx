import { Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useSchoolUsageQuery } from "./school-admin";

import type { Formatters } from "../../lib/i18n";
import type { TFunction } from "i18next";

const ONE_DECIMAL = { maximumFractionDigits: 1 } as const;

/** Bytes as B/KB/MB/GB/TB, in the console's own units (1024-based, like the storage quota). */
export function formatStorage(
  bytes: number,
  t: TFunction,
  formatNumber: Formatters["formatNumber"],
): string {
  const units = [
    { unit: "tb", size: 1024 ** 4 },
    { unit: "gb", size: 1024 ** 3 },
    { unit: "mb", size: 1024 ** 2 },
    { unit: "kb", size: 1024 },
  ] as const;
  for (const { unit, size } of units) {
    if (bytes >= size) {
      return t(`platform.units.${unit}`, { value: formatNumber(bytes / size, ONE_DECIMAL) });
    }
  }
  return t("platform.units.b", { value: formatNumber(bytes) });
}

/** The roles shown first, in this order; any other role follows. */
const ROLE_ORDER = ["STUDENT", "INSTRUCTOR", "PARENT"];

/**
 * One school's usage (`GET /api/platform/schools/{schoolId}/usage`): accounts per role, open
 * invitations, storage against the cap, sign-in activity, AI use and the active licence's seats.
 */
export function SchoolUsageCard({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { data: usage, isPending, isError } = useSchoolUsageQuery(schoolId);

  const people = [...(usage?.people ?? [])].sort((a, b) => {
    const rank = (role: string) => {
      const index = ROLE_ORDER.indexOf(role);
      return index === -1 ? ROLE_ORDER.length : index;
    };
    return rank(a.role) - rank(b.role) || a.role.localeCompare(b.role);
  });

  return (
    <Card as="section" aria-labelledby="platform-usage-title">
      <Card.Header>
        <h2 id="platform-usage-title">{t("platform.school.usage.title")}</h2>
      </Card.Header>
      <Card.Body>
        {isPending ? (
          <p role="status">{t("site.common.loading")}</p>
        ) : isError || !usage ? (
          <p role="alert">{t("platform.school.usage.loadError")}</p>
        ) : (
          <div className="platform-usage">
            <section aria-labelledby="platform-usage-people">
              <h3 id="platform-usage-people">{t("platform.school.usage.people")}</h3>
              <table className="platform-usage-table">
                <thead>
                  <tr>
                    <th scope="col">{t("platform.school.usage.role")}</th>
                    <th scope="col">{t("platform.school.usage.active")}</th>
                    <th scope="col">{t("platform.school.usage.invited")}</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((row) => (
                    <tr key={row.role}>
                      <th scope="row">
                        {t(`platform.roles.${row.role}`, { defaultValue: row.role })}
                      </th>
                      <td>{formatNumber(row.active)}</td>
                      <td>{formatNumber(row.invited)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="platform-muted">
                {t("platform.school.usage.pendingInvitations", {
                  count: usage.pendingInvitations,
                })}
              </p>
            </section>

            <section aria-labelledby="platform-usage-storage">
              <h3 id="platform-usage-storage">{t("platform.school.usage.storage")}</h3>
              <p>
                {t("platform.school.usage.storageValue", {
                  used: formatStorage(usage.storage.bytesUsed, t, formatNumber),
                  cap: formatStorage(usage.storage.capBytes, t, formatNumber),
                })}
              </p>
              {usage.storage.fractionUsed !== null ? (
                <>
                  <meter
                    className="platform-usage-meter"
                    min={0}
                    max={1}
                    low={0.8}
                    high={0.95}
                    optimum={0}
                    value={Math.min(1, usage.storage.fractionUsed)}
                    aria-label={t("platform.school.usage.storage")}
                  />
                  <p className="platform-muted">
                    {t("platform.school.usage.storagePercent", {
                      percent: formatNumber(usage.storage.fractionUsed, {
                        style: "percent",
                        maximumFractionDigits: 1,
                      }),
                    })}
                  </p>
                </>
              ) : null}
            </section>

            <section aria-labelledby="platform-usage-activity">
              <h3 id="platform-usage-activity">{t("platform.school.usage.activity")}</h3>
              <dl className="platform-dl">
                <dt>{t("platform.school.usage.lastActivity")}</dt>
                <dd>
                  {usage.activity.lastActivityAt
                    ? formatDate(new Date(usage.activity.lastActivityAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : t("platform.common.never")}
                </dd>
                <dt>{t("platform.school.usage.activeLast30")}</dt>
                <dd>{formatNumber(usage.activity.activeUsersLast30Days)}</dd>
              </dl>
            </section>

            <section aria-labelledby="platform-usage-ai">
              <h3 id="platform-usage-ai">{t("platform.school.usage.ai")}</h3>
              <dl className="platform-dl">
                <dt>{t("platform.school.usage.aiSubscriptions")}</dt>
                <dd>{formatNumber(usage.ai.activeSubscriptions)}</dd>
                <dt>{t("platform.school.usage.aiTokens")}</dt>
                <dd>{formatNumber(usage.ai.tokensThisPeriod)}</dd>
              </dl>
              {usage.ai.featureUses.length > 0 ? (
                <ul className="platform-breakdown">
                  {usage.ai.featureUses.map((feature) => (
                    <li key={feature.featureKey}>
                      <code>{feature.featureKey}</code>
                      <strong>{formatNumber(feature.used)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="platform-muted">{t("platform.school.usage.noFeatureUse")}</p>
              )}
            </section>

            <section aria-labelledby="platform-usage-license">
              <h3 id="platform-usage-license">{t("platform.school.usage.license")}</h3>
              {usage.license ? (
                <>
                  <p className="platform-muted">
                    {t("platform.school.usage.licensePeriod", {
                      from: formatDate(new Date(usage.license.startsAt), { dateStyle: "medium" }),
                      to: formatDate(new Date(usage.license.endsAt), { dateStyle: "medium" }),
                    })}
                  </p>
                  <ul className="platform-breakdown">
                    {usage.license.seats.map((seat) => (
                      <li key={seat.audience}>
                        <span>{t(`platform.school.usage.audience.${seat.audience}`)}</span>
                        <strong>
                          {t("platform.school.usage.seatsValue", {
                            used: formatNumber(seat.used),
                            bought: formatNumber(seat.bought),
                          })}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="platform-muted">{t("platform.school.usage.noLicense")}</p>
              )}
            </section>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
