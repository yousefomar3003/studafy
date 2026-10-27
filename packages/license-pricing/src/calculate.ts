import {
  applyBps,
  BPS_SCALE,
  DAYS_PER_YEAR,
  divideHalfUp,
  MONTHS_PER_YEAR,
  toSafeNumber,
} from "./money";
import { AUDIENCES, PricingError } from "./types";

import type {
  AdjustmentLine,
  Audience,
  CreditLine,
  DurationDiscount,
  NextVolumeBracket,
  PriceSettings,
  PricingInput,
  PricingLine,
  PricingResult,
  SeatInput,
  SeatLine,
  VolumeBracket,
} from "./types";

/** The longest term a quote prices, in months. */
export const MAX_MONTHS = 120;
/** The longest prorated period, in days. */
export const MAX_PRORATE_DAYS = 3_660;

const isWholeNumber = (value: number, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const isBps = (value: number): boolean => isWholeNumber(value, 0, BPS_SCALE);

/** Refuse settings a super admin could not have meant: overlapping or out-of-range brackets. */
export function validatePriceSettings(settings: PriceSettings): void {
  const seen = new Set<string>();
  for (const bracket of settings.volumeBrackets) {
    const key = `${bracket.audience ?? "*"}:${bracket.minSeats}`;
    if (!isWholeNumber(bracket.minSeats, 1) || !isBps(bracket.discountBps) || seen.has(key)) {
      throw new PricingError("invalid_bracket", `invalid volume bracket ${key}`);
    }
    if (bracket.audience !== null && !AUDIENCES.includes(bracket.audience)) {
      throw new PricingError("invalid_bracket", `unknown audience ${String(bracket.audience)}`);
    }
    seen.add(key);
  }
  const months = new Set<number>();
  for (const discount of settings.durationDiscounts) {
    if (
      !isWholeNumber(discount.minMonths, 1, MAX_MONTHS) ||
      !isBps(discount.discountBps) ||
      months.has(discount.minMonths)
    ) {
      throw new PricingError("invalid_bracket", `invalid duration discount ${discount.minMonths}`);
    }
    months.add(discount.minMonths);
  }
}

/**
 * The brackets that apply to an audience: its own if it has any, else the ones for every audience.
 * Sorted by seat threshold.
 */
function bracketsFor(brackets: readonly VolumeBracket[], audience: Audience): VolumeBracket[] {
  const own = brackets.filter((b) => b.audience === audience);
  const chosen = own.length > 0 ? own : brackets.filter((b) => b.audience === null);
  return [...chosen].sort((a, b) => a.minSeats - b.minSeats);
}

/** The bracket a seat count falls in (the highest threshold at or below it), and the next one up. */
export function volumeBracketFor(
  brackets: readonly VolumeBracket[],
  audience: Audience,
  seatCount: number,
): { current: VolumeBracket | null; next: VolumeBracket | null } {
  const sorted = bracketsFor(brackets, audience);
  let current: VolumeBracket | null = null;
  let next: VolumeBracket | null = null;
  for (const bracket of sorted) {
    if (bracket.minSeats <= seatCount) current = bracket;
    else if (next === null) next = bracket;
  }
  // A bracket at the same rate as the current one is not a better offer; look past it.
  while (next !== null && next.discountBps <= (current?.discountBps ?? 0)) {
    const after: VolumeBracket | undefined = sorted.find((b) => b.minSeats > next!.minSeats);
    next = after ?? null;
  }
  return { current, next };
}

/** The duration discount for a term: the highest threshold at or below it. */
export function durationDiscountFor(
  discounts: readonly DurationDiscount[],
  months: number,
): DurationDiscount | null {
  let best: DurationDiscount | null = null;
  for (const discount of discounts) {
    if (discount.minMonths <= months && (best === null || discount.minMonths > best.minMonths)) {
      best = discount;
    }
  }
  return best;
}

/** Volume, then duration on what is left: the two discounts compound. */
function discounted(listMinor: bigint, volumeBps: number, durationBps: number) {
  const volume = applyBps(listMinor, volumeBps);
  const duration = applyBps(listMinor - volume, durationBps);
  return { volume, duration, net: listMinor - volume - duration };
}

function validateInput(input: PricingInput): void {
  if (!isWholeNumber(input.months, 1, MAX_MONTHS)) {
    throw new PricingError("invalid_months", `months must be 1-${MAX_MONTHS}`);
  }
  if (
    input.prorateDays !== undefined &&
    input.prorateDays !== null &&
    !isWholeNumber(input.prorateDays, 1, MAX_PRORATE_DAYS)
  ) {
    throw new PricingError("invalid_prorate_days", `prorateDays must be 1-${MAX_PRORATE_DAYS}`);
  }
  validatePriceSettings(input.settings);

  const audiences = new Set<Audience>();
  for (const seat of input.seats) {
    if (!AUDIENCES.includes(seat.audience) || audiences.has(seat.audience)) {
      throw new PricingError("duplicate_audience", `one line per audience (${seat.audience})`);
    }
    audiences.add(seat.audience);
    if (!isWholeNumber(seat.seats, 0) || !isWholeNumber(seat.volumeSeats ?? seat.seats, 0)) {
      throw new PricingError("invalid_seats", `invalid seat count for ${seat.audience}`);
    }
    if (!isWholeNumber(seat.listPricePerSeatMonthMinor, 0)) {
      throw new PricingError("invalid_price", `invalid list price for ${seat.audience}`);
    }
    if (seat.audience === "parent" && seat.seats > 0 && !input.includeFamilyPlus) {
      throw new PricingError("family_plus_not_included", "parent seats need Family+");
    }
  }

  for (const credit of input.credits ?? []) {
    if (!isWholeNumber(credit.amountMinor, 0)) {
      throw new PricingError("invalid_credit", `invalid credit ${credit.reference}`);
    }
  }

  const adjustment = input.adjustment;
  if (adjustment) {
    if (!Number.isSafeInteger(adjustment.amountMinor)) {
      throw new PricingError(
        "invalid_price",
        "the adjustment must be a whole number of minor units",
      );
    }
    if (adjustment.amountMinor !== 0 && adjustment.reason.trim() === "") {
      throw new PricingError("adjustment_reason_required", "an adjustment needs a reason");
    }
  }
}

function seatLine(
  seat: SeatInput,
  input: PricingInput,
  overallSeats: number,
  durationBps: number,
): SeatLine {
  const prorateDays = input.prorateDays ?? null;
  const volumeSeats = seat.volumeSeats ?? seat.seats;
  const bracketCount = input.settings.volumeBasis === "overall" ? overallSeats : volumeSeats;
  const { current, next } = volumeBracketFor(
    input.settings.volumeBrackets,
    seat.audience,
    bracketCount,
  );
  const volumeBps = current?.discountBps ?? 0;

  const price = BigInt(seat.listPricePerSeatMonthMinor);
  const seats = BigInt(seat.seats);
  // Months are charged exactly; days at the session-2 daily rate, monthly x 12 / 365.
  const list =
    prorateDays === null
      ? price * seats * BigInt(input.months)
      : divideHalfUp(
          price * seats * BigInt(prorateDays) * BigInt(MONTHS_PER_YEAR),
          BigInt(DAYS_PER_YEAR),
        );
  const { volume, duration, net } = discounted(list, volumeBps, durationBps);

  // Price per seat-month after discounts = net / (seats x period in months).
  const perSeatMonth =
    prorateDays === null
      ? divideHalfUp(net, seats * BigInt(input.months))
      : divideHalfUp(
          net * BigInt(DAYS_PER_YEAR),
          seats * BigInt(prorateDays) * BigInt(MONTHS_PER_YEAR),
        );

  let nextVolumeBracket: NextVolumeBracket | null = null;
  if (next) {
    nextVolumeBracket = {
      minSeats: next.minSeats,
      discountBps: next.discountBps,
      seatsToAdd: next.minSeats - bracketCount,
      pricePerSeatMonthMinor: toSafeNumber(discounted(price, next.discountBps, durationBps).net),
    };
  }

  return {
    kind: "seats",
    audience: seat.audience,
    tierCode: seat.tierCode,
    tierName: seat.tierName,
    seats: seat.seats,
    volumeSeats,
    months: input.months,
    prorateDays,
    listPricePerSeatMonthMinor: seat.listPricePerSeatMonthMinor,
    listAmountMinor: toSafeNumber(list),
    volumeDiscountBps: volumeBps,
    volumeDiscountMinor: toSafeNumber(volume),
    durationDiscountBps: durationBps,
    durationDiscountMinor: toSafeNumber(duration),
    amountMinor: toSafeNumber(net),
    pricePerSeatMonthMinor: toSafeNumber(perSeatMonth),
    savingsMinor: toSafeNumber(list - net),
    nextVolumeBracket,
  };
}

/**
 * Price a license (or a change to one). Pure: the same input always gives the same result, so a
 * stored quote can be recomputed and the console can preview without saving.
 *
 * Order of operations, each step rounded half up to a whole minor unit:
 *
 *  1. per audience, list amount = list price x seats x months (or x days x 12 / 365 when prorated);
 *  2. volume discount = list amount x volume bps;
 *  3. duration discount = (list amount - volume discount) x duration bps;
 *  4. line amount = list amount - both discounts;
 *  5. credits come off the seats subtotal, in order, never taking it below zero;
 *  6. the adjustment is added (it may be negative), and the total must not be negative.
 */
export function calculateLicensePrice(input: PricingInput): PricingResult {
  validateInput(input);

  const charged = input.seats.filter((seat) => seat.seats > 0);
  // Every audience counts toward the overall basis, including one with no seats charged this time
  // (a seat increase for students is discounted at the license's students and teachers together).
  const overallSeats = input.seats.reduce((sum, seat) => sum + (seat.volumeSeats ?? seat.seats), 0);
  const durationBps =
    durationDiscountFor(input.settings.durationDiscounts, input.months)?.discountBps ?? 0;

  const order = (audience: Audience) => AUDIENCES.indexOf(audience);
  const seatLines = [...charged]
    .sort((a, b) => order(a.audience) - order(b.audience))
    .map((seat) => seatLine(seat, input, overallSeats, durationBps));

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const listTotal = sum(seatLines.map((line) => line.listAmountMinor));
  const seatsSubtotal = sum(seatLines.map((line) => line.amountMinor));
  const discountTotal = listTotal - seatsSubtotal;

  let creditRoom = seatsSubtotal;
  const creditLines: CreditLine[] = (input.credits ?? []).map((credit) => {
    const applied = Math.min(credit.amountMinor, creditRoom);
    creditRoom -= applied;
    return {
      kind: "overlap_credit",
      reference: credit.reference,
      description: credit.description,
      creditMinor: credit.amountMinor,
      // 0, not -0, for a credit the seats had no room left for.
      amountMinor: applied === 0 ? 0 : -applied,
    };
  });
  const creditTotal = -sum(creditLines.map((line) => line.amountMinor));

  const adjustmentMinor = input.adjustment?.amountMinor ?? 0;
  const adjustmentLines: AdjustmentLine[] =
    adjustmentMinor !== 0
      ? [
          {
            kind: "adjustment",
            reason: input.adjustment!.reason.trim(),
            amountMinor: adjustmentMinor,
          },
        ]
      : [];

  const total = seatsSubtotal - creditTotal + adjustmentMinor;
  if (total < 0) {
    throw new PricingError("total_negative", "the adjustment takes the total below zero");
  }

  const lines: PricingLine[] = [...seatLines, ...creditLines, ...adjustmentLines];
  return {
    currencyCode: input.currencyCode,
    months: input.months,
    prorateDays: input.prorateDays ?? null,
    lines,
    listTotalMinor: listTotal,
    discountTotalMinor: discountTotal,
    seatsSubtotalMinor: seatsSubtotal,
    creditTotalMinor: creditTotal,
    adjustmentMinor,
    totalMinor: total,
    savingsMinor: discountTotal,
    savingsBps:
      listTotal === 0
        ? 0
        : toSafeNumber(divideHalfUp(BigInt(discountTotal) * BigInt(BPS_SCALE), BigInt(listTotal))),
  };
}
