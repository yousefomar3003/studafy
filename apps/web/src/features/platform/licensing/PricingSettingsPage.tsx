import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { PlatformPageHeader } from "../PlatformNav";

import { AUDIENCES } from "./constants";
import { bpsToPercent, percentToBps } from "./format";
import { useSaveBankDetails, useSavePriceSettings } from "./mutations";
import { useBankDetailsQuery, usePriceSettingsQuery } from "./queries";

import "../platform.css";
import "./licensing.css";

import type { LicenseAudience, PriceSettings } from "./queries";

type VolumeBasis = PriceSettings["volumeBasis"];

interface VolumeRow {
  audience: LicenseAudience | "all";
  minSeats: string;
  percent: string;
}

interface DurationRow {
  minMonths: string;
  percent: string;
}

/**
 * License pricing (`/portal/platform/pricing`): per currency, volume discount brackets (by seats,
 * per audience or across the license) and duration discounts; and the bank details printed on every
 * invoice. The calculator prices with whatever is saved here.
 */
export default function PricingSettingsPage() {
  const { t } = useTranslation();
  const settings = usePriceSettingsQuery();
  const [added, setAdded] = useState<string[]>([]);
  const [newCurrency, setNewCurrency] = useState("");

  const saved = settings.data ?? [];
  const currencies = [
    ...saved.map((s) => s.currencyCode),
    ...added.filter((code) => !saved.some((s) => s.currencyCode === code)),
  ];

  return (
    <>
      <PlatformPageHeader
        title={t("platformLicensing.pricing.title")}
        description={t("platformLicensing.pricing.description")}
      />
      {settings.isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {settings.isError ? <p role="alert">{t("platformLicensing.common.loadError")}</p> : null}
      <div className="platform-stack">
        {currencies.map((code) => (
          <CurrencySettings
            key={code}
            currencyCode={code}
            saved={saved.find((s) => s.currencyCode === code) ?? null}
          />
        ))}
        <div className="platform-toolbar licensing-row">
          <Input
            label={t("platformLicensing.pricing.addCurrencyLabel")}
            value={newCurrency}
            maxLength={3}
            onChange={(event) => setNewCurrency(event.target.value.toUpperCase())}
          />
          <Button
            variant="secondary"
            disabled={!/^[A-Z]{3}$/.test(newCurrency) || currencies.includes(newCurrency)}
            onClick={() => {
              setAdded((prev) => [...prev, newCurrency]);
              setNewCurrency("");
            }}
          >
            {t("platformLicensing.pricing.addCurrency")}
          </Button>
        </div>
        <BankDetailsCard />
      </div>
    </>
  );
}

function CurrencySettings({
  currencyCode,
  saved,
}: {
  currencyCode: string;
  saved: PriceSettings | null;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSavePriceSettings();
  const [basis, setBasis] = useState<VolumeBasis>(saved?.volumeBasis ?? "per_audience");
  const [volume, setVolume] = useState<VolumeRow[]>(
    (saved?.volumeBrackets ?? []).map((b) => ({
      audience: b.audience ?? "all",
      minSeats: String(b.minSeats),
      percent: bpsToPercent(b.discountBps).replace("%", ""),
    })),
  );
  const [duration, setDuration] = useState<DurationRow[]>(
    (saved?.durationDiscounts ?? []).map((d) => ({
      minMonths: String(d.minMonths),
      percent: bpsToPercent(d.discountBps).replace("%", ""),
    })),
  );

  const volumeInvalid = volume.map(
    (row) => !/^[1-9]\d*$/.test(row.minSeats) || percentToBps(row.percent) === null,
  );
  const durationInvalid = duration.map(
    (row) =>
      !/^[1-9]\d*$/.test(row.minMonths) ||
      Number(row.minMonths) > 120 ||
      percentToBps(row.percent) === null,
  );
  const valid = !volumeInvalid.some(Boolean) && !durationInvalid.some(Boolean);
  const headingId = `pricing-${currencyCode}`;

  function submit() {
    if (!valid) return;
    save.mutate(
      {
        currencyCode,
        body: {
          volumeBasis: basis,
          volumeBrackets: volume.map((row) => ({
            audience: row.audience === "all" ? null : row.audience,
            minSeats: Number(row.minSeats),
            discountBps: percentToBps(row.percent)!,
          })),
          durationDiscounts: duration.map((row) => ({
            minMonths: Number(row.minMonths),
            discountBps: percentToBps(row.percent)!,
          })),
        },
      },
      {
        onSuccess: () => show({ variant: "success", title: t("platformLicensing.common.saved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("platformLicensing.common.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  const audienceOptions = [
    { value: "all" as const, label: t("platformLicensing.pricing.allAudiences") },
    ...AUDIENCES.map((audience) => ({
      value: audience,
      label: t(`platformLicensing.audience.${audience}`),
    })),
  ];

  return (
    <Card as="section" aria-labelledby={headingId}>
      <Card.Header>
        <h2 id={headingId}>
          {t("platformLicensing.pricing.currencyTitle", { currency: currencyCode })}
        </h2>
      </Card.Header>
      <Card.Body>
        <Select
          label={t("platformLicensing.pricing.basisLabel")}
          value={basis}
          onChange={setBasis}
          options={[
            { value: "per_audience", label: t("platformLicensing.pricing.basis.per_audience") },
            { value: "overall", label: t("platformLicensing.pricing.basis.overall") },
          ]}
          helperText={t(`platformLicensing.pricing.basisHelp.${basis}`)}
        />

        <h3>{t("platformLicensing.pricing.volumeHeading")}</h3>
        <p className="platform-muted">{t("platformLicensing.pricing.volumeHelp")}</p>
        <div className="licensing-row-list">
          {volume.map((row, index) => (
            <div className="licensing-row" key={index}>
              <Select
                label={t("platformLicensing.pricing.audienceLabel")}
                value={row.audience}
                onChange={(value) =>
                  setVolume((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, audience: value } : r)),
                  )
                }
                options={audienceOptions}
              />
              <Input
                label={t("platformLicensing.pricing.minSeatsLabel")}
                value={row.minSeats}
                inputMode="numeric"
                onChange={(event) =>
                  setVolume((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, minSeats: event.target.value } : r)),
                  )
                }
              />
              <Input
                label={t("platformLicensing.pricing.percentLabel")}
                value={row.percent}
                inputMode="decimal"
                error={volumeInvalid[index] ? t("platformLicensing.pricing.rowError") : undefined}
                onChange={(event) =>
                  setVolume((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, percent: event.target.value } : r)),
                  )
                }
              />
              <Button
                variant="tertiary"
                onClick={() => setVolume((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("platformLicensing.common.remove")}
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                setVolume((prev) => [...prev, { audience: "all", minSeats: "", percent: "" }])
              }
            >
              {t("platformLicensing.pricing.addBracket")}
            </Button>
          </div>
        </div>

        <h3>{t("platformLicensing.pricing.durationHeading")}</h3>
        <div className="licensing-row-list">
          {duration.map((row, index) => (
            <div className="licensing-row" key={index}>
              <Input
                label={t("platformLicensing.pricing.minMonthsLabel")}
                value={row.minMonths}
                inputMode="numeric"
                onChange={(event) =>
                  setDuration((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, minMonths: event.target.value } : r)),
                  )
                }
              />
              <Input
                label={t("platformLicensing.pricing.percentLabel")}
                value={row.percent}
                inputMode="decimal"
                error={durationInvalid[index] ? t("platformLicensing.pricing.rowError") : undefined}
                onChange={(event) =>
                  setDuration((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, percent: event.target.value } : r)),
                  )
                }
              />
              <Button
                variant="tertiary"
                onClick={() => setDuration((prev) => prev.filter((_, i) => i !== index))}
              >
                {t("platformLicensing.common.remove")}
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              onClick={() => setDuration((prev) => [...prev, { minMonths: "", percent: "" }])}
            >
              {t("platformLicensing.pricing.addDuration")}
            </Button>
          </div>
        </div>
      </Card.Body>
      <Card.Footer>
        <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
          {t("platformLicensing.pricing.save", { currency: currencyCode })}
        </Button>
      </Card.Footer>
    </Card>
  );
}

interface BankForm {
  bankName: string;
  accountName: string;
  iban: string;
  swift: string;
  currencyCode: string;
}

const EMPTY_BANK: BankForm = {
  bankName: "",
  accountName: "",
  iban: "",
  swift: "",
  currencyCode: "",
};

function BankDetailsCard() {
  const { t } = useTranslation();
  const { show } = useToast();
  const query = useBankDetailsQuery();
  const save = useSaveBankDetails();
  const [form, setForm] = useState<BankForm | null>(null);
  const saved: BankForm | null = query.data ? { ...query.data } : null;
  const values: BankForm = form ?? saved ?? EMPTY_BANK;
  const set = (field: keyof BankForm, value: string) => setForm({ ...values, [field]: value });

  const valid =
    values.bankName.trim() !== "" &&
    values.accountName.trim() !== "" &&
    /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(values.iban) &&
    /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(values.swift) &&
    /^[A-Z]{3}$/.test(values.currencyCode);

  function submit() {
    if (!valid) return;
    save.mutate(values, {
      onSuccess: () => {
        setForm(null);
        show({ variant: "success", title: t("platformLicensing.common.saved") });
      },
      onError: (error) =>
        show({
          variant: "error",
          title: t("platformLicensing.common.saveError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <Card as="section" aria-labelledby="bank-details">
      <Card.Header>
        <h2 id="bank-details">{t("platformLicensing.pricing.bankTitle")}</h2>
        <p className="platform-muted">{t("platformLicensing.pricing.bankHelp")}</p>
      </Card.Header>
      <Card.Body>
        {query.data === null && form === null ? (
          <p role="status">{t("platformLicensing.pricing.bankMissing")}</p>
        ) : null}
        <div className="licensing-form-grid">
          <Input
            label={t("platformLicensing.pricing.bankName")}
            value={values.bankName}
            onChange={(event) => set("bankName", event.target.value)}
          />
          <Input
            label={t("platformLicensing.pricing.accountName")}
            value={values.accountName}
            onChange={(event) => set("accountName", event.target.value)}
          />
          <Input
            label={t("platformLicensing.pricing.iban")}
            value={values.iban}
            onChange={(event) => set("iban", event.target.value.replace(/\s/g, "").toUpperCase())}
          />
          <Input
            label={t("platformLicensing.pricing.swift")}
            value={values.swift}
            onChange={(event) => set("swift", event.target.value.trim().toUpperCase())}
          />
          <Input
            label={t("platformLicensing.pricing.bankCurrency")}
            value={values.currencyCode}
            maxLength={3}
            onChange={(event) => set("currencyCode", event.target.value.toUpperCase())}
          />
        </div>
      </Card.Body>
      <Card.Footer>
        <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
          {t("platformLicensing.pricing.saveBank")}
        </Button>
      </Card.Footer>
    </Card>
  );
}
