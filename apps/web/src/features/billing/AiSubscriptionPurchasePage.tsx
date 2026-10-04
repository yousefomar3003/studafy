import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { useStartAiCheckout } from "./mutations";
import { aiCheckoutStudentQueryKey, fetchAiCheckoutStudent } from "./queries";

import type { AiCheckoutStudent } from "./queries";

import "./billing.css";

/** The one code `POST /api/subscriptions/ai/checkout` throws when the *school's* subscription
 * isn't active (see `createAiCheckoutSession` in the API) — the precondition this page's blocked
 * state exists for. Every other failure (bad/expired price, student not found, Stripe unreachable)
 * falls back to a generic retryable toast, same as the rest of the billing feature. */
const SCHOOL_INACTIVE_CODE = "AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE";

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  return error.detail ?? error.title;
}

function studentDisplayName(student: AiCheckoutStudent): string {
  return student.preferred_name?.trim() || `${student.first_name} ${student.last_name}`;
}

/** Rebuilds this same page's URL with a `checkout` outcome plus the student/price the deep link
 * arrived with, so a Stripe-hosted redirect back here can still render the right state (and, on
 * cancellation, retry without the parent going back to the mobile app for a new link). */
function buildReturnUrl(
  status: "success" | "cancelled",
  studentId: string,
  priceId: string,
): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("studentId", studentId);
  url.searchParams.set("priceId", priceId);
  url.searchParams.set("checkout", status);
  return url.toString();
}

/**
 * AI subscription purchase page (`/account/ai`) — the deep-link target the mobile app sends a
 * parent or student to when they choose to buy the per-student AI add-on.
 *
 * Mobile hands this page the student and the chosen Stripe price as `studentId`/`priceId` query
 * params rather than this page discovering them itself: `POST /api/subscriptions/ai/checkout` is
 * web-channel-only (mobile cannot call it directly — see `ai-checkout-routes.ts`), and
 * `GET /api/subscriptions/plans` is the school-plan catalog, not an AI add-on price list (see
 * `routes/marketing/PricingPage.tsx`'s own note that add-on pricing isn't published there). Mobile
 * already knows the price the parent picked, so it's the only side that can hand this page a valid
 * `priceId` — the exact charge is then confirmed on Stripe's own hosted checkout page, not restated
 * here.
 */
export default function AiSubscriptionPurchasePage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { show } = useToast();
  const [schoolInactive, setSchoolInactive] = useState(false);

  const studentId = searchParams.get("studentId") ?? "";
  const priceId = searchParams.get("priceId") ?? "";
  const checkoutStatus = searchParams.get("checkout");

  const studentQuery = useQuery({
    queryKey: aiCheckoutStudentQueryKey(studentId),
    queryFn: () => fetchAiCheckoutStudent(studentId),
    enabled: studentId.length > 0,
  });

  const checkout = useStartAiCheckout();

  if (!studentId || !priceId) {
    return (
      <>
        <h1>{t("site.billing.ai.title")}</h1>
        <p role="alert" className="billing-overview__notice">
          {t("site.billing.ai.missingParams")}
        </p>
      </>
    );
  }

  const studentName = studentQuery.data ? studentDisplayName(studentQuery.data) : undefined;

  if (checkoutStatus === "success") {
    return (
      <>
        <h1>{t("site.billing.ai.successTitle")}</h1>
        <Card>
          <Card.Body>
            <p>
              {studentName
                ? t("site.billing.ai.activeFor", { name: studentName })
                : t("site.billing.ai.active")}
            </p>
            <p className="billing-overview__caption">{t("site.billing.ai.returnToApp")}</p>
          </Card.Body>
        </Card>
      </>
    );
  }

  function handleSubscribe() {
    checkout.mutate(
      {
        studentId,
        priceId,
        successUrl: buildReturnUrl("success", studentId, priceId),
        cancelUrl: buildReturnUrl("cancelled", studentId, priceId),
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
          show({
            variant: "error",
            title: t("site.billing.ai.checkoutError"),
            description: apiErrorMessage(error, t("site.common.tryAgain")),
          });
        },
      },
    );
  }

  return (
    <>
      <h1>{t("site.billing.ai.title")}</h1>
      <p className="ai-purchase__intro">
        {studentName
          ? t("site.billing.ai.introFor", { name: studentName })
          : t("site.billing.ai.intro")}
      </p>

      {checkoutStatus === "cancelled" && !schoolInactive ? (
        <div className="billing-banner" data-tone="neutral" role="status">
          <div>
            <p className="billing-banner__title">{t("site.billing.ai.cancelledTitle")}</p>
            <p className="billing-banner__body">{t("site.billing.ai.cancelledBody")}</p>
          </div>
        </div>
      ) : null}

      {studentQuery.isError ? (
        <p role="alert" className="billing-overview__notice">
          {t("site.billing.ai.studentNotFound")}
        </p>
      ) : schoolInactive ? (
        <div className="billing-banner" data-tone="warning" role="alert">
          <div>
            <p className="billing-banner__title">{t("site.billing.ai.blockedTitle")}</p>
            <p className="billing-banner__body">{t("site.billing.ai.blockedBody")}</p>
          </div>
        </div>
      ) : (
        <Card>
          <Card.Body>
            <p className="billing-overview__caption">
              {studentQuery.isPending
                ? t("site.billing.ai.loadingStudent")
                : t("site.billing.ai.confirmPrice")}
            </p>
            <div className="billing-overview__actions">
              <Button
                type="button"
                variant="primary"
                loading={checkout.isPending}
                disabled={studentQuery.isPending}
                onClick={handleSubscribe}
              >
                {t("site.billing.ai.subscribe")}
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}
    </>
  );
}
