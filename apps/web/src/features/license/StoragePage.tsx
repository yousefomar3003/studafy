import { ApiError } from "@studafy/api-client";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import { Button, Card, Chip, Modal, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import { LicenseHeader } from "./LicenseHeader";
import {
  useChangeStorageTier,
  useSetStorageCancellation,
  useStartStorageCheckout,
  useStorageChangePreview,
  useStorageOfferQuery,
} from "./storage";

import type { StorageInterval, StorageOffer, StoragePrice, StorageTier } from "./storage";
import type { Formatters } from "../../lib/i18n";
import type { TFunction } from "i18next";

import "./license.css";

const GIB = 1024 ** 3;

/** How long the page waits for a payment's confirmation before asking the buyer to come back. */
const CONFIRMING_FOR_MS = 2 * 60 * 1000;

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
 *
 * Money moves only after a confirmation that names the amount: buying shows the price before the
 * payment page; switching shows the exact prorated charge the provider computed, and the change is
 * sent with that amount so nothing else can be charged; stopping renewal says what happens and when.
 * Every action is guarded against a second click while one is in flight, and while a payment that
 * just went through is still being confirmed, nothing can be bought again.
 */
export default function StoragePage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const { show } = useToast();
  const [searchParams] = useSearchParams();
  const canManage = usePermissions().has(PERMISSIONS.LICENSE_MANAGE);
  const checkoutStatus = searchParams.get("checkout");

  // A payment that went through (or one the server says is already on its way) is confirmed by the
  // provider's webhook a little later: until the add-on shows up, poll and sell nothing.
  const [awaitingPayment, setAwaitingPayment] = useState(checkoutStatus === "success");
  const [confirmTimedOut, setConfirmTimedOut] = useState(false);
  const offer = useStorageOfferQuery({ poll: awaitingPayment && !confirmTimedOut });
  const checkout = useStartStorageCheckout();
  const change = useChangeStorageTier();
  const cancellation = useSetStorageCancellation();
  const [interval, setInterval] = useState<StorageInterval | null>(null);
  const [buyTarget, setBuyTarget] = useState<{ tier: StorageTier; price: StoragePrice } | null>(
    null,
  );
  const [switchTo, setSwitchTo] = useState<{
    tier: StorageTier;
    price: StoragePrice;
    requestKey: string;
  } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [priceMoved, setPriceMoved] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const preview = useStorageChangePreview(switchTo?.price.id ?? null, previewAttempt);
  // Set synchronously on the first click, before React re-renders a disabled button: a double click
  // or a second key press can never start a second payment.
  const inFlight = useRef(false);

  const hasStorage = offer.data?.current != null;
  const confirming = awaitingPayment && !hasStorage;

  useEffect(() => {
    if (!awaitingPayment) return;
    if (hasStorage) {
      setAwaitingPayment(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmTimedOut(true), CONFIRMING_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingPayment, hasStorage]);

  const size = (bytes: number) => formatStorage(bytes, t, formatNumber);
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });
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

  /** Run `action` unless another one is still in flight; `action` calls `done` when it settles. */
  function once(action: (done: () => void) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    action(() => {
      inFlight.current = false;
    });
  }

  function confirmBuy() {
    if (!buyTarget) return;
    const { price } = buyTarget;
    once((done) =>
      checkout.mutate(
        { priceId: price.id, successUrl: returnUrl("success"), cancelUrl: returnUrl("cancelled") },
        {
          // Stays "in flight" while the browser leaves for the payment page.
          onSuccess: (result) => window.location.assign(result.url),
          onError: (error) => {
            done();
            setBuyTarget(null);
            if (
              error instanceof ApiError &&
              error.code === ERROR_CODES.STORAGE_ADDON_PURCHASE_PENDING
            ) {
              setConfirmTimedOut(false);
              setAwaitingPayment(true);
            }
            failed(t("schoolLicense.storage.checkoutError"))(error);
          },
        },
      ),
    );
  }

  function openSwitch(tier: StorageTier, price: StoragePrice) {
    setPriceMoved(false);
    setPreviewAttempt((n) => n + 1);
    setSwitchTo({ tier, price, requestKey: crypto.randomUUID() });
  }

  function closeSwitch() {
    if (change.isPending) return;
    setSwitchTo(null);
    setPriceMoved(false);
  }

  function confirmSwitch() {
    const quoted = preview.data;
    if (!switchTo || !quoted) return;
    once((done) =>
      change.mutate(
        {
          priceId: switchTo.price.id,
          prorationDate: quoted.prorationDate,
          expectedAmountMinor: quoted.amountDueNowMinor,
          requestKey: switchTo.requestKey,
        },
        {
          onSuccess: () => {
            done();
            setSwitchTo(null);
            show({ variant: "success", title: t("schoolLicense.storage.changed") });
          },
          onError: (error) => {
            done();
            if (
              error instanceof ApiError &&
              error.code === ERROR_CODES.STORAGE_ADDON_PRICE_CHANGED
            ) {
              // Nothing was charged: show the new amount and let the school confirm that one.
              setPriceMoved(true);
              setPreviewAttempt((n) => n + 1);
              setSwitchTo({ ...switchTo, requestKey: crypto.randomUUID() });
              return;
            }
            setSwitchTo(null);
            failed(t("schoolLicense.storage.changeError"))(error);
          },
        },
      ),
    );
  }

  function setCancel(cancel: boolean) {
    once((done) =>
      cancellation.mutate(cancel, {
        onSuccess: () => {
          done();
          setConfirmCancel(false);
          show({
            variant: "success",
            title: t(cancel ? "schoolLicense.storage.canceled" : "schoolLicense.storage.resumed"),
          });
        },
        onError: (error) => {
          done();
          setConfirmCancel(false);
          failed(t("schoolLicense.storage.cancelError"))(error);
        },
      }),
    );
  }

  const data: StorageOffer | undefined = offer.data;
  const current = data?.current ?? null;
  const shownInterval: StorageInterval = interval ?? current?.price?.interval ?? "monthly";
  const percent =
    data && data.usage.capBytes > 0
      ? Math.min(100, Math.round((data.usage.usedBytes / data.usage.capBytes) * 100))
      : 0;
  const busy = checkout.isPending || change.isPending || cancellation.isPending || confirming;

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.storage.title")}
        description={t("schoolLicense.storage.description")}
      />

      {confirming ? (
        <div className="license-banner" data-tone="neutral" role="status">
          <div>
            <p className="license-banner__title">{t("schoolLicense.storage.confirmingTitle")}</p>
            <p className="license-banner__body">
              {t(
                confirmTimedOut
                  ? "schoolLicense.storage.confirmingSlowBody"
                  : "schoolLicense.storage.confirmingBody",
              )}
            </p>
          </div>
        </div>
      ) : checkoutStatus === "success" ? (
        <div className="license-banner" data-tone="success" role="status">
          <div>
            <p className="license-banner__title">{t("schoolLicense.storage.successTitle")}</p>
            <p className="license-banner__body">{t("schoolLicense.storage.successReadyBody")}</p>
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
              {data.granted ? (
                <p className="license-muted" data-testid="storage-granted">
                  {t("schoolLicense.storage.granted", {
                    size: size(data.granted.capBytes),
                    date: formatDate(new Date(data.granted.endsAt), { dateStyle: "medium" }),
                  })}
                </p>
              ) : null}
              {current && canManage && data.availableOnline ? (
                <Button
                  type="button"
                  variant="secondary"
                  loading={cancellation.isPending}
                  disabled={busy}
                  onClick={() =>
                    current.cancelAtPeriodEnd ? setCancel(false) : setConfirmCancel(true)
                  }
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
                                (change.isPending && change.variables?.priceId === price.id)
                              }
                              disabled={busy}
                              onClick={() =>
                                current ? openSwitch(tier, price) : setBuyTarget({ tier, price })
                              }
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
        open={buyTarget !== null}
        onClose={() => (checkout.isPending ? undefined : setBuyTarget(null))}
        title={t("schoolLicense.storage.buyTitle", {
          size: buyTarget ? size(buyTarget.tier.capBytes) : "",
        })}
      >
        <Modal.Body>
          {buyTarget ? (
            <p>
              {t(
                buyTarget.price.interval === "yearly"
                  ? "schoolLicense.storage.buyBodyYearly"
                  : "schoolLicense.storage.buyBodyMonthly",
                {
                  amount: money(buyTarget.price.amountMinor, buyTarget.price.currency),
                  size: size(buyTarget.tier.capBytes),
                },
              )}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button
            type="button"
            variant="secondary"
            disabled={checkout.isPending}
            onClick={() => setBuyTarget(null)}
          >
            {t("schoolLicense.common.cancel")}
          </Button>
          <Button type="button" variant="primary" loading={checkout.isPending} onClick={confirmBuy}>
            {t("schoolLicense.storage.buyConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal
        open={switchTo !== null}
        onClose={closeSwitch}
        title={t("schoolLicense.storage.switchTitle", {
          size: switchTo ? size(switchTo.tier.capBytes) : "",
        })}
      >
        <Modal.Body>
          {priceMoved ? <p role="alert">{t("schoolLicense.storage.priceMoved")}</p> : null}
          {preview.isPending || preview.isFetching ? (
            <p role="status">{t("schoolLicense.storage.previewLoading")}</p>
          ) : preview.isError || !preview.data || !switchTo ? (
            <p role="alert">
              {apiErrorMessage(preview.error, t("schoolLicense.storage.previewError"))}
            </p>
          ) : preview.data.chargeNow ? (
            <>
              <p className="storage-charge" data-testid="storage-charge-now">
                {t("schoolLicense.storage.chargedToday", {
                  amount: money(preview.data.amountDueNowMinor, preview.data.currency),
                })}
              </p>
              <p className="license-muted">
                {t("schoolLicense.storage.chargedTodayHelp", {
                  size: size(switchTo.tier.capBytes),
                })}
              </p>
              <p>
                {t("schoolLicense.storage.thenFrom", {
                  price: priceLabel(switchTo.price),
                  date: date(preview.data.nextBillAt),
                })}
              </p>
            </>
          ) : (
            <>
              <p className="storage-charge" data-testid="storage-charge-now">
                {t("schoolLicense.storage.nothingToday")}
              </p>
              <p>
                {t("schoolLicense.storage.downNextBill", {
                  size: size(switchTo.tier.capBytes),
                  date: date(preview.data.nextBillAt),
                  amount: money(preview.data.nextBillMinor, preview.data.currency),
                })}
              </p>
              <p className="license-muted">
                {t("schoolLicense.storage.thenPrice", { price: priceLabel(switchTo.price) })}
              </p>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            type="button"
            variant="secondary"
            disabled={change.isPending}
            onClick={closeSwitch}
          >
            {t("schoolLicense.common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={change.isPending}
            disabled={!preview.data || preview.isFetching}
            onClick={confirmSwitch}
          >
            {preview.data && preview.data.chargeNow
              ? t("schoolLicense.storage.payAndSwitch", {
                  amount: money(preview.data.amountDueNowMinor, preview.data.currency),
                })
              : t("schoolLicense.storage.switchConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal
        open={confirmCancel}
        onClose={() => (cancellation.isPending ? undefined : setConfirmCancel(false))}
        title={t("schoolLicense.storage.cancelTitle")}
      >
        <Modal.Body>
          {current && data ? (
            <p>
              {t("schoolLicense.storage.cancelBody", {
                size: size(current.capBytes),
                date: date(current.currentPeriodEnd),
                included: size(data.usage.includedBytes),
              })}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button
            type="button"
            variant="secondary"
            disabled={cancellation.isPending}
            onClick={() => setConfirmCancel(false)}
          >
            {t("schoolLicense.storage.cancelKeep")}
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={cancellation.isPending}
            onClick={() => setCancel(true)}
          >
            {t("schoolLicense.storage.cancelConfirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
