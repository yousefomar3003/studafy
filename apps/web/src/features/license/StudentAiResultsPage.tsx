import { PERMISSIONS } from "@studafy/constants";
import { Link } from "react-router-dom";

import { usePermissions } from "../../lib/auth";
import { useFormatters, useTranslation } from "../../lib/i18n";
import {
  ConversionSection,
  EarningsSum,
  StatRow,
  UploadTables,
  useConversionSource,
  useCurrencyMoney,
  useDay,
  usePercent,
} from "../ai-programme/components";
import { useSchoolProgrammeQuery, useSchoolUploadsQuery } from "../ai-programme/queries";

import { LicenseHeader } from "./LicenseHeader";

import type { StatItem } from "../ai-programme/components";
import type { ProgrammeDashboard } from "../ai-programme/queries";

import "./license.css";

const P = "schoolLicense.programme";

/**
 * Student AI results (`/portal/license/student-ai/results`), gated by `license:read` (the school
 * admin and the principal): how many students are enrolled and opted in, the conversion and the
 * tier it earns, what the next tier takes ("Add 40 more seats -> unlock 10%"), the school's
 * earnings for the year, and upload consistency per teacher and per class with those below the
 * target the school is aiming for marked. Read-only; the opt-in itself is on the Student AI tab.
 */
export default function StudentAiResultsPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const canReadShare = permissions.has(PERMISSIONS.AI_REVENUE_SHARE_READ);
  const summary = useSchoolProgrammeQuery();
  const uploads = useSchoolUploadsQuery();
  const data = summary.data;

  return (
    <>
      <LicenseHeader title={t(`${P}.results.title`)} description={t(`${P}.results.description`)} />
      {summary.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
      {summary.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
      {data ? (
        <div className="aip-stack">
          {!data.license?.inProgramme ? (
            <div className="license-banner" data-tone="warning" role="status">
              <div>
                <p className="license-banner__title">{t(`${P}.results.notInProgramme`)}</p>
                <p className="license-banner__body">
                  <Link to="/portal/license/student-ai">{t(`${P}.results.openOptIn`)}</Link>
                </p>
              </div>
            </div>
          ) : null}
          <Headline dashboard={data} />
          <ConversionSection dashboard={data} headingId="results-conversion" />
          {canReadShare ? (
            <section className="aip-section" aria-labelledby="results-earnings">
              <h2 id="results-earnings">{t(`${P}.results.earningsTitle`)}</h2>
              <EarningsSum
                earnings={data.earnings}
                currencyCode={data.currencyCode}
                minorUnit={data.minorUnit}
                yearName={data.academicYear?.name ?? null}
              />
            </section>
          ) : null}
          <section className="aip-section" aria-labelledby="results-uploads">
            <h2 id="results-uploads">{t(`${P}.uploads.title`)}</h2>
            <p className="aip-muted">{t(`${P}.uploads.description`)}</p>
            {uploads.isPending ? <p role="status">{t("schoolLicense.common.loading")}</p> : null}
            {uploads.isError ? <p role="alert">{t("schoolLicense.common.loadError")}</p> : null}
            {uploads.data ? <UploadTables report={uploads.data} showTeachers /> : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

function Headline({ dashboard }: { dashboard: ProgrammeDashboard }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const pct = usePercent();
  const day = useDay();
  const source = useConversionSource();
  const m = useCurrencyMoney(dashboard.currencyCode, dashboard.minorUnit);
  const { students, conversion, uploads, rate } = dashboard;
  const items: StatItem[] = [
    {
      key: "enrolled",
      label: t(`${P}.stats.enrolled`),
      value: formatNumber(students.enrolled),
    },
    {
      key: "opted-in",
      label: t(`${P}.stats.optedIn`),
      value: formatNumber(students.optedIn),
      hint: t(`${P}.stats.optedInHint`, { conversion: pct(students.conversionBps) }),
    },
    {
      key: "conversion",
      label: t(`${P}.stats.conversion`),
      value: conversion ? pct(conversion.conversionBps) : "—",
      hint: conversion ? source(conversion) : undefined,
    },
    {
      key: "tier",
      label: t(`${P}.stats.tier`),
      value: conversion ? pct(conversion.shareBps) : "—",
      hint: conversion?.floorApplied ? t(`${P}.stats.floor`) : undefined,
      tone: conversion && conversion.shareBps > 0 ? "success" : undefined,
    },
    {
      key: "uploads",
      label: t(`${P}.stats.uploads`),
      value: uploads?.consistencyBps != null ? pct(uploads.consistencyBps) : "—",
      hint: uploads
        ? t(`${P}.stats.uploadsHint`, {
            bonus: pct(uploads.tierBonusBps),
            from: day(uploads.from),
            to: day(uploads.to),
          })
        : undefined,
      tone:
        uploads?.aimBps != null && uploads.consistencyBps != null
          ? uploads.consistencyBps >= uploads.aimBps
            ? "success"
            : "warning"
          : undefined,
    },
    {
      key: "rate",
      label: t(`${P}.stats.rate`),
      value: rate ? pct(rate.totalBps) : "—",
      hint: rate
        ? t(`${P}.stats.rateHint`, {
            conversion: pct(rate.conversionShareBps),
            bonus: pct(rate.bonusBps),
          })
        : undefined,
    },
  ];
  if (dashboard.earnings) {
    items.push({
      key: "earnings",
      label: dashboard.academicYear
        ? t(`${P}.stats.earningsFor`, { year: dashboard.academicYear.name })
        : t(`${P}.stats.earnings`),
      value: m(dashboard.earnings.totalMinor),
      hint: dashboard.earnings.estimated ? t(`${P}.earnings.estimated`) : undefined,
    });
  }
  return <StatRow items={items} label={t(`${P}.stats.label`)} />;
}
