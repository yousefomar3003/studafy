/**
 * A school's storage add-on as the super admin sees it (platform console): the add-on and any change
 * scheduled for its renewal, its Stripe invoices with what each took and what was refunded, the
 * billing incidents recorded for it (000222), and a refund of one of its invoices.
 *
 * No transaction is held across a Stripe call: the row is read, Stripe is called, and the audit rows
 * are written afterwards. A refund carries an idempotency key from the console's request key, and the
 * invoice's refundable remainder is re-read from Stripe before every refund, so a double click or a
 * retry never refunds twice or more than was paid.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditLicenseChange, inSchool } from "../../licensing/context";
import { selectPaymentProviderForSchool } from "../payment-provider-routing";

import { describeStorageAddon } from "./storage-addon-service";

import type { StorageAddonCurrent } from "./storage-addon-service";
import type { Database } from "../../../db";
import type { LicenseActor } from "../../licensing/context";
import type { PaymentProviderRegistry, SelectedPaymentProvider } from "../payment-provider-routing";
import type { SubscriptionBillingSummary } from "../ports/payment-provider";
import type { SubscriptionStatus } from "@studafy/constants";

export interface StorageIncident {
  id: string;
  stripeInvoiceId: string;
  expectedMinor: number;
  chargedMinor: number;
  refundMinor: number;
  currency: string;
  stripeRefundId: string | null;
  status: "refunded" | "needs_review";
  lastError: string | null;
  createdAt: Date;
}

export interface PlatformStorageSubscription {
  subscription: (StorageAddonCurrent & { stripeSubscriptionId: string | null }) | null;
  billing: SubscriptionBillingSummary | null;
  /** Set when Stripe could not be read; the rest is still shown. */
  billingError: string | null;
  incidents: StorageIncident[];
}

interface Loaded {
  rowId: string | null;
  current: (StorageAddonCurrent & { stripeSubscriptionId: string | null }) | null;
  selected: SelectedPaymentProvider | null;
  incidents: StorageIncident[];
}

async function load(
  database: Database,
  providers: PaymentProviderRegistry,
  schoolId: string,
  actor: LicenseActor,
): Promise<Loaded> {
  return inSchool(database, schoolId, actor, async (tx) => {
    const [row] = await tx<
      {
        id: string;
        plan_price_id: string | null;
        cap_bytes: string;
        status: SubscriptionStatus;
        current_period_end: Date;
        cancel_at_period_end: boolean;
        stripe_subscription_id: string | null;
        pending_plan_price_id: string | null;
        pending_cap_bytes: string | null;
        pending_effective_at: Date | null;
        stripe_schedule_id: string | null;
      }[]
    >`
      SELECT id, plan_price_id, cap_bytes::text AS cap_bytes, status::text AS status,
             current_period_end, cancel_at_period_end, stripe_subscription_id,
             pending_plan_price_id, pending_cap_bytes::text AS pending_cap_bytes,
             pending_effective_at, stripe_schedule_id
      FROM app.storage_subscriptions
      WHERE school_id = ${schoolId}::uuid
    `;
    const incidents = await tx<
      {
        id: string;
        stripe_invoice_id: string;
        expected_minor: string;
        charged_minor: string;
        refund_minor: string;
        currency: string;
        stripe_refund_id: string | null;
        status: "refunded" | "needs_review";
        last_error: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, stripe_invoice_id, expected_minor::text AS expected_minor,
             charged_minor::text AS charged_minor, refund_minor::text AS refund_minor, currency,
             stripe_refund_id, status, last_error, created_at
      FROM app.storage_billing_incidents
      WHERE school_id = ${schoolId}::uuid
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const selected: SelectedPaymentProvider | null = await selectPaymentProviderForSchool(
      tx,
      providers,
      schoolId,
    ).catch(() => null);

    return {
      rowId: row?.id ?? null,
      current: row
        ? {
            ...(await describeStorageAddon(tx, row)),
            stripeSubscriptionId: row.stripe_subscription_id,
          }
        : null,
      selected: selected?.name === "stripe" ? selected : null,
      incidents: incidents.map((incident) => ({
        id: incident.id,
        stripeInvoiceId: incident.stripe_invoice_id,
        expectedMinor: Number(incident.expected_minor),
        chargedMinor: Number(incident.charged_minor),
        refundMinor: Number(incident.refund_minor),
        currency: incident.currency,
        stripeRefundId: incident.stripe_refund_id,
        status: incident.status,
        lastError: incident.last_error,
        createdAt: incident.created_at,
      })),
    };
  });
}

async function readBilling(
  loaded: Loaded,
): Promise<{ billing: SubscriptionBillingSummary | null; error: string | null }> {
  const subscriptionId = loaded.current?.stripeSubscriptionId;
  const describe = loaded.selected?.port.describeSubscriptionBilling;
  if (!subscriptionId || !describe || !loaded.selected) return { billing: null, error: null };
  try {
    return {
      billing: await describe.call(loaded.selected.port, subscriptionId),
      error: null,
    };
  } catch (caught) {
    return {
      billing: null,
      error: (caught instanceof Error ? caught.message : String(caught)).slice(0, 300),
    };
  }
}

export async function getPlatformStorageSubscription(
  database: Database,
  providers: PaymentProviderRegistry,
  schoolId: string,
  actor: LicenseActor,
): Promise<PlatformStorageSubscription> {
  const loaded = await load(database, providers, schoolId, actor);
  const { billing, error } = await readBilling(loaded);
  return {
    subscription: loaded.current,
    billing,
    billingError: error,
    incidents: loaded.incidents,
  };
}

function refundInvalid(message: string): CodedHttpException {
  return new CodedHttpException(422, ERROR_CODES.STORAGE_ADDON_REFUND_INVALID, message);
}

/**
 * Refund one of the school's storage invoices, fully or in part. The invoice must belong to the
 * school's storage subscription, and the amount must not exceed what it took less what was already
 * refunded -- both re-read from Stripe now.
 */
export async function refundPlatformStorageInvoice(
  database: Database,
  providers: PaymentProviderRegistry,
  params: {
    schoolId: string;
    invoiceId: string;
    amountMinor: number;
    reason: string;
    requestKey: string;
    actor: LicenseActor;
  },
): Promise<{ refundId: string; status: "succeeded" | "pending"; amountMinor: number }> {
  const { schoolId, invoiceId, amountMinor, reason, requestKey, actor } = params;
  const loaded = await load(database, providers, schoolId, actor);
  if (!loaded.rowId || !loaded.current?.stripeSubscriptionId || !loaded.selected) {
    throw refundInvalid("The school has no storage subscription at Stripe");
  }
  const { billing, error } = await readBilling(loaded);
  if (!billing) throw refundInvalid(error ?? "The storage invoices could not be read");

  const invoice = billing.invoices.find((candidate) => candidate.id === invoiceId);
  if (!invoice) throw refundInvalid("Not one of this school's storage invoices");
  const refundable = invoice.amountPaidMinor - invoice.amountRefundedMinor;
  if (amountMinor <= 0 || amountMinor > refundable) {
    throw refundInvalid(`At most ${refundable} can be refunded on this invoice`);
  }

  const refund = await loaded.selected.port.refund({
    invoiceId,
    amountMinor,
    currency: invoice.currency,
    idempotencyKey: `storage-admin-refund:${invoiceId}:${requestKey}`,
    metadata: {
      school_id: schoolId,
      reason: reason.slice(0, 400),
      refunded_by: actor.userId,
      source: "platform_storage_refund",
    },
  });

  const rowId = loaded.rowId;
  await inSchool(database, schoolId, actor, (tx) =>
    auditLicenseChange(tx, schoolId, actor, {
      action: "update",
      targetTable: "storage_subscriptions",
      targetId: rowId,
      newValues: {
        refund: {
          stripe_invoice_id: invoiceId,
          stripe_refund_id: refund.providerRefundId,
          amount_minor: amountMinor,
          currency: invoice.currency,
          reason,
        },
      },
    }),
  );

  return { refundId: refund.providerRefundId, status: refund.status, amountMinor };
}
