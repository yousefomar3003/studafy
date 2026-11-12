import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Chip, Modal, useToast } from "@studafy/ui";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { LicenseHeader } from "./LicenseHeader";
import {
  useChangeStorageTier,
  useSetStorageCancellation,
  useStartStorageCheckout,
  useStorageOfferQuery,
} from "./storage";

import type { StorageInterval, StorageOffer, StoragePrice, StorageTier } from "./storage";
import type { Formatters } from "../../lib/i18n";
import type { TFunction } from "i18next";

import "./license.css";

const GIB = 1024 ** 3;

/** "8.2 GB", "100 GB", "1 TB": whole units where they are whole, one decimal otherwise. */
export function formatStorage(
  bytes: number,
  t: TFunction,
  formatNumber: Formatters["formatNumber"],
): string {
  const unit = (value: number) =>
    formatNumber(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 });
  if (bytes >= 1024 * GIB)
    return t("schoolLicense.storage.units.tb", { value: unit(bytes / (1024 * GIB)) });
  if (bytes >= GIB)
    return t("schoolLicense.storage.units.gb", {
      value: unit(Math.round((bytes / GIB) * 10) / 10),
    });
  return t("schoolLicense.storage.units.mb", { value: unit(Math.round(bytes / 1024 ** 2)) });
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

/** This page with a checkout outcome, for the payment provider to send the buyer back to. */
function returnUrl(status: "success" | "cancelled"): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("checkout", status);
  return url.toString();
}

function priceFor(tier: StorageTier, interval: StorageInterval): StoragePrice | undefined {
  return tier.prices.find(
    (price): price is StoragePrice => price !== null && price.interval === interval,
  );
}

/**
 * Extra storage for the school (`/portal/license/storage`), gated by `license:read`; buying,
 * changing and canceling need `license:manage` (ORG_ADMIN and PRINCIPAL).
 *
 * Everyone at the school shares one storage allowance: 10 GB is included, and the add-on raises it to
 * 100 GB or 1 TB, monthly or yearly. Nothing is ever deleted -- canceling, or moving to less storage
 * than the school already uses, only stops new uploads until it is back under its limit.
 */
export default function StoragePage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const { show } = useToast();
  const [searchParams] = useSearchParams();
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const offer = useStorageOfferQuery();
  const checkout = useStartStorageCheckout();
  const change = useChangeStorageTier();
  const cancellation = useSetStorageCancellation();
  const [interval, setInterval] = useState<StorageInterval | null>(null);
  const [switchTo, setSwitchTo] = useState<{ tier: StorageTier; price: StoragePrice } | null>(null);
  const checkoutStatus = searchParams.get("checkout");

  const size = (bytes: number) => formatStorage(bytes, t, formatNumber);
  const priceLabel = (price: StoragePrice) =>
    t(
      price.interval === "yearly"
        ? "schoolLicense.storage.pricePerYear"
        : "schoolLicense.storage.pricePerMonth",
      { price: money(price.amountMinor, price.currency) },
    );

  function failed(title: string) {
    return (error: unknown) =>
      show({
        variant: "error",
        title,
        description: apiErrorMessage(error, t("schoolLicense.common.saveError")),
      });
  }

  function buy(price: StoragePrice) {
    checkout.mutate(
      { priceId: price.id, successUrl: returnUrl("success"), cancelUrl: returnUrl("cancelled") },
      {
        onSuccess: (result) => window.location.assign(result.url),
        onError: failed(t("schoolLicense.storage.checkoutError")),
      },
    );
  }

  function confirmSwitch() {
    if (!switchTo) return;
    change.mutate(switchTo.price.id, {
      onSuccess: () => {
        setSwitchTo(null);
        show({ variant: "success", title: t("schoolLicense.storage.changed") });
      },
      onError: (error) => {
        setSwitchTo(null);
        failed(t("schoolLicense.storage.changeError"))(error);
      },
    });
  }

  function setCancel(cancel: boolean) {
    cancellation.mutate(cancel, {
      onSuccess: () =>
        show({
          variant: "success",
          title: t(cancel ? "schoolLicense.storage.canceled" : "schoolLicense.storage.resumed"),
        }),
      onError: failed(t("schoolLicense.storage.cancelError")),
    });
  }

  const data: StorageOffer | undefined = offer.data;
  const current = data?.current ?? null;
  const shownInterval: StorageInterval = interval ?? current?.price?.interval ?? "monthly";
  const percent =
    data && data.usage.capBytes > 0
      ? Math.min(100, Math.round((data.usage.usedBytes / data.usage.capBytes) * 100))
      : 0;
  const busy = checkout.isPending || change.isPending || cancellation.isPending;

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.storage.title")}
        description={t("schoolLicense.storage.description")}
      />

      {checkoutStatus === "success" ? (
        <div className="license-banner" data-tone="success" role="status">
          <div>
            <p className="license-banner__title">{t("schoolLicense.storage.successTitle")}</p>
            <p className="license-banner__body">{t("schoolLicense.storage.successBody")}</p>
          </div>
        </div>
      ) : checkoutStatus === "cancelled" ? (
        <div className="license-banner" data-tone="neutral" role="status">
          <div>
            <p className="license-banner__title">{t("schoolLicense.storage.cancelledTitle")}</p>
            <p className="license-banner__body">{t("schoolLicense.storage.cancelledBody")}</p>
          </div>
        </div>
      ) : null}

      {offer.isPending ? (
        <p role="status">{t("schoolLicense.common.loading")}</p>
      ) : offer.isError || !data ? (
        <p role="alert">{t("schoolLicense.common.loadError")}</p>
      ) : (
        <>
          <Card>
            <Card.Body>
              <h2 className="storage-heading">{t("schoolLicense.storage.usageTitle")}</h2>
              <div
                className="storage-meter"
                role="img"
                aria-label={t("schoolLicense.storage.usedPercent", {
                  percent: formatNumber(percent / 100, { style: "percent" }),
                })}
              >
                <div
                  className="storage-meter__fill"
                  data-tone={percent >= 95 ? "danger" : percent >= 80 ? "warning" : "success"}
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p>
                {t("schoolLicense.storage.usedOf", {
                  used: size(data.usage.usedBytes),
                  cap: size(data.usage.capBytes),
                })}
              </p>
              {current ? (
                <p className="license-muted">
                  {t(
                    current.cancelAtPeriodEnd
                      ? "schoolLicense.storage.currentEnding"
                      : "schoolLicense.storage.currentRenewing",
                    {
                      size: size(current.capBytes),
                      date: formatDate(new Date(current.currentPeriodEnd), { dateStyle: "medium" }),
                      included: size(data.usage.includedBytes),
                    },
                  )}
                </p>
              ) : (
                <p className="license-muted">
                  {t("schoolLicense.storage.included", { size: size(data.usage.includedBytes) })}
                </p>
              )}
              {current && canManage && data.availableOnline ? (
                <Button
                  type="button"
                  variant="secondary"
                  loading={cancellation.isPending}
                  disabled={busy}
                  onClick={() => setCancel(!current.cancelAtPeriodEnd)}
                >
                  {t(
                    current.cancelAtPeriodEnd
                      ? "schoolLicense.storage.keepRenewing"
                      : "schoolLicense.storage.cancelRenewal",
                  )}
                </Button>
              ) : null}
            </Card.Body>
          </Card>

          <h2 className="storage-heading">{t("schoolLicense.storage.tiersTitle")}</h2>

          {!data.availableOnline ? (
            <p className="license-muted">{t("schoolLicense.storage.notOnline")}</p>
          ) : null}

          {data.currency === null ? (
            <p className="license-muted">{t("schoolLicense.storage.noPrices")}</p>
          ) : (
            <>
              <fieldset className="storage-interval">
                <legend>{t("schoolLicense.storage.billedLabel")}</legend>
                {(["monthly", "yearly"] as const).map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="storage-interval"
                      value={value}
                      checked={shownInterval === value}
                      onChange={() => setInterval(value)}
                    />
                    {t(`schoolLicense.storage.interval.${value}`)}
                  </label>
                ))}
              </fieldset>

              <ul className="storage-tiers">
                {data.tiers.map((tier) => {
                  const price = priceFor(tier, shownInterval);
                  const isCurrent =
                    current?.planCode === tier.planCode &&
                    current.price?.interval === shownInterval;
                  return (
                    <li key={tier.planCode}>
                      <Card>
                        <Card.Body>
                          <p className="storage-tier__size">{size(tier.capBytes)}</p>
                          <p>
                            {price
                              ? priceLabel(price)
                              : t("schoolLicense.storage.noPriceForInterval")}
                          </p>
                          {isCurrent ? (
                            <Chip>{t("schoolLicense.storage.currentChip")}</Chip>
                          ) : canManage && data.availableOnline && price ? (
                            <Button
                              type="button"
                              variant="primary"
                              loading={
                                (checkout.isPending && checkout.variables?.priceId === price.id) ||
                                (change.isPending && change.variables === price.id)
                              }
                              disabled={busy}
                              onClick={() => (current ? setSwitchTo({ tier, price }) : buy(price))}
                            >
                              {t(
                                current
                                  ? "schoolLicense.storage.switchTo"
                                  : "schoolLicense.storage.upgradeTo",
                                { size: size(tier.capBytes) },
                              )}
                            </Button>
                          ) : null}
                        </Card.Body>
                      </Card>
                    </li>
                  );
                })}
              </ul>
              {canManage && data.availableOnline ? (
                <p className="license-muted">{t("schoolLicense.storage.confirmPrice")}</p>
              ) : null}
            </>
          )}

          <p className="license-muted">{t("schoolLicense.storage.nothingDeleted")}</p>
        </>
      )}

      <Modal
        open={switchTo !== null}
        onClose={() => setSwitchTo(null)}
        title={t("schoolLicense.storage.switchTitle", {
          size: switchTo ? size(switchTo.tier.capBytes) : "",
        })}
      >
        <Modal.Body>
          <p>
            {switchTo && current && switchTo.tier.capBytes < current.capBytes
              ? t("schoolLicense.storage.switchDownBody", {
                  size: size(switchTo.tier.capBytes),
                  price: priceLabel(switchTo.price),
                })
              : t("schoolLicense.storage.switchUpBody", {
                  price: switchTo ? priceLabel(switchTo.price) : "",
                })}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={() => setSwitchTo(null)}>
            {t("schoolLicense.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={change.isPending}
            onClick={confirmSwitch}
          >
            {t("schoolLicense.storage.switchConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
