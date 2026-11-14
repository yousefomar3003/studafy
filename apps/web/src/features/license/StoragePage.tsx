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
  useStorageCardSetup,
  useStorageCardsQuery,
  useStorageChangePreview,
  useStorageOfferQuery,
  useStoragePaymentMethodSession,
  useUndoStorageChange,
} from "./storage";
import { formatStorage } from "./storage-format";
import { StorageManageCard } from "./StorageManageCard";
import { StoragePayWith } from "./StoragePayWith";

import type { StorageInterval, StorageOffer, StoragePrice, StorageTier } from "./storage";

import "./license.css";

/** How long the page waits for a payment's confirmation before asking the buyer to come back. */
const CONFIRMING_FOR_MS = 2 * 60 * 1000;

export { formatStorage };

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
  const undo = useUndoStorageChange();
  const cardSession = useStoragePaymentMethodSession();
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
  // Paying for a change now: the card to charge (the renewal card unless the school picks another),
  // and whether that card should also take over renewals (never unless ticked).
  const cards = useStorageCardsQuery(switchTo !== null);
  const cardSetup = useStorageCardSetup();
  const [payWith, setPayWith] = useState<string | null>(null);
  const [alsoForRenewals, setAlsoForRenewals] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const cardAdded = searchParams.get("card") === "added";
  const resumeSwitch = searchParams.get("switch");
  const resumed = useRef(false);
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

  // The renewal card is chosen until the school picks another.
  useEffect(() => {
    if (payWith !== null || !cards.data || cards.data.length === 0) return;
    setPayWith((cards.data.find((card) => card.isDefault) ?? cards.data[0]!).id);
  }, [cards.data, payWith]);

  // Back from saving a new card: reopen the change the school was paying for.
  useEffect(() => {
    if (resumed.current || !resumeSwitch || !offer.data?.current) return;
    for (const tier of offer.data.tiers) {
      const price = tier.prices.find((candidate) => candidate?.id === resumeSwitch);
      if (price) {
        resumed.current = true;
        openSwitch(tier, price);
        return;
      }
    }
  }, [offer.data, resumeSwitch]);

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
    setPayWith(null);
    setAlsoForRenewals(false);
    setPayError(null);
    setPreviewAttempt((n) => n + 1);
    setSwitchTo({ tier, price, requestKey: crypto.randomUUID() });
  }

  function closeSwitch() {
    if (change.isPending) return;
    setSwitchTo(null);
    setPriceMoved(false);
  }

  function addCard() {
    if (!switchTo) return;
    const back = (params: Record<string, string>) => {
      const url = new URL(window.location.href);
      url.search = new URLSearchParams(params).toString();
      return url.toString();
    };
    once((done) =>
      cardSetup.mutate(
        {
          successUrl: back({ card: "added", switch: switchTo.price.id }),
          cancelUrl: back({ switch: switchTo.price.id }),
        },
        {
          // Stays "in flight" while the browser leaves for the card page.
          onSuccess: (result) => window.location.assign(result.url),
          onError: (error) => {
            done();
            setPayError(apiErrorMessage(error, t("schoolLicense.storage.payWith.addError")));
          },
        },
      ),
    );
  }

  function confirmSwitch() {
    const quoted = preview.data;
    if (!switchTo || !quoted) return;
    const paying = quoted.timing === "now" && quoted.amountDueNowMinor > 0;
    if (paying && !payWith) return;
    setPayError(null);
    once((done) =>
      change.mutate(
        {
          priceId: switchTo.price.id,
          prorationDate: quoted.prorationDate,
          expectedAmountMinor: quoted.amountDueNowMinor,
          requestKey: switchTo.requestKey,
          paymentMethodId: paying ? payWith : null,
          useForRenewals: paying && alsoForRenewals,
        },
        {
          onSuccess: (updated) => {
            done();
            setSwitchTo(null);
            show({
              variant: "success",
              title: updated.pendingChange
                ? t("schoolLicense.storage.scheduled", {
                    size: size(updated.pendingChange.capBytes),
                    date: date(updated.pendingChange.effectiveAt),
                  })
                : t("schoolLicense.storage.changed"),
            });
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
            if (
              error instanceof ApiError &&
              (error.code === ERROR_CODES.STORAGE_ADDON_PAYMENT_FAILED ||
                error.code === ERROR_CODES.STORAGE_ADDON_CARD_INVALID)
            ) {
              // Nothing changed: say why, and let the school pick another card or add one.
              setPayError(apiErrorMessage(error, t("schoolLicense.storage.changeError")));
              setSwitchTo({ ...switchTo, requestKey: crypto.randomUUID() });
              void cards.refetch();
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

  function undoChange() {
    once((done) =>
      undo.mutate(undefined, {
        onSuccess: () => {
          done();
          show({ variant: "success", title: t("schoolLicense.storage.manage.undone") });
        },
        onError: (error) => {
          done();
          failed(t("schoolLicense.storage.changeError"))(error);
        },
      }),
    );
  }

  function updateCard() {
    once((done) =>
      cardSession.mutate(window.location.href.split("?")[0]!, {
        // Stays "in flight" while the browser leaves for the payment provider's page.
        onSuccess: (result) => window.location.assign(result.url),
        onError: (error) => {
          done();
          failed(t("schoolLicense.storage.manage.cardError"))(error);
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
  const busy =
    checkout.isPending ||
    change.isPending ||
    cancellation.isPending ||
    undo.isPending ||
    cardSession.isPending ||
    cardSetup.isPending ||
    confirming;
  const changeScheduled = current?.pendingChange != null;

  return (
    <>
      <LicenseHeader
        title={t("schoolLicense.storage.title")}
        description={t("schoolLicense.storage.description")}
      />

      {data?.testMode ? (
        <div
          className="license-banner"
          data-tone="warning"
          role="note"
          data-testid="storage-test-mode"
        >
          <div>
            <p className="license-banner__title">{t("schoolLicense.storage.testModeTitle")}</p>
            <p className="license-banner__body">{t("schoolLicense.storage.testModeBody")}</p>
          </div>
        </div>
      ) : null}

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
            </Card.Body>
          </Card>

          {current && canManage && data.availableOnline ? (
            <StorageManageCard
              current={current}
              includedBytes={data.usage.includedBytes}
              busy={busy}
              cancelling={cancellation.isPending}
              undoing={undo.isPending}
              openingCard={cardSession.isPending}
              onCancel={() => setConfirmCancel(true)}
              onResume={() => setCancel(false)}
              onUndoChange={undoChange}
              onUpdateCard={updateCard}
            />
          ) : null}

          <h2 className="storage-heading">{t("schoolLicense.storage.tiersTitle")}</h2>
          {changeScheduled ? (
            <p className="license-muted">{t("schoolLicense.storage.changeScheduledNote")}</p>
          ) : null}

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
                              disabled={busy || changeScheduled}
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
          {payError ? (
            <p role="alert" data-testid="storage-pay-error">
              {payError}
            </p>
          ) : null}
          {preview.isPending || preview.isFetching ? (
            <p role="status">{t("schoolLicense.storage.previewLoading")}</p>
          ) : preview.isError || !preview.data || !switchTo ? (
            <p role="alert">
              {apiErrorMessage(preview.error, t("schoolLicense.storage.previewError"))}
            </p>
          ) : preview.data.timing === "now" ? (
            <>
              <p className="storage-charge" data-testid="storage-charge-now">
                {preview.data.amountDueNowMinor > 0
                  ? t("schoolLicense.storage.chargedToday", {
                      amount: money(preview.data.amountDueNowMinor, preview.data.currency),
                    })
                  : t("schoolLicense.storage.nothingToday")}
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
              {preview.data.amountDueNowMinor > 0 ? (
                <>
                  {cardAdded ? (
                    <p className="license-muted">{t("schoolLicense.storage.payWith.added")}</p>
                  ) : null}
                  <StoragePayWith
                    cards={cards.data ?? []}
                    loading={cards.isPending}
                    failed={cards.isError}
                    selected={payWith}
                    onSelect={setPayWith}
                    alsoForRenewals={alsoForRenewals}
                    onAlsoForRenewals={setAlsoForRenewals}
                    onAddCard={addCard}
                    addingCard={cardSetup.isPending}
                    disabled={change.isPending}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <p className="storage-charge" data-testid="storage-charge-now">
                {t("schoolLicense.storage.nothingToday")}
              </p>
              <p>
                {t("schoolLicense.storage.atRenewal", {
                  current: current ? size(current.capBytes) : "",
                  size: size(switchTo.tier.capBytes),
                  date: date(preview.data.effectiveAt),
                  price: priceLabel(switchTo.price),
                })}
              </p>
              <p className="license-muted">{t("schoolLicense.storage.atRenewalHelp")}</p>
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
            disabled={
              !preview.data ||
              preview.isFetching ||
              (preview.data.timing === "now" && preview.data.amountDueNowMinor > 0 && !payWith)
            }
            onClick={confirmSwitch}
          >
            {preview.data?.timing === "renewal"
              ? t("schoolLicense.storage.scheduleConfirm", {
                  date: date(preview.data.effectiveAt),
                })
              : preview.data && preview.data.amountDueNowMinor > 0
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
