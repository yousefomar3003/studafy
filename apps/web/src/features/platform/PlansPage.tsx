import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useSyncPlanPrices, useUpdatePlan, useUpdatePlanPrice } from "./mutations";
import { PlatformPageHeader } from "./PlatformNav";
import { usePlansQuery } from "./queries";

import "./platform.css";

import type { PlatformPlan } from "./queries";

/**
 * Studafy's own plans and prices (`/portal/platform/plans`) — what schools pay Studafy, not a
 * school's tuition. Edits land in the database; "Sync with Stripe" publishes them to the provider.
 */
export default function PlansPage() {
  const { t } = useTranslation();
  const { show } = useToast();
  const { data: plans, isPending, isError } = usePlansQuery();
  const sync = useSyncPlanPrices();
  const [editing, setEditing] = useState<PlatformPlan | null>(null);

  function handleSync() {
    sync.mutate(undefined, {
      onSuccess: (result) =>
        show({
          variant: "success",
          title: t("platform.plans.syncSuccess", {
            plans: result.syncedPlans,
            prices: result.syncedPrices,
          }),
        }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("platform.plans.syncError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  return (
    <>
      <PlatformPageHeader
        title={t("platform.plans.title")}
        description={t("platform.plans.description")}
        actions={
          <Button variant="secondary" loading={sync.isPending} onClick={handleSync}>
            {t("platform.plans.sync")}
          </Button>
        }
      />

      {isPending ? <p role="status">{t("site.common.loading")}</p> : null}
      {isError ? <p role="alert">{t("platform.plans.loadError")}</p> : null}
      {plans && plans.length === 0 ? <p>{t("platform.plans.empty")}</p> : null}

      <div className="platform-stack">
        {plans?.map((plan) => (
          <PlanCard key={plan.id} plan={plan} onEdit={() => setEditing(plan)} />
        ))}
      </div>

      <EditPlanModal plan={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PlanCard({ plan, onEdit }: { plan: PlatformPlan; onEdit: () => void }) {
  const { t } = useTranslation();
  const { formatCurrency } = useFormatters();
  const { show } = useToast();
  const updatePlan = useUpdatePlan();
  const updatePrice = useUpdatePlanPrice();

  const onError = (error: unknown) =>
    show({
      variant: "error",
      title: t("platform.plans.saveError"),
      description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
    });

  return (
    <Card as="section" aria-labelledby={`plan-${plan.id}`}>
      <Card.Header>
        <div className="platform-header__row">
          <div className="platform-cell-stack">
            <h2 id={`plan-${plan.id}`}>
              {plan.displayName} <code>{plan.code}</code>
            </h2>
            {plan.description ? <span className="platform-muted">{plan.description}</span> : null}
          </div>
          <div className="platform-actions">
            <Checkbox
              label={t("platform.plans.available")}
              checked={plan.isActive}
              disabled={updatePlan.isPending}
              onChange={(event) =>
                updatePlan.mutate(
                  { planId: plan.id, patch: { isActive: event.target.checked } },
                  { onError },
                )
              }
            />
            <Button variant="tertiary" onClick={onEdit}>
              {t("platform.plans.edit")}
            </Button>
          </div>
        </div>
      </Card.Header>
      <Card.Body>
        {plan.prices.length === 0 ? (
          <p className="platform-muted">{t("platform.plans.noPrices")}</p>
        ) : (
          <table className="platform-table">
            <caption className="sf-visually-hidden">
              {t("platform.plans.pricesCaption", { plan: plan.displayName })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("platform.plans.columns.currency")}</th>
                <th scope="col">{t("platform.plans.columns.interval")}</th>
                <th scope="col">{t("platform.plans.columns.amount")}</th>
                <th scope="col">{t("platform.plans.columns.available")}</th>
              </tr>
            </thead>
            <tbody>
              {plan.prices.map((price) => (
                <tr key={price.id}>
                  <td>{price.currencyCode}</td>
                  <td>
                    {t(`platform.plans.interval.${price.billingInterval}`, {
                      defaultValue: price.billingInterval,
                    })}
                  </td>
                  <td>
                    {formatCurrency(price.amountMinor / 10 ** price.minorUnit, price.currencyCode)}
                  </td>
                  <td>
                    <Checkbox
                      label={t("platform.plans.priceAvailable", {
                        currency: price.currencyCode,
                        interval: price.billingInterval,
                      })}
                      checked={price.isActive}
                      disabled={updatePrice.isPending}
                      onChange={(event) =>
                        updatePrice.mutate(
                          { planId: plan.id, priceId: price.id, isActive: event.target.checked },
                          { onError },
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card.Body>
    </Card>
  );
}

function EditPlanModal({ plan, onClose }: { plan: PlatformPlan | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updatePlan = useUpdatePlan();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the form once per plan opened, without an effect: compare against the last plan seeded.
  if (plan && loadedFor !== plan.id) {
    setLoadedFor(plan.id);
    setName(plan.displayName);
    setDescription(plan.description ?? "");
  }

  function close() {
    setLoadedFor(null);
    onClose();
  }

  function save() {
    if (!plan || name.trim() === "") return;
    updatePlan.mutate(
      {
        planId: plan.id,
        patch: { displayName: name.trim(), description: description.trim() || null },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("platform.plans.saved") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.plans.saveError"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={plan !== null}
      onClose={close}
      title={t("platform.plans.editTitle")}
      description={plan?.code}
    >
      <Modal.Body>
        <Input
          label={t("platform.plans.nameLabel")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
        <Input
          label={t("platform.plans.descriptionLabel")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p className="platform-muted">{t("platform.plans.syncReminder")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={name.trim() === ""}
          loading={updatePlan.isPending}
          onClick={save}
        >
          {t("platform.common.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
