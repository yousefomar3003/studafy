import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { AUDIENCES } from "./constants";
import { currencyMinorUnit, fromMinor, toMinor, useMoney } from "./format";
import { useSaveTier } from "./mutations";
import { useConsoleFeaturesQuery, useTiersQuery } from "./queries";

import "../platform.css";
import "./licensing.css";

import type { TierBody } from "./mutations";
import type { ConsoleFeature, ConsoleTier, LicenseAudience } from "./queries";

/**
 * Feature tiers per audience (`/portal/platform/tiers`): what each tier includes, at what monthly
 * limit, at what price per seat per month in each currency, side by side. A sibling of the plans
 * page: plans are what a school pays for Studafy itself; tiers are what licenses and personal
 * purchases sell.
 */
export default function TiersPage() {
  const { t } = useTranslation();
  const tiers = useTiersQuery();
  const features = useConsoleFeaturesQuery();
  const [editing, setEditing] = useState<ConsoleTier | { audience: LicenseAudience } | null>(null);

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.tiers.title")}
        description={t("platformLicensing.tiers.description")}
      />
      {tiers.isPending || features.isPending ? (
        <p role="status">{t("site.common.loading")}</p>
      ) : null}
      {tiers.isError || features.isError ? (
        <p role="alert">{t("platformLicensing.common.loadError")}</p>
      ) : null}
      {tiers.data && features.data ? (
        <div className="platform-stack">
          {AUDIENCES.map((audience) => (
            <AudienceTiers
              key={audience}
              audience={audience}
              tiers={tiers.data.filter((tier) => tier.audience === audience)}
              features={features.data.filter((feature) => feature.audience === audience)}
              onEdit={setEditing}
              onCreate={() => setEditing({ audience })}
            />
          ))}
        </div>
      ) : null}
      <TierModal target={editing} features={features.data ?? []} onClose={() => setEditing(null)} />
    </>
  );
}

function limitLabel(
  tier: ConsoleTier,
  feature: ConsoleFeature,
  t: ReturnType<typeof useTranslation>["t"],
  formatNumber: (n: number) => string,
): string {
  const row = tier.features.find((f) => f.key === feature.key);
  if (!row && !tier.includesAllFeatures) return t("platformLicensing.tiers.notIncluded");
  const limit = row ? row.monthlyLimit : feature.defaultMonthlyLimit;
  if (limit === null || feature.unit === null) return t("platformLicensing.common.unlimited");
  return t("platformLicensing.tiers.limitPerMonth", {
    limit: formatNumber(limit),
    unit: t(`platformLicensing.unit.${feature.unit}`),
  });
}

/** One audience's tiers as a comparison table: features down, tiers across. */
function AudienceTiers({
  audience,
  tiers,
  features,
  onEdit,
  onCreate,
}: {
  audience: LicenseAudience;
  tiers: ConsoleTier[];
  features: ConsoleFeature[];
  onEdit: (tier: ConsoleTier) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const money = useMoney();
  const active = tiers.filter((tier) => tier.isActive).sort((a, b) => a.rank - b.rank);
  const retired = tiers.filter((tier) => !tier.isActive);
  const columns = [...active, ...retired];
  const currencies = [
    ...new Set(columns.flatMap((tier) => tier.prices.map((p) => p.currencyCode))),
  ].sort();
  const headingId = `tiers-${audience}`;

  return (
    <Card as="section" aria-labelledby={headingId}>
      <Card.Header>
        <div className="platform-header__row">
          <h2 id={headingId}>{t(`platformLicensing.tiers.audienceTitle.${audience}`)}</h2>
          <Button variant="secondary" onClick={onCreate}>
            {t(`platformLicensing.tiers.create.${audience}`)}
          </Button>
        </div>
      </Card.Header>
      <Card.Body>
        {columns.length === 0 ? (
          <p className="platform-muted">{t("platformLicensing.tiers.empty")}</p>
        ) : (
          <table className="platform-table licensing-compare">
            <caption className="sf-visually-hidden">
              {t("platformLicensing.tiers.compareCaption", {
                audience: t(`platformLicensing.audience.${audience}`),
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("platformLicensing.tiers.columns.feature")}</th>
                {columns.map((tier) => (
                  <th scope="col" key={tier.id}>
                    <div className="platform-cell-stack">
                      <span>{tier.displayName}</span>
                      <span className="platform-muted">
                        {tier.isActive
                          ? t("platformLicensing.tiers.rank", { rank: tier.rank })
                          : t("platformLicensing.tiers.retired")}
                      </span>
                      <Button
                        variant="tertiary"
                        onClick={() => onEdit(tier)}
                        aria-label={t("platformLicensing.tiers.editNamed", {
                          name: tier.displayName,
                        })}
                      >
                        {t("platformLicensing.common.edit")}
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr key={feature.key}>
                  <th scope="row">{feature.displayName}</th>
                  {columns.map((tier) => (
                    <td key={tier.id}>{limitLabel(tier, feature, t, formatNumber)}</td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row">{t("platformLicensing.tiers.includesAll")}</th>
                {columns.map((tier) => (
                  <td key={tier.id}>
                    {tier.includesAllFeatures
                      ? t("platform.common.yes")
                      : t("platformLicensing.common.no")}
                  </td>
                ))}
              </tr>
              {currencies.map((currency) => (
                <tr key={currency}>
                  <th scope="row">{t("platformLicensing.tiers.pricePerSeat", { currency })}</th>
                  {columns.map((tier) => {
                    const price = tier.prices.find(
                      (p) => p.currencyCode === currency && p.isActive,
                    );
                    return (
                      <td key={tier.id}>
                        {price ? money(price.amountMinor, currency, price.minorUnit) : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <th scope="row">{t("platformLicensing.tiers.inUse")}</th>
                {columns.map((tier) => (
                  <td key={tier.id}>{formatNumber(tier.inUse)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        )}
      </Card.Body>
    </Card>
  );
}

interface PriceRow {
  currencyCode: string;
  amount: string;
}

/** Create a tier (target has only an audience) or replace one (target is the tier). */
function TierModal({
  target,
  features,
  onClose,
}: {
  target: ConsoleTier | { audience: LicenseAudience } | null;
  features: ConsoleFeature[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveTier();
  const existing = target && "id" in target ? target : null;
  const audience = target?.audience ?? "student";
  const audienceFeatures = features.filter((f) => f.audience === audience);

  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [rank, setRank] = useState("1");
  const [includesAll, setIncludesAll] = useState(false);
  const [active, setActive] = useState(true);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [prices, setPrices] = useState<PriceRow[]>([]);

  const seedKey = target ? (existing?.id ?? `new:${audience}`) : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    setCode("");
    setName(existing?.displayName ?? "");
    setRank(String(existing?.rank ?? 1));
    setIncludesAll(existing?.includesAllFeatures ?? false);
    setActive(existing?.isActive ?? true);
    setIncluded(Object.fromEntries((existing?.features ?? []).map((f) => [f.key, true])));
    setLimits(
      Object.fromEntries(
        (existing?.features ?? []).map((f) => [
          f.key,
          f.monthlyLimit === null ? "" : String(f.monthlyLimit),
        ]),
      ),
    );
    setPrices(
      (existing?.prices ?? [])
        .filter((p) => p.isActive)
        .map((p) => ({
          currencyCode: p.currencyCode,
          amount: fromMinor(p.amountMinor, p.minorUnit),
        })),
    );
  }

  const rankNumber = Number(rank);
  // The tier's own price row knows the currency's decimals; a newly added currency uses ISO 4217.
  const minorUnitOf = (code: string) =>
    existing?.prices.find((p) => p.currencyCode === code)?.minorUnit ?? currencyMinorUnit(code);
  const priceErrors = prices.map(
    (row) =>
      !/^[A-Z]{3}$/.test(row.currencyCode) ||
      toMinor(row.amount, minorUnitOf(row.currencyCode)) === null,
  );
  const limitErrors = audienceFeatures.map((f) => {
    const value = limits[f.key] ?? "";
    return included[f.key] === true && value !== "" && !/^[1-9]\d*$/.test(value);
  });
  const valid =
    name.trim() !== "" &&
    Number.isInteger(rankNumber) &&
    rankNumber >= 1 &&
    (existing !== null || /^[a-z][a-z0-9_]{1,49}$/.test(code)) &&
    !priceErrors.some(Boolean) &&
    !limitErrors.some(Boolean);

  function close() {
    setSeededFor(null);
    onClose();
  }

  function submit() {
    if (!target || !valid) return;
    const body: TierBody = {
      displayName: name.trim(),
      rank: rankNumber,
      includesAllFeatures: includesAll,
      isActive: active,
      features: audienceFeatures
        .filter((f) => included[f.key])
        .map((f) => ({
          key: f.key,
          monthlyLimit: (limits[f.key] ?? "") === "" ? null : Number(limits[f.key]),
        })),
      prices: prices.map((row) => ({
        currencyCode: row.currencyCode,
        amountMinor: toMinor(row.amount, minorUnitOf(row.currencyCode))!,
      })),
    };
    save.mutate(
      existing
        ? { planId: existing.id, body }
        : { planId: null, body: { ...body, code, audience } },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platformLicensing.common.saved") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={target !== null}
      onClose={close}
      title={
        existing
          ? t("platformLicensing.tiers.editTitle", { name: existing.displayName })
          : t(`platformLicensing.tiers.create.${audience}`)
      }
      description={existing?.code}
    >
      <Modal.Body>
        <div className="licensing-form-grid">
          {existing ? null : (
            <Input
              label={t("platformLicensing.tiers.codeLabel")}
              helperText={t("platformLicensing.tiers.codeHelp")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          )}
          <Input
            label={t("platformLicensing.tiers.nameLabel")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <Input
            label={t("platformLicensing.tiers.rankLabel")}
            helperText={t("platformLicensing.tiers.rankHelp")}
            type="number"
            min={1}
            value={rank}
            onChange={(event) => setRank(event.target.value)}
          />
        </div>
        <Checkbox
          label={t("platformLicensing.tiers.includesAllLabel")}
          checked={includesAll}
          onChange={(event) => setIncludesAll(event.target.checked)}
        />
        {existing ? (
          <Checkbox
            label={t("platformLicensing.tiers.activeLabel")}
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
        ) : null}

        <h3>{t("platformLicensing.tiers.featuresHeading")}</h3>
        <div className="licensing-row-list">
          {audienceFeatures.map((feature, index) => (
            <div className="licensing-row" key={feature.key}>
              <Checkbox
                label={feature.displayName}
                checked={included[feature.key] === true}
                onChange={(event) =>
                  setIncluded((prev) => ({ ...prev, [feature.key]: event.target.checked }))
                }
              />
              {feature.unit ? (
                <Input
                  label={t("platformLicensing.tiers.limitLabel", {
                    unit: t(`platformLicensing.unit.${feature.unit}`),
                  })}
                  helperText={t("platformLicensing.tiers.limitHelp")}
                  value={limits[feature.key] ?? ""}
                  disabled={included[feature.key] !== true}
                  error={limitErrors[index] ? t("platformLicensing.tiers.limitError") : undefined}
                  onChange={(event) =>
                    setLimits((prev) => ({ ...prev, [feature.key]: event.target.value }))
                  }
                />
              ) : null}
            </div>
          ))}
        </div>

        <h3>{t("platformLicensing.tiers.pricesHeading")}</h3>
        <div className="licensing-row-list">
          {prices.map((row, index) => (
            <div className="licensing-row" key={index}>
              <Input
                label={t("platformLicensing.tiers.currencyLabel")}
                value={row.currencyCode}
                maxLength={3}
                onChange={(event) =>
                  setPrices((prev) =>
                    prev.map((p, i) =>
                      i === index ? { ...p, currencyCode: event.target.value.toUpperCase() } : p,
                    ),
                  )
                }
              />
              <Input
                label={t("platformLicensing.tiers.amountLabel")}
                value={row.amount}
                inputMode="decimal"
                error={priceErrors[index] ? t("platformLicensing.tiers.priceError") : undefined}
                onChange={(event) =>
                  setPrices((prev) =>
                    prev.map((p, i) => (i === index ? { ...p, amount: event.target.value } : p)),
                  )
                }
              />
              <Button
                variant="tertiary"
                onClick={() => setPrices((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("platformLicensing.common.remove")}
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              onClick={() => setPrices((prev) => [...prev, { currencyCode: "", amount: "" }])}
            >
              {t("platformLicensing.tiers.addPrice")}
            </Button>
          </div>
        </div>
        {existing && existing.inUse > 0 ? (
          <p className="platform-muted">
            {t("platformLicensing.tiers.inUseWarning", { count: existing.inUse })}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!valid}
          loading={save.isPending}
          onClick={submit}
        >
          {t("platform.common.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
