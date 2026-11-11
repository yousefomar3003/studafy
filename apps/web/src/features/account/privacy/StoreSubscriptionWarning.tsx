import { useId } from "react";

import { useTranslation } from "../../../lib/i18n";

import "./store-subscription-warning.css";

import type { components } from "@studafy/api-client";

type ActiveStoreSubscription = components["schemas"]["ActiveStoreSubscription"];

/**
 * Warns that deleting the account leaves an App Store / Google Play AI subscription billing, and
 * says how to cancel it in the store (`active_store_subscriptions` on the profile and on the
 * deletion responses). Apple gives Studafy no way to cancel a subscription, Google Play only a
 * best-effort one when the account is finally deleted, and a parent's deletion cancels nothing for
 * their children -- so the person has to do it themselves. Renders nothing when the list is empty.
 */
export function StoreSubscriptionWarning({
  subscriptions,
  headingLevel = 3,
}: {
  /**
   * `ArrayLike`, not an array: arrays nested in a response lose their array type through the
   * generated client (the gap ./mutations.ts documents), and this takes them as they come.
   */
  subscriptions: ArrayLike<ActiveStoreSubscription> | null | undefined;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  if (!subscriptions || subscriptions.length === 0) return null;

  const all = Array.from(subscriptions);
  const own = all.filter((s) => !s.for_child);
  const child = all.filter((s) => s.for_child);
  const platforms = new Set(all.map((s) => s.platform));
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section className="store-subscription-warning" aria-labelledby={headingId}>
      <Heading id={headingId} className="store-subscription-warning__title">
        {t("accountDeletion.storeWarning.title")}
      </Heading>
      {own.length > 0 ? <p>{t("accountDeletion.storeWarning.ownBody")}</p> : null}
      {own.some((s) => s.platform === "google_play") ? (
        <p>{t("accountDeletion.storeWarning.googlePlayNote")}</p>
      ) : null}
      {child.length > 0 ? <p>{t("accountDeletion.storeWarning.childBody")}</p> : null}
      <p>{t("accountDeletion.storeWarning.stepsIntro")}</p>
      <ul>
        {platforms.has("app_store") ? (
          <li>{t("accountDeletion.storeWarning.appStoreSteps")}</li>
        ) : null}
        {platforms.has("google_play") ? (
          <li>{t("accountDeletion.storeWarning.googlePlaySteps")}</li>
        ) : null}
      </ul>
    </section>
  );
}
