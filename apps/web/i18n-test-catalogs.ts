import { i18next } from "./src/lib/i18n/i18next";
import { arCatalog, enCatalog } from "./src/lib/i18n/locales/catalog";

// The app fetches most translation catalogs on demand (src/lib/i18n/catalog-loader.ts), which
// component tests never trigger. Register every catalog up front so rendered text matches production.
i18next.addResourceBundle("en", "translation", enCatalog, true, true);
i18next.addResourceBundle("ar", "translation", arCatalog, true, true);
