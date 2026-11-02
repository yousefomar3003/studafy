import type { FamilyBalance } from "./queries";
import type { TFunction } from "i18next";

/**
 * One line per currency. A family's money is never summed across currencies, so a household billed
 * in two shows two lines rather than one meaningless total.
 */
export function MoneyLines({
  balances,
  field,
}: {
  balances: readonly FamilyBalance[];
  field: "billed" | "outstanding" | "overdue";
}) {
  const lines = balances.filter((balance) => balance[`${field}_minor`] > 0);
  if (lines.length === 0) return <>—</>;
  return (
    <span className="families-money">
      {lines.map((balance) => (
        <span key={balance.currency}>
          {balance[field]} {balance.currency}
        </span>
      ))}
    </span>
  );
}

/** The same lines as text, for places that take a string: "2130.000 JOD + 50.00 AED", or "—". */
export function moneyText(
  balances: readonly FamilyBalance[],
  field: "billed" | "outstanding" | "overdue",
): string {
  const lines = balances.filter((balance) => balance[`${field}_minor`] > 0);
  if (lines.length === 0) return "—";
  return lines.map((balance) => `${balance[field]} ${balance.currency}`).join(" + ");
}

/** "Eldest", "2nd child", "3rd child", "Child 5". */
export function childPositionLabel(t: TFunction, position: number | null): string {
  if (position === null) return t("finance.families.position.notEnrolled");
  if (position === 1) return t("finance.families.position.eldest");
  if (position === 2) return t("finance.families.position.second");
  if (position === 3) return t("finance.families.position.third");
  return t("finance.families.position.nth", { position });
}
