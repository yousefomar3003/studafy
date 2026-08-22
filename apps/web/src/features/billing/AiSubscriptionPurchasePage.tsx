import { ApiError } from "@studafy/api-client";
import { Button, Card, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

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
        <h1>AI Study Assistant</h1>
        <p role="alert" className="billing-overview__notice">
          This link is missing some information and can&rsquo;t be opened here. Go back to the
          Studafy app and try again.
        </p>
      </>
    );
  }

  const studentName = studentQuery.data ? studentDisplayName(studentQuery.data) : undefined;

  if (checkoutStatus === "success") {
    return (
      <>
        <h1>You&rsquo;re all set</h1>
        <Card>
          <Card.Body>
            <p>
              The AI Study Assistant add-on is now active
              {studentName ? ` for ${studentName}` : ""}.
            </p>
            <p className="billing-overview__caption">
              Return to the Studafy app on your phone to start using it.
            </p>
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
            title: "Couldn't start checkout",
            description: apiErrorMessage(error, "Please try again."),
          });
        },
      },
    );
  }

  return (
    <>
      <h1>AI Study Assistant</h1>
      <p className="ai-purchase__intro">
        A personal AI tutor for {studentName ?? "your student"} — ask-anything homework help,
        practice quizzes and flashcards, and study-material summaries. Billed separately from the
        school&rsquo;s own Studafy subscription, per student.
      </p>

      {checkoutStatus === "cancelled" && !schoolInactive ? (
        <div className="billing-banner" data-tone="neutral" role="status">
          <div>
            <p className="billing-banner__title">Checkout cancelled</p>
            <p className="billing-banner__body">No charge was made. You can try again below.</p>
          </div>
        </div>
      ) : null}

      {studentQuery.isError ? (
        <p role="alert" className="billing-overview__notice">
          We couldn&rsquo;t find this student on your account. Go back to the Studafy app and try
          the link again.
        </p>
      ) : schoolInactive ? (
        <div className="billing-banner" data-tone="warning" role="alert">
          <div>
            <p className="billing-banner__title">Purchase blocked</p>
            <p className="billing-banner__body">
              Your school&rsquo;s Studafy subscription isn&rsquo;t active right now, so the AI
              add-on can&rsquo;t be purchased. Contact your school to reactivate it, then come back
              to this link.
            </p>
          </div>
        </div>
      ) : (
        <Card>
          <Card.Body>
            <p className="billing-overview__caption">
              {studentQuery.isPending
                ? "Loading student details…"
                : `You'll confirm the exact price on the next, secure step.`}
            </p>
            <div className="billing-overview__actions">
              <Button
                type="button"
                variant="primary"
                loading={checkout.isPending}
                disabled={studentQuery.isPending}
                onClick={handleSubscribe}
              >
                Subscribe
              </Button>
            </div>
          </Card.Body>
        </Card>
      )}
    </>
  );
}
