import { ApiError } from "@studafy/api-client";
import { Button, Card, Chip, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useAuth } from "../../lib/auth";
import {
  FeatureNotice,
  featureErrorMessageKey,
  useFeatureGate,
  useFeatures,
} from "../../lib/features";
import { useLocale, useTranslation } from "../../lib/i18n";

import { useStartAiCheckout } from "./mutations";
import { AI_OFFER_QUERY_KEY, fetchAiOffer } from "./queries";
import { RefundRequestLink } from "./RefundRequestLink";

import type { AiOffer } from "./queries";

import "./billing.css";

/** The one code `POST /api/subscriptions/ai/checkout` throws when the *school* isn't active (see
 * `createAiCheckoutSession` in the API) -- the precondition this page's blocked state exists for.
 * Every other failure falls back to a generic retryable toast. */
const SCHOOL_INACTIVE_CODE = "AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

function formatPrice(price: NonNullable<AiOffer["price"]>, locale: string): string {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency: price.currency,
  }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat(locale, { style: "currency", currency: price.currency }).format(
    price.amountMinor / 10 ** (digits ?? 2),
  );
}

/** This page with a checkout outcome, for the payment provider to send the buyer back to. */
function returnUrl(status: "success" | "cancelled"): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("checkout", status);
  return url.toString();
}

/**
 * Buying the AI add-on on the website (`/account/ai`), linked from the account page.
 *
 * `GET /api/subscriptions/ai/offer` says what the signed-in user can buy: the add-on's price, and
 * the students it can be bought for -- the user themselves as a student, or the children they are
 * linked to as a parent -- each with whether it is already active. The price shown is the catalog's;
 * the payment provider's hosted checkout confirms it before anything is charged.
 *
 * A student the school provides for is never offered the purchase (docs/billing/feature-licensing.md,
 * session 6): one holding a school-license seat is shown "Provided by" the school, one whose school
 * sells a seat that includes the AI tutor is told to ask the school for one. A student signed in
 * themselves also sees their own coverage: a personal subscription that will not renew now the
 * school covers them, and this month's limit.
 */
export default function AiSubscriptionPurchasePage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [searchParams] = useSearchParams();
  const { show } = useToast();
  const [schoolInactive, setSchoolInactive] = useState(false);
  const checkoutStatus = searchParams.get("checkout");

  const offer = useQuery({ queryKey: AI_OFFER_QUERY_KEY, queryFn: fetchAiOffer });
  const checkout = useStartAiCheckout();
  const features = useFeatures();
  const tutor = useFeatureGate("ai_tutor");
  const isStudent = useAuth().roles.includes("STUDENT");
  const schoolName = features.data?.schoolName ?? "";

  function buy(studentId: string, priceId: string) {
    checkout.mutate(
      {
        studentId,
        priceId,
        successUrl: returnUrl("success"),
        cancelUrl: returnUrl("cancelled"),
      },
      {
        onSuccess: (result) => {
          window.location.assign(result.url);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === SCHOOL_INACTIVE_CODE) {
            setSchoolInactive(true);
            return;
          }
          const friendly = error instanceof ApiError ? featureErrorMessageKey(error.code) : null;
          show({
            variant: "error",
            title: t("site.billing.ai.checkoutError"),
            description: friendly ? t(friendly) : apiErrorMessage(error, t("site.common.tryAgain")),
          });
        },
      },
    );
  }

  if (checkoutStatus === "success") {
    return (
      <>
        <h1>{t("site.billing.ai.successTitle")}</h1>
        <Card>
          <Card.Body>
            <p>{t("site.billing.ai.successBody")}</p>
          </Card.Body>
        </Card>
      </>
    );
  }

  return (
    <>
      <h1>{t("site.billing.ai.title")}</h1>
      <p className="ai-purchase__intro">{t("site.billing.ai.intro")}</p>
      {isStudent ? (
        <FeatureNotice state={tutor} unitLabel={t("site.features.units.messages")} />
      ) : null}

      {checkoutStatus === "cancelled" && !schoolInactive ? (
        <div className="billing-banner" data-tone="neutral" role="status">
          <div>
            <p className="billing-banner__title">{t("site.billing.ai.cancelledTitle")}</p>
            <p className="billing-banner__body">{t("site.billing.ai.cancelledBody")}</p>
          </div>
        </div>
      ) : null}

      {schoolInactive ? (
        <div className="billing-banner" data-tone="warning" role="alert">
          <div>
            <p className="billing-banner__title">{t("site.billing.ai.blockedTitle")}</p>
            <p className="billing-banner__body">{t("site.billing.ai.blockedBody")}</p>
          </div>
        </div>
      ) : offer.isPending ? (
        <p role="status">{t("site.billing.ai.loading")}</p>
      ) : offer.isError ? (
        <p role="alert" className="billing-overview__notice">
          {t("site.billing.ai.loadError")}
        </p>
      ) : !offer.data.price ? (
        <p className="billing-overview__notice">{t("site.billing.ai.noPrice")}</p>
      ) : offer.data.students.length === 0 ? (
        <p className="billing-overview__notice">{t("site.billing.ai.noStudents")}</p>
      ) : (
        <Card>
          <Card.Body>
            <p className="ai-purchase__price">
              {t(
                offer.data.price.interval === "yearly"
                  ? "site.billing.ai.pricePerYear"
                  : "site.billing.ai.pricePerMonth",
                { price: formatPrice(offer.data.price, locale) },
              )}
            </p>
            <ul className="ai-purchase__students">
              {offer.data.students.map((student) => (
                <li key={student.id} className="ai-purchase__student">
                  <span>{student.name}</span>
                  {student.schoolSeat ? (
                    <Chip>
                      {schoolName
                        ? t("site.features.providedBy", { school: schoolName })
                        : t("site.features.providedBySchool")}
                    </Chip>
                  ) : student.active ? (
                    <span className="ai-purchase__active">
                      <Chip>{t("site.billing.ai.active")}</Chip>
                      <RefundRequestLink studentId={student.id} />
                    </span>
                  ) : student.schoolOffers ? (
                    <span className="billing-overview__caption">
                      {t("site.features.askSchoolFor", { name: student.name })}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="primary"
                      loading={checkout.isPending && checkout.variables?.studentId === student.id}
                      disabled={checkout.isPending}
                      onClick={() => buy(student.id, offer.data.price!.id)}
                    >
                      {t("site.billing.ai.getAiFor", { name: student.name })}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="billing-overview__caption">{t("site.billing.ai.confirmPrice")}</p>
          </Card.Body>
        </Card>
      )}
    </>
  );
}
