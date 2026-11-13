import { useFormatters, useTranslation } from "../i18n";

import type { FeatureGateState } from "./gate";

import "./features.css";

/**
 * What a paid feature's page says about the person's access (docs/billing/feature-licensing.md,
 * session 6): "Provided by" the school; that a personal subscription will not renew now the school
 * covers it (with how to turn App Store renewal off, which Studafy cannot do for them); this
 * month's usage or the limit reached; "ask your school for a seat"; the school inactive; Studafy
 * paused it; or when their own access ended. Never a purchase control -- buying is the page's own,
 * and only for `purchasable`.
 */
export function FeatureNotice({
  state,
  unitLabel,
}: {
  state: FeatureGateState | null;
  /** The feature's unit in words ("messages"), for the usage line. */
  unitLabel?: string;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  if (!state) return null;
  const date = (iso: string) => formatDate(new Date(iso), { dateStyle: "long", timeZone: "UTC" });

  switch (state.kind) {
    case "covered": {
      const lines = [
        state.coverage !== "personal"
          ? t("site.features.providedBy", { school: state.schoolName })
          : null,
        state.coverage === "both"
          ? state.personalEndsAt
            ? t("site.features.bothRenewal", { date: date(state.personalEndsAt) })
            : t("site.features.bothRenewalNoDate")
          : null,
        state.mustTurnOffAppStoreRenewal ? t("site.features.appStoreSteps") : null,
        state.limitReached
          ? t("site.features.limitReached", { date: date(state.resetsOn) })
          : state.limit !== null && unitLabel
            ? t("site.features.usage", {
                used: formatNumber(state.used),
                limit: formatNumber(state.limit),
                unit: unitLabel,
              })
            : null,
      ].filter((line): line is string => line !== null);
      if (lines.length === 0) return null;
      return (
        <div
          className="feature-notice"
          data-tone={state.limitReached ? "warning" : "success"}
          role="status"
        >
          {lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      );
    }
    case "askSchool":
      return (
        <div className="feature-notice" role="status">
          <p className="feature-notice__title">{t("site.features.askSchoolTitle")}</p>
          <p>
            {state.hasSeat
              ? t("site.features.askSchoolOtherTier", { school: state.schoolName })
              : t("site.features.askSchool", { school: state.schoolName })}
          </p>
        </div>
      );
    case "schoolInactive":
      return (
        <div className="feature-notice" data-tone="warning" role="status">
          <p className="feature-notice__title">{t("site.features.schoolInactiveTitle")}</p>
          <p>{t("site.features.schoolInactive")}</p>
        </div>
      );
    case "unavailable":
      return (
        <div className="feature-notice" role="status">
          <p className="feature-notice__title">{t("site.features.unavailableTitle")}</p>
          <p>{t("site.features.unavailable")}</p>
        </div>
      );
    case "purchasable":
      return state.expiredOn ? (
        <div className="feature-notice" role="status">
          <p>{t("site.features.expired", { date: date(state.expiredOn) })}</p>
        </div>
      ) : null;
  }
}
