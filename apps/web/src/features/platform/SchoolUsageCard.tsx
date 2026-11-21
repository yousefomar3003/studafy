import { Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useSchoolUsageQuery } from "./school-admin";

import type { Formatters } from "../../lib/i18n";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";

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

/** A thin usage bar; its numbers are always written beside it, so it is decorative. */
function UsageBar({ fraction }: { fraction: number }) {
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <span className="platform-usage-bar" aria-hidden="true">
      <span
        className="platform-usage-bar__fill"
        data-tone={clamped >= 0.95 ? "danger" : clamped >= 0.8 ? "warning" : undefined}
        style={{ inlineSize: `${clamped * 100}%` }}
      />
    </span>
  );
}

function UsageStat({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="platform-usage-stat">
      <dt className="platform-usage-stat__label">{label}</dt>
      <dd className="platform-usage-stat__value">{value}</dd>
      {children ? <dd className="platform-usage-stat__extra">{children}</dd> : null}
      {hint ? <dd className="platform-usage-stat__hint">{hint}</dd> : null}
    </div>
  );
}

/**
 * One school's usage (`GET /api/platform/schools/{schoolId}/usage`): the headline figures in a row
 * of tiles (accounts, storage against the cap, sign-in activity, Student AI), then the accounts by
 * role beside the active licence's seats and this month's feature use.
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
  const activeTotal = people.reduce((sum, row) => sum + row.active, 0);
  const invitedTotal = people.reduce((sum, row) => sum + row.invited, 0);

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
          <>
            <dl className="platform-usage-stats">
              <UsageStat
                label={t("platform.school.usage.accountsTotal")}
                value={formatNumber(activeTotal)}
                hint={[
                  t("platform.school.usage.invitedCount", { count: invitedTotal }),
                  t("platform.school.usage.pendingInvitations", {
                    count: usage.pendingInvitations,
                  }),
                ].join(" · ")}
              />
              <UsageStat
                label={t("platform.school.usage.storage")}
                value={formatStorage(usage.storage.bytesUsed, t, formatNumber)}
                hint={
                  usage.storage.fractionUsed !== null
                    ? t("platform.school.usage.storageCap", {
                        cap: formatStorage(usage.storage.capBytes, t, formatNumber),
                        percent: formatNumber(usage.storage.fractionUsed, {
                          style: "percent",
                          maximumFractionDigits: 1,
                        }),
                      })
                    : undefined
                }
              >
                {usage.storage.fractionUsed !== null ? (
                  <UsageBar fraction={usage.storage.fractionUsed} />
                ) : null}
              </UsageStat>
              <UsageStat
                label={t("platform.school.usage.lastActivity")}
                value={
                  usage.activity.lastActivityAt
                    ? formatDate(new Date(usage.activity.lastActivityAt), { dateStyle: "medium" })
                    : t("platform.common.never")
                }
                hint={t("platform.school.usage.activeLast30Count", {
                  count: usage.activity.activeUsersLast30Days,
                })}
              />
              <UsageStat
                label={t("platform.school.usage.aiTile")}
                value={formatNumber(usage.ai.activeSubscriptions)}
                hint={t("platform.school.usage.aiTileHint", {
                  tokens: formatNumber(usage.ai.tokensThisPeriod),
                })}
              />
            </dl>

            <div className="platform-usage-details">
              <section aria-labelledby="platform-usage-people">
                <h3 id="platform-usage-people">{t("platform.school.usage.peopleByRole")}</h3>
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
                        <td data-zero={row.invited === 0 || undefined}>
                          {formatNumber(row.invited)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <div className="platform-usage-side">
                <section aria-labelledby="platform-usage-license">
                  <h3 id="platform-usage-license">{t("platform.school.usage.license")}</h3>
                  {usage.license ? (
                    <>
                      <p className="platform-muted">
                        {t("platform.school.usage.licensePeriod", {
                          from: formatDate(new Date(usage.license.startsAt), {
                            dateStyle: "medium",
                          }),
                          to: formatDate(new Date(usage.license.endsAt), { dateStyle: "medium" }),
                        })}
                      </p>
                      <ul className="platform-usage-seats">
                        {usage.license.seats.map((seat) => (
                          <li key={seat.audience}>
                            <span className="platform-usage-seats__row">
                              <span>{t(`platform.school.usage.audience.${seat.audience}`)}</span>
                              <strong>
                                {t("platform.school.usage.seatsValue", {
                                  used: formatNumber(seat.used),
                                  bought: formatNumber(seat.bought),
                                })}
                              </strong>
                            </span>
                            <UsageBar fraction={seat.bought > 0 ? seat.used / seat.bought : 0} />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="platform-muted">{t("platform.school.usage.noLicense")}</p>
                  )}
                </section>

                <section aria-labelledby="platform-usage-features">
                  <h3 id="platform-usage-features">{t("platform.school.usage.featureUse")}</h3>
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
              </div>
            </div>
          </>
        )}
      </Card.Body>
    </Card>
  );
}
