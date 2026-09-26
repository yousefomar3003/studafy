/**
 * The slice of Tap Payments API v2 objects Studafy reads.
 *
 * Deliberately partial: Tap returns far more, and modelling fields nothing reads would be a promise
 * about their shape nobody keeps. Everything is optional because the objects arrive from the network
 * and a reader must cope with any field being absent.
 */

export interface TapCharge {
  id?: string;
  object?: string;
  live_mode?: boolean;
  status?: string;
  amount?: number;
  currency?: string;
  customer?: { id?: string };
  metadata?: Record<string, unknown>;
  reference?: { gateway?: string; payment?: string };
  transaction?: { url?: string; created?: string | number };
  /** The saved card, present when the charge was made with `save_card: true` or from a saved card. */
  card?: { id?: string };
  /** The recurring-payment agreement a saved card is charged under. */
  payment_agreement?: { id?: string };
}

/** A hosted, customer-initiated charge: the payer enters payment details on Tap's page. */
export interface CreateHostedChargeInput {
  amountMinor: number;
  currency: string;
  customerId: string;
  description: string;
  metadata: Record<string, string>;
  /** Where Tap posts status changes. */
  webhookUrl: string;
  /** Where Tap sends the payer afterwards, with `tap_id` appended, whatever the outcome. */
  redirectUrl: string;
  /** Save the card for later merchant-initiated charges (subscription renewals). */
  saveCard: boolean;
  /** Our own reference, echoed back by Tap. */
  orderReference?: string;
}

/** A merchant-initiated charge against a saved card, with no payer present. */
export interface CreateSavedCardChargeInput {
  amountMinor: number;
  currency: string;
  customerId: string;
  cardId: string;
  paymentAgreementId: string;
  description: string;
  metadata: Record<string, string>;
  webhookUrl: string;
  orderReference?: string;
}

export interface ListChargesInput {
  customerId: string;
  limit: number;
  startingAfter?: string;
}

export interface ListChargesResult {
  charges: TapCharge[];
  hasMore: boolean;
}
