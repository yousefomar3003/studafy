import { Button, Checkbox } from "@studafy/ui";

import { useTranslation } from "../../lib/i18n";

import type { StorageCard } from "./storage";

interface Props {
  cards: StorageCard[];
  loading: boolean;
  failed: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  alsoForRenewals: boolean;
  onAlsoForRenewals: (value: boolean) => void;
  onAddCard: () => void;
  addingCard: boolean;
  disabled: boolean;
}

/**
 * "Pay with": the school's saved cards (brand, last four, expiry; the renewal card first and chosen
 * by default) and a way to add a new one, like a store's payment sheet. Choosing a card pays this
 * charge only; making it the renewal card is a separate, unticked choice.
 */
export function StoragePayWith({
  cards,
  loading,
  failed,
  selected,
  onSelect,
  alsoForRenewals,
  onAlsoForRenewals,
  onAddCard,
  addingCard,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const chosen = cards.find((card) => card.id === selected) ?? null;

  const label = (card: StorageCard) =>
    t(
      card.last4
        ? "schoolLicense.storage.manage.cardValue"
        : "schoolLicense.storage.manage.methodValue",
      {
        brand: card.brand.charAt(0).toUpperCase() + card.brand.slice(1),
        last4: card.last4,
        month: String(card.expMonth ?? "").padStart(2, "0"),
        year: card.expYear,
      },
    );

  return (
    <fieldset className="storage-pay-with" disabled={disabled}>
      <legend>{t("schoolLicense.storage.payWith.title")}</legend>
      {loading ? (
        <p role="status">{t("schoolLicense.common.loading")}</p>
      ) : failed ? (
        <p role="alert">{t("schoolLicense.storage.payWith.loadError")}</p>
      ) : cards.length === 0 ? (
        <p className="license-muted">{t("schoolLicense.storage.payWith.none")}</p>
      ) : (
        cards.map((card) => (
          <label key={card.id} className="storage-pay-with__card">
            <input
              type="radio"
              name="storage-pay-with"
              value={card.id}
              checked={selected === card.id}
              onChange={() => onSelect(card.id)}
            />
            <span>{label(card)}</span>
            {card.isDefault ? (
              <span className="license-muted">
                {t("schoolLicense.storage.payWith.renewalCard")}
              </span>
            ) : null}
          </label>
        ))
      )}
      <Button type="button" variant="tertiary" loading={addingCard} onClick={onAddCard}>
        {t("schoolLicense.storage.payWith.addCard")}
      </Button>
      {chosen && !chosen.isDefault ? (
        <Checkbox
          label={t("schoolLicense.storage.payWith.alsoRenewals")}
          checked={alsoForRenewals}
          onChange={(event) => onAlsoForRenewals(event.target.checked)}
        />
      ) : null}
    </fieldset>
  );
}
