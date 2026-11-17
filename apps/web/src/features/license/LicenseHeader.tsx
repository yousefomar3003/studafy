import { Link, NavLink } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";
import { useMoney } from "../platform/licensing/format";

import {
  ALMOST_FULL_SHARE,
  AUDIENCES,
  EXPIRING_WITHIN_DAYS,
  daysUntil,
  useInvoicesQuery,
  useSchoolLicenseQuery,
} from "./queries";

import type { LicenseStatus } from "./queries";
import type { ReactNode } from "react";

import "./license.css";

const SECTIONS = [
  { to: "/portal/license", key: "overview", end: true },
  { to: "/portal/license/seats", key: "seats", end: false },
  { to: "/portal/license/student-ai", key: "studentAi", end: false },
  { to: "/portal/license/quotes", key: "quotes", end: false },
  { to: "/portal/license/invoices", key: "invoices", end: false },
  { to: "/portal/license/storage", key: "storage", end: false },
] as const;

/**
 * The top of every license page: its title, the license area's sections, and the banners that need
 * the school's attention wherever it is -- license ending soon, an invoice overdue, seats almost
 * full.
 */
export function LicenseHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="license-header">
        <h1>{title}</h1>
        {actions ? <div className="license-toolbar__actions">{actions}</div> : null}
      </div>
      {description ? <p className="license-muted">{description}</p> : null}
      <nav aria-label={t("schoolLicense.nav.label")}>
        <ul className="license-nav">
          {SECTIONS.map((section) => (
            <li key={section.key}>
              <NavLink to={section.to} end={section.end}>
                {t(`schoolLicense.nav.${section.key}`)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <LicenseBanners />
    </>
  );
}

export function LicenseBanners() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const money = useMoney();
  const overview = useSchoolLicenseQuery();
  const overdue = useInvoicesQuery("overdue");
  const license = overview.data?.license ?? null;

  const banners: { key: string; tone: "warning" | "danger"; title: string; body: ReactNode }[] = [];

  if (license?.status === "active") {
    const days = daysUntil(license.endsAt);
    if (days >= 0 && days <= EXPIRING_WITHIN_DAYS) {
      banners.push({
        key: "expiring",
        tone: "warning",
        title: t("schoolLicense.banners.expiringTitle", { count: days }),
        body: t("schoolLicense.banners.expiringBody", {
          date: formatDate(new Date(license.endsAt), { dateStyle: "long" }),
        }),
      });
    }
  }

  // AI stops 30 days after an unpaid instalment (000233): say so once it has, and warn from the day
  // the instalment is late until then.
  const stop = license?.nextAiStop ?? null;
  const stopDate = (iso: string) => formatDate(new Date(`${iso}T00:00:00Z`), { dateStyle: "long" });
  if (license?.status === "suspended" && license.nonpaymentSuspendedAt) {
    banners.push({
      key: "ai-stopped",
      tone: "danger",
      title: t("schoolLicense.aiStop.stoppedTitle"),
      body: (
        <>
          {stop
            ? t("schoolLicense.aiStop.stoppedBody", {
                number: stop.invoiceNumber,
                due: stopDate(stop.dueDate),
                amount: money(stop.balanceMinor, stop.currencyCode, stop.minorUnit),
              })
            : t("schoolLicense.aiStop.stoppedInvoice")}{" "}
          {stop ? (
            <Link to={`/portal/license/invoices/${stop.invoiceId}`}>
              {t("schoolLicense.banners.overdueLink")}
            </Link>
          ) : null}
        </>
      ),
    });
  } else if (license?.status === "active" && stop && stop.daysLeft > 0 && stop.daysLeft < 30) {
    banners.push({
      key: "ai-stop-warning",
      tone: stop.daysLeft <= 7 ? "danger" : "warning",
      title: t("schoolLicense.aiStop.warningTitle", { date: stopDate(stop.stopDate) }),
      body: (
        <>
          {t("schoolLicense.aiStop.warningBody", {
            amount: money(stop.balanceMinor, stop.currencyCode, stop.minorUnit),
            number: stop.invoiceNumber,
            due: stopDate(stop.dueDate),
            count: stop.daysLeft,
          })}{" "}
          <Link to={`/portal/license/invoices/${stop.invoiceId}`}>
            {t("schoolLicense.banners.overdueLink")}
          </Link>
        </>
      ),
    });
  }

  const overdueInvoices = overdue.data ?? [];
  if (overdueInvoices.length > 0) {
    const first = overdueInvoices[0]!;
    banners.push({
      key: "overdue",
      tone: "danger",
      title: t("schoolLicense.banners.overdueTitle", { count: overdueInvoices.length }),
      body: (
        <>
          {t("schoolLicense.banners.overdueBody", {
            amount: money(first.balanceMinor, first.currencyCode, first.minorUnit),
            number: first.number,
          })}{" "}
          <Link to={`/portal/license/invoices/${first.id}`}>
            {t("schoolLicense.banners.overdueLink")}
          </Link>
        </>
      ),
    });
  }

  if (license && license.status !== "expired" && license.status !== "cancelled") {
    for (const audience of AUDIENCES) {
      const row = license.audiences.find((a) => a.audience === audience);
      if (!row || row.purchased === 0 || row.assigned / row.purchased < ALMOST_FULL_SHARE) continue;
      banners.push({
        key: `full-${audience}`,
        tone: "warning",
        title: t(`schoolLicense.banners.almostFullTitle.${audience}`),
        body: (
          <>
            {t("schoolLicense.banners.almostFullBody", {
              assigned: formatNumber(row.assigned),
              purchased: formatNumber(row.purchased),
            })}{" "}
            <Link to="/portal/license?request=1">{t("schoolLicense.banners.almostFullLink")}</Link>
          </>
        ),
      });
    }
  }

  if (banners.length === 0) return null;
  return (
    <div className="license-banners">
      {banners.map((banner) => (
        <div
          key={banner.key}
          className="license-banner"
          data-tone={banner.tone}
          role={banner.tone === "danger" ? "alert" : "status"}
        >
          <div>
            <p className="license-banner__title">{banner.title}</p>
            <p className="license-banner__body">{banner.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const STATUS_TONE: Record<LicenseStatus, "success" | "warning" | "danger" | "neutral"> = {
  draft: "neutral",
  awaiting_payment: "warning",
  active: "success",
  suspended: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

export function LicenseStatusPill({ status }: { status: LicenseStatus }) {
  const { t } = useTranslation();
  return (
    <span className="license-pill" data-tone={STATUS_TONE[status]}>
      {t(`schoolLicense.status.${status}`)}
    </span>
  );
}

export function SeatMeter({ assigned, purchased }: { assigned: number; purchased: number }) {
  const share = purchased > 0 ? Math.min(1, assigned / purchased) : 0;
  return (
    <span className="license-meter" aria-hidden="true">
      <span
        className="license-meter__fill"
        data-tone={share >= ALMOST_FULL_SHARE ? "warning" : undefined}
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </span>
  );
}
