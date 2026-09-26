/**
 * What a provider payment is for, stamped as `metadata.purpose` on one-time payments (ST-298).
 *
 * Subscription charges carry a Stripe-style `billing_reason` instead and flow into the billing
 * state machine. A payment carrying one of these purposes is routed away from that state machine by
 * the webhook processor before it can be read as a subscription payment -- a paid tuition fee must
 * never activate a plan.
 */
export const PAYMENT_PURPOSES = {
  FEE_PAYMENT: "fee_payment",
} as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[keyof typeof PAYMENT_PURPOSES];
