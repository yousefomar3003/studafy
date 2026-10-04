import { useTranslation } from "../lib/i18n";

/** Accessible loading indicator used as the Suspense fallback for lazy route groups. */
export function Loading() {
  const { t } = useTranslation();

  return (
    <p role="status" aria-live="polite">
      {t("site.common.loading")}
    </p>
  );
}
