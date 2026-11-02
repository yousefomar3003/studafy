import { useQuery } from "@tanstack/react-query";

import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFormatters, useLocale, useTranslation } from "../../lib/i18n";

import type { ReactNode } from "react";

import "./home.css";

/** Most- to least-privileged. A multi-role session is labelled by the first role it holds here. */
const ROLE_PRIORITY = [
  "SUPER_ADMIN",
  "ORG_ADMIN",
  "PRINCIPAL",
  "FINANCE",
  "ATTENDANCE_OFFICER",
  "INSTRUCTOR",
  "SUPPORT_AGENT",
  "PARENT",
  "STUDENT",
  "GUEST",
] as const;

/** The name and school change rarely; refetching on every home visit would be wasted work. */
const PROFILE_STALE_MS = 5 * 60_000;

/** The caller's own name and school (`GET /api/account/profile`), shared by every role's home. */
export function useAccountProfileQuery() {
  return useQuery({
    queryKey: ["account-profile"],
    queryFn: async () => {
      const { data } = await api.GET("/api/account/profile");
      return data ?? null;
    },
    staleTime: PROFILE_STALE_MS,
  });
}

/**
 * The quiet "who is signed in" line at the top of every role's home: name, role and (for school
 * roles) the school, with today's date opposite. Kept deliberately small so the page title and the
 * summary below it carry the visual weight.
 */
export function HomeIdentity({ showSchool = true }: { showSchool?: boolean }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { roles } = useAuth();
  const { data: profile } = useAccountProfileQuery();

  const primaryRole = ROLE_PRIORITY.find((role) => roles.includes(role));
  const name = profile?.display_name?.trim() || profile?.email || null;
  const school = showSchool ? profile?.school.name : undefined;
  const today = new Date();

  return (
    <div className="home-identity">
      <p className="home-identity__who">
        <span className="sf-visually-hidden">{t("home.signedInAs")} </span>
        {name ? <span className="home-identity__name">{name}</span> : null}
        {primaryRole ? (
          <span className="home-identity__role">{t(`home.roles.${primaryRole}`)}</span>
        ) : null}
        {school ? <span className="home-identity__school">{school}</span> : null}
      </p>
      <p className="home-identity__date">
        <time dateTime={today.toISOString().slice(0, 10)}>
          {formatDate(today, { weekday: "long", day: "numeric", month: "long" })}
        </time>
      </p>
    </div>
  );
}

/**
 * Joins summary fragments ("3 approvals waiting", "2 open incidents") into one sentence in the
 * active locale's list style, or the all-clear line when there are none. `null` while any source
 * is still loading, so the sentence never flips from "all clear" to "3 waiting" a beat later, and
 * `null` instead of the all-clear when a source failed: an unknown count is not a zero.
 */
export function useSummarySentence(
  parts: readonly (string | null)[],
  { loading, failed }: { loading: boolean; failed: boolean },
) {
  const { t } = useTranslation();
  const { locale } = useLocale();
  if (loading) return null;
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length === 0) return failed ? null : t("home.allClear");
  const items = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(present);
  return t("home.summarySentence", { items });
}

export interface HomeHeaderProps {
  title: string;
  /** The one-line state-of-things sentence; `null` while it is still being worked out. */
  summary: string | null;
  showSchool?: boolean;
  children?: ReactNode;
}

/** Identity line, page title and summary sentence: how every role's home opens. */
export function HomeHeader({ title, summary, showSchool, children }: HomeHeaderProps) {
  return (
    <header className="home-header">
      <HomeIdentity showSchool={showSchool} />
      <h1 className="home-header__title">{title}</h1>
      <p className="home-header__summary" aria-live="polite">
        {summary ?? " "}
      </p>
      {children}
    </header>
  );
}
