/**
 * On-demand translation catalogs. Only the English shell (`en.json` + `en/site.json`: headers, sign-in,
 * marketing, shared components) ships in the entry bundle — that is what every public page needs,
 * and keeping the rest out of the critical path is what holds the Lighthouse budgets
 * (`lighthouserc.json`). Everything else is fetched as a separate chunk:
 *
 * - the shell for a non-English locale, before the first render (`main.tsx`) or a language switch;
 * - each feature area (`finance`, `principal`, …), alongside the lazy route that needs it
 *   (`lazyWithCatalogs` in `app/routes.tsx`), for the active language only.
 *
 * A language switch first loads the new language's shell plus every area already requested this
 * session, then calls `changeLanguage`, so the UI never renders raw keys mid-switch. Bundles are
 * deep-merged into the single `translation` namespace, so keys stay `t("finance.…")`.
 */
import { isSupportedLocale, type Locale } from "./config";
import { i18next } from "./i18next";

export type CatalogArea =
  "adminPeople" | "adminSchool" | "finance" | "financeReports" | "principal" | "onboarding";

type Catalog = Record<string, unknown>;
type CatalogModule = Promise<{ default: Catalog }>;

const SHELL_LOADERS: Record<Locale, () => Promise<Catalog>> = {
  // English is bundled with i18next.ts; this only exists to keep the map total.
  en: async () => ({}),
  ar: async () => {
    const [shell, site] = await Promise.all([
      import("./locales/ar.json"),
      import("./locales/ar/site.json"),
    ]);
    return { ...shell.default, site: site.default };
  },
};

const AREA_LOADERS: Record<Locale, Record<CatalogArea, () => CatalogModule>> = {
  en: {
    adminPeople: () => import("./locales/en/adminPeople.json"),
    adminSchool: () => import("./locales/en/adminSchool.json"),
    finance: () => import("./locales/en/finance.json"),
    financeReports: () => import("./locales/en/financeReports.json"),
    principal: () => import("./locales/en/principal.json"),
    onboarding: () => import("./locales/en/onboarding.json"),
  },
  ar: {
    adminPeople: () => import("./locales/ar/adminPeople.json"),
    adminSchool: () => import("./locales/ar/adminSchool.json"),
    finance: () => import("./locales/ar/finance.json"),
    financeReports: () => import("./locales/ar/financeReports.json"),
    principal: () => import("./locales/ar/principal.json"),
    onboarding: () => import("./locales/ar/onboarding.json"),
  },
};

/** In-flight or settled loads, keyed `locale:shell` / `locale:area`, so each chunk loads once. */
const loads = new Map<string, Promise<void>>([["en:shell", Promise.resolve()]]);
/** Areas some route has needed this session; a language switch preloads all of them. */
const requestedAreas = new Set<CatalogArea>();

function load(key: string, fetchBundle: () => Promise<Catalog>): Promise<void> {
  let pending = loads.get(key);
  if (!pending) {
    const locale = key.slice(0, key.indexOf(":"));
    pending = fetchBundle().then((bundle) => {
      i18next.addResourceBundle(locale, "translation", bundle, true, true);
    });
    // A failed chunk (offline, deploy mid-session) may be retried by the next caller.
    pending.catch(() => loads.delete(key));
    loads.set(key, pending);
  }
  return pending;
}

function ensureCatalogs(locale: string, areas: Iterable<CatalogArea>): Promise<void> {
  // The dev-only pseudo-locale is registered whole in i18next.ts; nothing to fetch for it.
  if (!isSupportedLocale(locale)) return Promise.resolve();
  // `locale` and `area` are narrowed to the closed `Locale` / `CatalogArea` unions, so these are
  // lookups into fixed local maps, not property access driven by untrusted input.
  // eslint-disable-next-line security/detect-object-injection
  const shell = load(`${locale}:shell`, SHELL_LOADERS[locale]);
  const areaLoads = [...areas].map((area) =>
    load(`${locale}:${area}`, async () => ({
      // eslint-disable-next-line security/detect-object-injection
      [area]: (await AREA_LOADERS[locale][area]()).default,
    })),
  );
  return Promise.all([shell, ...areaLoads]).then(() => undefined);
}

/** Loads the given areas for the active language (used by lazy routes). */
export function loadCatalogAreas(areas: readonly CatalogArea[]): Promise<void> {
  for (const area of areas) requestedAreas.add(area);
  return ensureCatalogs(i18next.language, areas);
}

/** Loads everything `locale` needs so far (shell + requested areas); await before switching to it. */
export function prepareLocale(locale: string): Promise<void> {
  return ensureCatalogs(locale, requestedAreas);
}
