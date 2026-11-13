export interface MarketingNavItem {
  /** Translation key for the link text — resolved with `t()` at render time, never at module load. */
  labelKey: string;
  to: string;
}

/** Primary marketing nav, shared by the header (desktop + mobile) and the footer's sitemap column. */
export const MARKETING_NAV_ITEMS: MarketingNavItem[] = [
  { labelKey: "site.marketing.nav.home", to: "/" },
  { labelKey: "site.marketing.nav.features", to: "/features" },
  { labelKey: "site.marketing.nav.pricing", to: "/pricing" },
  { labelKey: "site.marketing.nav.about", to: "/about" },
];
