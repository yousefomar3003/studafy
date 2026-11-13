import { useState } from "react";

import { useLocale, useTranslation } from "../../../lib/i18n";

import { usePlatformBanners } from "./queries";

import "./ops.css";

const DISMISSED_KEY = "studafy.platformBanners.dismissed";

/** Dismissed banner ids live in this browser only -- a convenience, never state that must persist. */
function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    // Keep the list short: only the most recent ids matter, old banners have ended anyway.
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Storage blocked (private window): the banner just comes back next visit.
  }
}

/**
 * Studafy-wide banners at the top of every portal page: maintenance windows and platform notices a
 * super admin scheduled in the console. Maintenance banners can't be dismissed; the others can,
 * per browser.
 */
export function PlatformBanners() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { data } = usePlatformBanners(true);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  const visible = (data ?? []).filter(
    (banner) => !banner.dismissible || !dismissed.includes(banner.id),
  );
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(next);
  }

  return (
    <div className="platform-banners">
      {visible.map((banner) => {
        const arabic = locale === "ar" && banner.messageAr;
        return (
          <div
            key={banner.id}
            className="platform-banner"
            data-severity={banner.severity}
            role={banner.severity === "info" ? "status" : "alert"}
          >
            <p className="platform-banner__text" lang={arabic ? "ar" : undefined}>
              <span className="platform-banner__label">
                {t(`shell.platformBanner.${banner.severity}`)}
              </span>{" "}
              {arabic ? banner.messageAr : banner.messageEn}
            </p>
            {banner.dismissible ? (
              <button
                type="button"
                className="platform-banner__dismiss"
                aria-label={t("shell.platformBanner.dismiss")}
                onClick={() => dismiss(banner.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
