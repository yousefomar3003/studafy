import type { ReactNode } from "react";

/**
 * Outline icons for the portal sidebar, keyed by `PortalNavItem.id` (see `nav-items.ts`). Inline SVG
 * like the header's own icons — the app ships no icon library. Purely decorative: the item's text
 * label (visually hidden when the sidebar is collapsed) is always what names the link.
 */
const PATHS: Readonly<Record<string, ReactNode>> = {
  home: <path d="M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3.5v-5h-4v5H4.5a1 1 0 0 1-1-1Z" />,
  notifications: (
    <>
      <path d="M5 8a5 5 0 0 1 10 0v3.5l1.5 2.5h-13L5 11.5Z" />
      <path d="M8.2 16.5a2 2 0 0 0 3.6 0" />
    </>
  ),
  admin: (
    <>
      <path d="M10 2.8 16 5v4.6c0 3.6-2.5 6.3-6 7.6-3.5-1.3-6-4-6-7.6V5Z" />
      <path d="m7.5 10 1.8 1.8 3.4-3.6" />
    </>
  ),
  principal: (
    <>
      <path d="M3 6.5h14v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
      <path d="M7 6.5V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 11h14" />
    </>
  ),
  billing: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" />
      <path d="M2.5 8.5h15M5.5 12.5h3" />
    </>
  ),
  finance: (
    <>
      <path d="M3 16.5h14" />
      <path d="M5 13.5v-4M8.5 13.5v-7M12 13.5v-5M15.5 13.5V4" />
    </>
  ),
  approvals: (
    <>
      <rect x="4" y="3.5" width="12" height="14" rx="1.5" />
      <path d="M7.5 3.5V2.5h5v1M7 10.5l2 2 4-4.5" />
    </>
  ),
  account: (
    <>
      <circle cx="10" cy="7" r="3.5" />
      <path d="M3.5 17a6.5 6.5 0 0 1 13 0" />
    </>
  ),
};

export function NavIcon({ id }: { id: string }) {
  // eslint-disable-next-line security/detect-object-injection -- `id` comes from the fixed PORTAL_NAV_ITEMS list, never external input
  const paths = PATHS[id];
  if (paths === undefined) return null;
  return (
    <svg
      className="portal-nav__icon"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}
