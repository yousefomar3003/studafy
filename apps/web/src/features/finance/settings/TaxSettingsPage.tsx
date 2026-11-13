import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Checkbox, Input, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { useTranslation } from "../../../lib/i18n";

import "./tax-settings.css";

import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

type TaxSettings = components["schemas"]["TaxSettings"];

export const TAX_SETTINGS_KEY = ["finance", "tax-settings"] as const;

/**
 * Sales tax (VAT) on fees (`/portal/finance/settings/tax`), gated by `billing:read`; saving needs
 * `organization:manageSettings` (the school admin), since whether a school charges tax is its
 * legal call. Off by default. When on, invoices generated from then on carry the rate as an ERPNext
 * tax row, except lines in an exempt fee category; invoices already issued never change. The
 * registration number prints on invoices and receipts.
 */
export default function TaxSettingsPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const canEdit = usePermissions().has(PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS);
  const exemptId = useId();

  const query = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/finance/tax-settings");
      if (!data) throw new Error("Tax settings returned no data.");
      return data as TaxSettings;
    },
  });

  const [enabled, setEnabled] = useState(false);
  const [taxName, setTaxName] = useState("VAT");
  const [rate, setRate] = useState("");
  const [account, setAccount] = useState("");
  const [registration, setRegistration] = useState("");
  const [inclusive, setInclusive] = useState(false);
  const [exempt, setExempt] = useState("");

  useEffect(() => {
    const settings = query.data;
    if (!settings) return;
    setEnabled(settings.is_enabled);
    setTaxName(settings.tax_name);
    setRate(settings.rate > 0 ? String(settings.rate) : "");
    setAccount(settings.erpnext_account_head ?? "");
    setRegistration(settings.registration_number ?? "");
    setInclusive(settings.prices_include_tax);
    setExempt(settings.exempt_fee_categories.join("\n"));
  }, [query.data]);

  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.PUT("/api/finance/tax-settings", {
        body: {
          is_enabled: enabled,
          tax_name: taxName.trim() || "VAT",
          rate: rate.trim() === "" ? 0 : Number(rate),
          erpnext_account_head: account.trim() || null,
          registration_number: registration.trim() || null,
          prices_include_tax: inclusive,
          exempt_fee_categories: exempt
            .split(/[\n,]/)
            .map((category) => category.trim())
            .filter(Boolean),
        },
      });
      if (!data) throw new Error("Saving tax settings returned no data.");
      return data as TaxSettings;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(TAX_SETTINGS_KEY, saved);
      show({ variant: "success", title: t("finance.taxSettings.savedToast") });
    },
    onError: (error) =>
      show({
        variant: "error",
        title: t("finance.taxSettings.saveError"),
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      }),
  });

  const rateValue = Number(rate);
  const rateValid =
    rate.trim() === "" || (Number.isFinite(rateValue) && rateValue >= 0 && rateValue <= 100);
  const missingForEnable = enabled && (!(rateValue > 0) || account.trim() === "");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !rateValid || missingForEnable) return;
    save.mutate();
  }

  if (query.isPending) return <p role="status">{t("finance.common.loading")}</p>;
  if (query.isError) return <p role="alert">{t("finance.taxSettings.loadError")}</p>;

  return (
    <div className="tax-settings">
      <div>
        <h1>{t("finance.taxSettings.title")}</h1>
        <p>{t("finance.taxSettings.intro")}</p>
      </div>

      {!canEdit ? <p role="note">{t("finance.taxSettings.readOnly")}</p> : null}

      <Card as="section" aria-label={t("finance.taxSettings.title")}>
        <Card.Body>
          <form className="tax-settings__form" onSubmit={handleSubmit}>
            <fieldset className="tax-settings__fieldset">
              <Checkbox
                disabled={!canEdit}
                label={t("finance.taxSettings.enabled")}
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <Input
                disabled={!canEdit}
                label={t("finance.taxSettings.name")}
                value={taxName}
                maxLength={60}
                onChange={(event) => setTaxName(event.target.value)}
              />
              <Input
                disabled={!canEdit}
                label={t("finance.taxSettings.rate")}
                inputMode="decimal"
                suffix="%"
                value={rate}
                error={rateValid ? undefined : t("finance.taxSettings.rateInvalid")}
                onChange={(event) => setRate(event.target.value)}
              />
              <Input
                disabled={!canEdit}
                label={t("finance.taxSettings.account")}
                helperText={t("finance.taxSettings.accountHelp")}
                value={account}
                maxLength={140}
                onChange={(event) => setAccount(event.target.value)}
              />
              <Input
                disabled={!canEdit}
                label={t("finance.taxSettings.registration")}
                helperText={t("finance.taxSettings.registrationHelp")}
                value={registration}
                maxLength={40}
                onChange={(event) => setRegistration(event.target.value)}
              />
              <Checkbox
                disabled={!canEdit}
                label={t("finance.taxSettings.inclusive")}
                checked={inclusive}
                onChange={(event) => setInclusive(event.target.checked)}
              />
              <div className="sf-field">
                <label className="sf-field__label" htmlFor={exemptId}>
                  {t("finance.taxSettings.exempt")}
                </label>
                <div className="sf-input">
                  <textarea
                    id={exemptId}
                    className="sf-input__control"
                    rows={4}
                    disabled={!canEdit}
                    value={exempt}
                    onChange={(event) => setExempt(event.target.value)}
                  />
                </div>
                <p className="sf-field__helper">{t("finance.taxSettings.exemptHelp")}</p>
              </div>
            </fieldset>

            {missingForEnable ? (
              <p className="sf-field__error" role="alert">
                {t("finance.taxSettings.needRateAndAccount")}
              </p>
            ) : null}
            <p className="tax-settings__note">{t("finance.taxSettings.notRetroactive")}</p>

            {canEdit ? (
              <div>
                <Button
                  type="submit"
                  loading={save.isPending}
                  disabled={!rateValid || missingForEnable}
                >
                  {t("finance.taxSettings.save")}
                </Button>
              </div>
            ) : null}
          </form>
        </Card.Body>
      </Card>
    </div>
  );
}
