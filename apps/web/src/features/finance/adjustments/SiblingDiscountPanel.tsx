import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, Checkbox, Input, Modal, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { childPositionLabel } from "../families/family-format";
import {
  fetchSiblingDiscountRule,
  SIBLING_DISCOUNT_KEY,
  useSaveSiblingDiscountRule,
} from "../families/queries";

import type { SiblingDiscountRule } from "../families/queries";
import type { TFunction } from "i18next";

const MAX_TIERS = 10;

/** "2nd child: 10% · 3rd child and later: 15%". */
function tiersSummary(t: TFunction, rule: SiblingDiscountRule): string {
  const tiers = [...rule.tiers].sort((a, b) => a.child_position - b.child_position);
  return tiers
    .map((tier, index) =>
      t(
        index === tiers.length - 1
          ? "financeReports.adjustments.siblingDiscount.tierAndLater"
          : "financeReports.adjustments.siblingDiscount.tier",
        { position: childPositionLabel(t, tier.child_position), percentage: tier.percentage },
      ),
    )
    .join(" · ");
}

/**
 * The school's automatic sibling discount, on the scholarships page because it is the same kind of
 * thing: a reduction the billing worker applies to every invoice it generates, adding up with a
 * student's approved scholarships. Everyone with `billing:read` sees the rule and how many children
 * it reaches; changing it is the school admin's sign-off (`billing:approveScholarship`), the same as
 * approving an award.
 */
export function SiblingDiscountPanel() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const permissions = usePermissions();
  const canEdit = permissions.has(PERMISSIONS.BILLING_APPROVE_SCHOLARSHIP);
  const [editing, setEditing] = useState(false);

  const query = useQuery({ queryKey: SIBLING_DISCOUNT_KEY, queryFn: fetchSiblingDiscountRule });
  const rule = query.data;

  return (
    <Card as="section" aria-labelledby="sibling-discount-heading">
      <Card.Header>
        <div className="adjustments-list__header adjustments-sibling__header">
          <div>
            <h2 id="sibling-discount-heading">
              {t("financeReports.adjustments.siblingDiscount.title")}
            </h2>
            <p>{t("financeReports.adjustments.siblingDiscount.description")}</p>
          </div>
          {canEdit && rule ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t(
                rule.configured
                  ? "financeReports.adjustments.siblingDiscount.edit"
                  : "financeReports.adjustments.siblingDiscount.setUp",
              )}
            </Button>
          ) : null}
        </div>
      </Card.Header>
      <Card.Body>
        {query.isPending ? (
          <p role="status">{t("finance.common.loading")}</p>
        ) : query.isError || !rule ? (
          <p role="alert">{t("financeReports.adjustments.siblingDiscount.loadError")}</p>
        ) : (
          <dl className="adjustments-sibling">
            <div>
              <dt>{t("financeReports.adjustments.common.status")}</dt>
              <dd>
                <span
                  className="adjustments-status-pill"
                  data-tone={rule.is_enabled ? "success" : undefined}
                >
                  {t(
                    rule.is_enabled
                      ? "financeReports.adjustments.siblingDiscount.on"
                      : "financeReports.adjustments.siblingDiscount.off",
                  )}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.siblingDiscount.tiers")}</dt>
              <dd>
                {rule.tiers.length > 0
                  ? tiersSummary(t, rule)
                  : t("financeReports.adjustments.siblingDiscount.noTiers")}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.siblingDiscount.appliesTo")}</dt>
              <dd>
                {rule.fee_category ?? t("financeReports.adjustments.siblingDiscount.allFees")}
              </dd>
            </div>
            <div>
              <dt>{t("financeReports.adjustments.siblingDiscount.reach")}</dt>
              <dd>
                {t("financeReports.adjustments.siblingDiscount.children", {
                  count: rule.discounted_children,
                })}
              </dd>
            </div>
            {rule.updated_at ? (
              <div>
                <dt>{t("financeReports.adjustments.siblingDiscount.updated")}</dt>
                <dd>
                  {formatDate(new Date(rule.updated_at))}
                  {rule.updated_by_name ? ` · ${rule.updated_by_name}` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
        )}
        {!canEdit ? (
          <p className="adjustments-form__math">
            {t("financeReports.adjustments.siblingDiscount.adminOnly")}
          </p>
        ) : null}
      </Card.Body>
      {editing && rule ? (
        <SiblingDiscountForm rule={rule} onClose={() => setEditing(false)} />
      ) : null}
    </Card>
  );
}

interface TierDraft {
  key: string;
  position: string;
  percentage: string;
}

function SiblingDiscountForm({
  rule,
  onClose,
}: {
  rule: SiblingDiscountRule;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveSiblingDiscountRule();
  const [enabled, setEnabled] = useState(rule.configured ? rule.is_enabled : true);
  const [feeCategory, setFeeCategory] = useState(rule.fee_category ?? "");
  const [tiers, setTiers] = useState<TierDraft[]>(
    rule.tiers.length > 0
      ? rule.tiers.map((tier) => ({
          key: crypto.randomUUID(),
          position: String(tier.child_position),
          percentage: String(tier.percentage),
        }))
      : // A sensible starting point to edit: second child 10%, third and later 15%.
        [
          { key: crypto.randomUUID(), position: "2", percentage: "10" },
          { key: crypto.randomUUID(), position: "3", percentage: "15" },
        ],
  );
  const [error, setError] = useState<string | null>(null);

  const parsed = tiers.map((tier) => ({
    child_position: Number(tier.position),
    percentage: Number(tier.percentage),
  }));
  const invalid =
    parsed.some(
      (tier) =>
        !Number.isInteger(tier.child_position) ||
        tier.child_position < 2 ||
        tier.child_position > 20 ||
        !(tier.percentage > 0 && tier.percentage <= 100),
    ) ||
    new Set(parsed.map((tier) => tier.child_position)).size !== parsed.length ||
    (enabled && parsed.length === 0);

  function update(key: string, change: Partial<TierDraft>) {
    setTiers((current) =>
      current.map((tier) => (tier.key === key ? { ...tier, ...change } : tier)),
    );
  }

  function submit() {
    if (invalid) {
      setError(t("financeReports.adjustments.siblingDiscount.invalid"));
      return;
    }
    save.mutate(
      {
        is_enabled: enabled,
        fee_category: feeCategory.trim() || null,
        tiers: parsed,
      },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("financeReports.adjustments.siblingDiscount.saved"),
          });
          onClose();
        },
        onError: () => setError(t("financeReports.adjustments.siblingDiscount.saveError")),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("financeReports.adjustments.siblingDiscount.formTitle")}
      description={t("financeReports.adjustments.siblingDiscount.formDescription")}
    >
      <Modal.Body>
        <div className="adjustments-form">
          <Checkbox
            label={t("financeReports.adjustments.siblingDiscount.enable")}
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <fieldset className="adjustments-tiers">
            <legend>{t("financeReports.adjustments.siblingDiscount.tiers")}</legend>
            {tiers.map((tier) => (
              <div key={tier.key} className="adjustments-tiers__row">
                <Input
                  label={t("financeReports.adjustments.siblingDiscount.fromChild")}
                  type="number"
                  min={2}
                  max={20}
                  value={tier.position}
                  onChange={(event) => update(tier.key, { position: event.target.value })}
                />
                <Input
                  label={t("financeReports.adjustments.siblingDiscount.percentage")}
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={tier.percentage}
                  suffix="%"
                  onChange={(event) => update(tier.key, { percentage: event.target.value })}
                />
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() =>
                    setTiers((current) => current.filter((row) => row.key !== tier.key))
                  }
                >
                  {t("financeReports.adjustments.siblingDiscount.removeTier")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              disabled={tiers.length >= MAX_TIERS}
              onClick={() =>
                setTiers((current) => [
                  ...current,
                  {
                    key: crypto.randomUUID(),
                    position: String(
                      Math.min(
                        20,
                        Math.max(1, ...current.map((row) => Number(row.position) || 1)) + 1,
                      ),
                    ),
                    percentage: "",
                  },
                ])
              }
            >
              {t("financeReports.adjustments.siblingDiscount.addTier")}
            </Button>
            <p className="adjustments-form__math">
              {t("financeReports.adjustments.siblingDiscount.tierHint")}
            </p>
          </fieldset>
          <Input
            label={t("financeReports.adjustments.siblingDiscount.feeCategory")}
            type="text"
            value={feeCategory}
            maxLength={140}
            helperText={t("financeReports.adjustments.siblingDiscount.feeCategoryHint")}
            onChange={(event) => setFeeCategory(event.target.value)}
          />
          {error ? (
            <p role="alert" className="adjustments-confirm__error">
              {error}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("financeReports.adjustments.common.cancel")}
        </Button>
        <Button type="button" loading={save.isPending} onClick={submit}>
          {t("financeReports.adjustments.siblingDiscount.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
