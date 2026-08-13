export interface MarketingNavItem {
  label: string;
  to: string;
}

/** Primary marketing nav, shared by the header (desktop + mobile) and the footer's sitemap column. */
export const MARKETING_NAV_ITEMS: MarketingNavItem[] = [
  { label: "Home", to: "/" },
  { label: "Features", to: "/features" },
  { label: "Pricing", to: "/pricing" },
  { label: "About", to: "/about" },
];
