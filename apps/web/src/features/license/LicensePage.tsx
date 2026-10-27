import { PERMISSIONS } from "@studafy/constants";
import { Button, Table } from "@studafy/ui";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { LicenseHeader, LicenseStatusPill, SeatMeter } from "./LicenseHeader";
import {
  AUDIENCES,
  useInvoicesQuery,
  useOfferedTiersQuery,
  useSchoolLicenseQuery,
} from "./queries";
import { RequestChangeModal } from "./RequestChangeModal";

import type { ChangeRequest, OfferedTier, SchoolLicense } from "./queries";
import type { TFunction } from "i18next";

import "./license.css";

/**
 * The school's license (`/portal/license`), gated by `license:read`: tier and seats per audience,
 * Family+, dates, status and the balance due; what students, teachers and parents get in their tier;
 * this month's usage per feature; and the school's open change requests. `license:manage` can ask
 * for more seats or a different tier (`?request=1` opens that form, as the "seats almost full"
 * banner does).
 */
export default function LicensePage() {
  const { t } = useTranslation();
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const overview = useSchoolLicenseQuery();
  const tiers = useOfferedTiersQuery();
  const [params, setParams] = useSearchParams();
  const [requesting, setRequesting] = useState(false);
  const formOpen = canManage && (requesting || params.get("request") === "1");
  const license = overview.data?.license ?? null;

  function closeForm() {
    setRequesting(false);
    if (params.has("request")) setParams({}, { replace: true });
  }

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.overview.title")}
        description={t("schoolLicense.overview.description")}
        actions={
          canManage ? (
            <Button variant="secondary" onClick={() => setRequesting(true)}>
              {t("schoolLicense.overview.requestChange")}
            </Button>
          ) : null
        }
      />
      {overview.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {overview.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {overview.data && !license ? (
        <p className="license-muted">{t("schoolLicense.overview.noLicense")}</p>
      ) : null}
      {license ? (
        <>
          <Facts license={license} />
          <AudienceTable license={license} tiers={tiers.data ?? []} />
          <UsageTable usage={overview.data!.usage} tiers={tiers.data ?? []} />
        </>
      ) : null}
      {overview.data ? <OpenRequests requests={overview.data.openChangeRequests} /> : null}
      <RequestChangeModal
        open={formOpen}
        license={license}
        tiers={tiers.data ?? []}
        onClose={closeForm}
      />
    </>
  );
}

function Facts({ license }: { license: SchoolLicense }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const money = useMoney();
  const unpaid = useInvoicesQuery("unpaid");
  const open = unpaid.data ?? [];
  const balance = open.reduce((sum, invoice) => sum + invoice.balanceMinor, 0);
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });

  return (
    <dl className="license-facts">
      <div>
        <dt>{t("schoolLicense.overview.status")}</dt>
        <dd>
          <LicenseStatusPill status={license.status} />
        </dd>
      </div>
      <div>
        <dt>{t("schoolLicense.overview.period")}</dt>
        <dd>
          {t("schoolLicense.overview.periodValue", {
            from: date(license.startsAt),
            to: date(license.endsAt),
          })}
        </dd>
      </div>
      <div>
        <dt>{t("schoolLicense.overview.familyPlus")}</dt>
        <dd>
          {license.includeFamilyPlus
            ? t("schoolLicense.overview.familyPlusIncluded")
            : t("schoolLicense.overview.familyPlusNotIncluded")}
        </dd>
      </div>
      <div>
        <dt>{t("schoolLicense.overview.balance")}</dt>
        <dd>
          {unpaid.isPending ? (
            "…"
          ) : balance > 0 ? (
            <Link to="/portal/license/invoices">
              {money(balance, open[0]!.currencyCode, open[0]!.minorUnit)}
            </Link>
          ) : (
            t("schoolLicense.overview.nothingDue")
          )}
        </dd>
      </div>
    </dl>
  );
}

/** "300 messages a month", "Unlimited", or "Included" for a feature with nothing to count. */
export function limitText(
  feature: OfferedTier["features"][number],
  t: TFunction,
  formatNumber: (value: number) => string,
): string {
  if (feature.unit === null) return t("schoolLicense.tiers.included");
  if (feature.monthlyLimit === null) return t("schoolLicense.tiers.unlimited");
  return t("schoolLicense.tiers.perMonth", {
    limit: formatNumber(feature.monthlyLimit),
    unit: t(`schoolLicense.unit.${feature.unit}`),
  });
}

function AudienceTable({ license, tiers }: { license: SchoolLicense; tiers: OfferedTier[] }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const rows = AUDIENCES.filter((a) => a !== "parent" || license.includeFamilyPlus).map(
    (audience) => license.audiences.find((row) => row.audience === audience)!,
  );

  return (
    <section className="license-section" aria-labelledby="license-audiences">
      <div className="license-section__head">
        <h2 id="license-audiences">{t("schoolLicense.overview.audiencesTitle")}</h2>
        <Link to="/portal/license/seats">{t("schoolLicense.overview.manageSeats")}</Link>
      </div>
      <Table caption={t("schoolLicense.overview.audiencesTitle")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.audience")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.tier")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.seats")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.gets")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={4}>
          {rows.map((row) => {
            const tier = tiers.find((candidate) => candidate.id === row.tier?.id);
            return (
              <Table.Row key={row.audience}>
                <Table.Cell>{t(`schoolLicense.audience.${row.audience}`)}</Table.Cell>
                <Table.Cell>
                  {row.tier?.displayName ?? t("schoolLicense.overview.noTier")}
                </Table.Cell>
                <Table.Cell>
                  {t("schoolLicense.overview.seatsUsed", {
                    assigned: formatNumber(row.assigned),
                    purchased: formatNumber(row.purchased),
                  })}
                  <SeatMeter assigned={row.assigned} purchased={row.purchased} />
                </Table.Cell>
                <Table.Cell>
                  {tier && tier.features.length > 0 ? (
                    <ul
                      className="license-features"
                      aria-label={t("schoolLicense.overview.getsLabel", {
                        audience: t(`schoolLicense.audience.${row.audience}`),
                      })}
                    >
                      {tier.features.map((feature) => (
                        <li key={feature.key}>
                          {feature.name}: {limitText(feature, t, formatNumber)}
                          {feature.status === "paused"
                            ? ` (${t("schoolLicense.tiers.paused")})`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="license-muted">—</span>
                  )}
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </section>
  );
}

function UsageTable({
  usage,
  tiers,
}: {
  usage: readonly { feature: string; unit: string | null; used: number }[];
  tiers: OfferedTier[];
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const names = new Map<string, string>(
    tiers.flatMap((tier) => tier.features.map((f) => [f.key, f.name] as const)),
  );
  const metered = usage.filter((row) => row.unit !== null);

  return (
    <section className="license-section" aria-labelledby="license-usage">
      <h2 id="license-usage">{t("schoolLicense.overview.usageTitle")}</h2>
      <p className="license-muted">{t("schoolLicense.overview.usageHelp")}</p>
      <Table caption={t("schoolLicense.overview.usageTitle")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.feature")}</Table.HeaderCell>
            <Table.HeaderCell>{t("schoolLicense.overview.columns.used")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={2} empty={t("schoolLicense.overview.noUsage")}>
          {metered.map((row) => (
            <Table.Row key={row.feature}>
              <Table.Cell>{names.get(row.feature) ?? row.feature}</Table.Cell>
              <Table.Cell>
                {t("schoolLicense.overview.usedValue", {
                  used: formatNumber(row.used),
                  unit: t(`schoolLicense.unit.${row.unit}`),
                })}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </section>
  );
}

/** What a request asked for, in words: "40 student seats · Student Pro for students · Family+ on". */
export function requestSummary(request: ChangeRequest, t: TFunction): string {
  const parts: string[] = [];
  for (const audience of AUDIENCES) {
    const seats = request[`${audience}Seats`];
    const tier = request[`${audience}Tier`];
    if (seats !== null) parts.push(t(`schoolLicense.requests.seats.${audience}`, { count: seats }));
    if (tier) {
      parts.push(
        t("schoolLicense.requests.tier", {
          tier: tier.displayName,
          audience: t(`schoolLicense.audience.${audience}`),
        }),
      );
    }
  }
  if (request.includeFamilyPlus !== null) {
    parts.push(
      t(
        request.includeFamilyPlus
          ? "schoolLicense.requests.familyPlusOn"
          : "schoolLicense.requests.familyPlusOff",
      ),
    );
  }
  return parts.join(" · ");
}

function OpenRequests({ requests }: { requests: readonly ChangeRequest[] }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  if (requests.length === 0) return null;
  return (
    <section className="license-section" aria-labelledby="license-requests">
      <h2 id="license-requests">{t("schoolLicense.requests.title")}</h2>
      <p className="license-muted">{t("schoolLicense.requests.help")}</p>
      <ul className="license-list">
        {requests.map((request) => (
          <li key={request.id}>
            {requestSummary(request, t)}{" "}
            <span className="license-muted">
              ({formatDate(new Date(request.createdAt), { dateStyle: "medium" })}): “{request.note}”
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
