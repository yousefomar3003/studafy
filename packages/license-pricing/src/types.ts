/** Who a seat is for. Parent seats are Family+ and exist only on a license that includes it. */
export const AUDIENCES = ["student", "teacher", "parent"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Basis points: 10_000 is 100%. Every discount is a whole number of basis points. */
export type Bps = number;

/**
 * A volume discount: from `minSeats` seats up, `discountBps` off. A bracket with an `audience`
 * applies to that audience only; one with `audience: null` applies to every audience that has no
 * brackets of its own.
 */
export interface VolumeBracket {
  audience: Audience | null;
  minSeats: number;
  discountBps: Bps;
}

/** A duration discount: a term of `minMonths` months or more gets `discountBps` off. */
export interface DurationDiscount {
  minMonths: number;
  discountBps: Bps;
}

/**
 * Which seat count picks a volume bracket: each audience's own (`per_audience`) or the license's
 * total across audiences (`overall`).
 */
export type VolumeBasis = "per_audience" | "overall";

export interface PriceSettings {
  volumeBasis: VolumeBasis;
  volumeBrackets: readonly VolumeBracket[];
  durationDiscounts: readonly DurationDiscount[];
}

export interface SeatInput {
  audience: Audience;
  tierCode: string;
  tierName: string;
  /** Seats charged on this quote. Zero seats produce no line. */
  seats: number;
  /** The tier's list price per seat per month, in minor units of the quote currency. */
  listPricePerSeatMonthMinor: number;
  /**
   * The seat count that picks the volume bracket, when it differs from `seats`: a seat increase is
   * charged for the added seats but discounted at the license's new total. Defaults to `seats`.
   */
  volumeSeats?: number;
}

/** An amount the school is owed (an overlap credit), taken off the seats. */
export interface CreditInput {
  /** The caller's id for it (an overlap row), carried to the line. */
  reference: string;
  description: string;
  amountMinor: number;
}

/** A manual change to the total, up or down, with a mandatory reason. */
export interface Adjustment {
  amountMinor: number;
  reason: string;
}

export interface PricingInput {
  currencyCode: string;
  /** The term in whole months. Picks the duration discount. */
  months: number;
  /**
   * When set, seats are charged for this many days instead of `months` months: the remaining part
   * of a term, for a seat increase. The duration discount is still the one for `months`.
   */
  prorateDays?: number | null;
  includeFamilyPlus: boolean;
  seats: readonly SeatInput[];
  settings: PriceSettings;
  credits?: readonly CreditInput[];
  adjustment?: Adjustment | null;
}

/** The next volume bracket up: what the school would pay per seat with more seats. */
export interface NextVolumeBracket {
  minSeats: number;
  discountBps: Bps;
  /** Seats to add (to this audience, or to the license for the `overall` basis) to reach it. */
  seatsToAdd: number;
  /** The price per seat per month, after every discount, at that bracket. */
  pricePerSeatMonthMinor: number;
}

export interface SeatLine {
  kind: "seats";
  audience: Audience;
  tierCode: string;
  tierName: string;
  seats: number;
  /** The seat count that picked the volume bracket. */
  volumeSeats: number;
  months: number;
  prorateDays: number | null;
  /** Price per seat per month before discounts (the list price). */
  listPricePerSeatMonthMinor: number;
  /** List price x seats x period. */
  listAmountMinor: number;
  volumeDiscountBps: Bps;
  volumeDiscountMinor: number;
  durationDiscountBps: Bps;
  durationDiscountMinor: number;
  /** What this line costs: list amount less both discounts. */
  amountMinor: number;
  /** Price per seat per month after discounts. Display only: `amountMinor` is what is charged. */
  pricePerSeatMonthMinor: number;
  /** List amount less what is charged. */
  savingsMinor: number;
  nextVolumeBracket: NextVolumeBracket | null;
}

export interface CreditLine {
  kind: "overlap_credit";
  reference: string;
  description: string;
  /** What the credit is worth. */
  creditMinor: number;
  /** What is taken off: negative, and smaller than `creditMinor` only when the seats run out. */
  amountMinor: number;
}

export interface AdjustmentLine {
  kind: "adjustment";
  reason: string;
  amountMinor: number;
}

export type PricingLine = SeatLine | CreditLine | AdjustmentLine;

export interface PricingResult {
  currencyCode: string;
  months: number;
  prorateDays: number | null;
  lines: PricingLine[];
  /** Every seat line at list price. */
  listTotalMinor: number;
  /** Volume and duration discounts together. */
  discountTotalMinor: number;
  /** Seat lines after discounts. */
  seatsSubtotalMinor: number;
  /** Credits taken off (positive). */
  creditTotalMinor: number;
  adjustmentMinor: number;
  /** What the school pays. Never negative. */
  totalMinor: number;
  /** "You save X compared with list price": the volume and duration discounts. */
  savingsMinor: number;
  /** The savings as basis points of the list total (0 when the list total is 0). */
  savingsBps: Bps;
}

export type PricingErrorCode =
  | "invalid_months"
  | "invalid_prorate_days"
  | "invalid_seats"
  | "invalid_price"
  | "duplicate_audience"
  | "family_plus_not_included"
  | "invalid_bracket"
  | "invalid_credit"
  | "adjustment_reason_required"
  | "total_negative";

export class PricingError extends Error {
  readonly code: PricingErrorCode;

  constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.name = "PricingError";
    this.code = code;
  }
}
