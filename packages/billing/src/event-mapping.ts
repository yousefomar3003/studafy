/**
 * Pure readers over a Stripe event's `data.object` (ST-132).
 *
 * Everything here is total and side-effect free: given an arbitrary JSON object, return the field or
 * `null`. That matters because the input is genuinely arbitrary. The signature proves the bytes came
 * from Stripe; it proves nothing about their shape, and Stripe reshapes objects across API versions
 * without asking. So each reader accepts the several shapes the same fact has worn rather than
 * indexing blindly and throwing a TypeError deep inside a transaction.
 *
 * Separated from the processor so the shape-handling can be unit-tested against captured payloads
 * without a database.
 */

/** Narrow an unknown to a non-empty string, which is the only kind of id worth returning. */
function asId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The Stripe customer this event concerns.
 *
 * Present on every object the processor cares about -- subscription, invoice, checkout session --
 * and it is the attribution key, because `app.schools.stripe_customer_id` is readable without a
 * tenant context (schools is one of the six global, non-RLS tables) while every subscription table
 * is not. Resolving the school first is what makes the rest of the lookup possible at all.
 *
 * Expanded objects arrive as `{ id: "cus_..." }` rather than as a bare string, so both are read.
 */
export function extractCustomerId(payload: Record<string, unknown>): string | null {
  const direct = asId(payload.customer);
  if (direct) return direct;

  const expanded = asRecord(payload.customer);
  return expanded ? asId(expanded.id) : null;
}

/**
 * The Stripe subscription this event concerns.
 *
 * Four shapes, in descending order of directness:
 *
 *   1. The object *is* the subscription (`customer.subscription.*`), so its own `id` is the answer.
 *   2. A bare `subscription` string -- checkout sessions, and invoices on older API versions.
 *   3. An expanded `subscription` object.
 *   4. `parent.subscription_details.subscription` -- where the 2025+ invoice API moved it when
 *      `Invoice.subscription` was removed. Omitting this would make every renewal invoice on the
 *      pinned API version (2026-07-29) unattributable, which is not a hypothetical.
 */
export function extractSubscriptionId(payload: Record<string, unknown>): string | null {
  const own = asId(payload.id);
  if (own?.startsWith("sub_")) return own;

  const direct = asId(payload.subscription);
  if (direct) return direct;

  const expanded = asRecord(payload.subscription);
  if (expanded) {
    const id = asId(expanded.id);
    if (id) return id;
  }

  const parentDetails = asRecord(asRecord(payload.parent)?.subscription_details);
  const fromParent = asId(parentDetails?.subscription);
  if (fromParent) return fromParent;

  const expandedParent = asRecord(parentDetails?.subscription);
  return expandedParent ? asId(expandedParent.id) : null;
}

/**
 * Metadata as Studafy set it at Checkout, wherever this event carries it.
 *
 * Checkout sessions carry `metadata` directly and pass it to the subscription via
 * `subscription_data.metadata` (see createCheckoutSession in the adapter), so subscription events
 * carry it too. Invoices carry it one level down, under the same `parent.subscription_details` the
 * subscription id moved into.
 */
export function extractMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const direct = asRecord(payload.metadata);
  if (direct && Object.keys(direct).length > 0) return direct;

  const parentDetails = asRecord(asRecord(payload.parent)?.subscription_details);
  return asRecord(parentDetails?.metadata) ?? direct ?? {};
}

export function extractSchoolIdHint(payload: Record<string, unknown>): string | null {
  return asId(extractMetadata(payload).school_id);
}

export function extractStudentIdHint(payload: Record<string, unknown>): string | null {
  return asId(extractMetadata(payload).student_id);
}

/**
 * The billing period this event reports, if it reports one.
 *
 * Stripe sends Unix *seconds*; the ×1000 is what puts the result in this century. Returns `null`
 * unless both ends are present and well-ordered -- `ck_subscriptions_period` requires
 * `current_period_end > current_period_start`, and a half-period or an inverted one would abort the
 * transaction that is applying an otherwise-correct status change. A missing period is not an
 * error; it just means this event says nothing about dates and the existing ones stand.
 *
 * `current_period_*` lives on the subscription object; the invoice equivalent is `period_*`, and on
 * the 2025+ API the authoritative pair is on the invoice's first line item.
 */
export function extractPeriod(payload: Record<string, unknown>): { start: Date; end: Date } | null {
  const lineItems = asRecord(payload.lines)?.data;
  const firstLine = Array.isArray(lineItems) ? asRecord(lineItems[0]) : null;
  const linePeriod = asRecord(firstLine?.period);

  const startSeconds = firstNumber([
    payload.current_period_start,
    payload.period_start,
    linePeriod?.start,
  ]);
  const endSeconds = firstNumber([payload.current_period_end, payload.period_end, linePeriod?.end]);

  if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) return null;

  return { start: new Date(startSeconds * 1000), end: new Date(endSeconds * 1000) };
}

function firstNumber(candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * The subscription item id, used by ST-135's seat reconciliation to change quantity.
 *
 * Read here rather than there because this is the only place the raw payload is in hand.
 */
export function extractSubscriptionItemId(payload: Record<string, unknown>): string | null {
  const items = asRecord(payload.items)?.data;
  if (!Array.isArray(items)) return null;
  return asId(asRecord(items[0])?.id);
}
