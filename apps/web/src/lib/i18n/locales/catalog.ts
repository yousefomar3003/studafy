/**
 * The merged translation catalogs, for tooling and tests only (catalog.test.ts, the pseudo-locale
 * generator, the test preload). The app itself never imports this file — it would pull every
 * language into the entry bundle; it loads catalogs on demand via `../catalog-loader.ts`.
 * `en.json` / `ar.json` hold the shared shell strings (nav, header,
 * account); each feature area keeps its own file under `en/` and `ar/`, mounted here under a
 * top-level key of the same name (`t("finance.…")`, `t("principal.…")`). Splitting by area keeps
 * catalog edits for one feature from colliding with another's.
 *
 * Every key in `en` must exist in `ar` (see catalog.test.ts); `qps-ploc.json` is generated from
 * {@link enCatalog} (`bun run --cwd apps/web i18n:pseudo`).
 */
import arAcademicGrading from "./ar/academicGrading.json";
import arAdminPeople from "./ar/adminPeople.json";
import arAdminSchool from "./ar/adminSchool.json";
import arAttendanceOffice from "./ar/attendanceOffice.json";
import arFinance from "./ar/finance.json";
import arFinanceReports from "./ar/financeReports.json";
import arOnboarding from "./ar/onboarding.json";
import arPlatform from "./ar/platform.json";
import arPlatformLicensing from "./ar/platformLicensing.json";
import arPrincipal from "./ar/principal.json";
import arSchoolLicense from "./ar/schoolLicense.json";
import arSite from "./ar/site.json";
import ar from "./ar.json";
import enAcademicGrading from "./en/academicGrading.json";
import enAdminPeople from "./en/adminPeople.json";
import enAdminSchool from "./en/adminSchool.json";
import enAttendanceOffice from "./en/attendanceOffice.json";
import enFinance from "./en/finance.json";
import enFinanceReports from "./en/financeReports.json";
import enOnboarding from "./en/onboarding.json";
import enPlatform from "./en/platform.json";
import enPlatformLicensing from "./en/platformLicensing.json";
import enPrincipal from "./en/principal.json";
import enSchoolLicense from "./en/schoolLicense.json";
import enSite from "./en/site.json";
import en from "./en.json";

export const enCatalog = {
  ...en,
  adminPeople: enAdminPeople,
  adminSchool: enAdminSchool,
  finance: enFinance,
  financeReports: enFinanceReports,
  principal: enPrincipal,
  attendanceOffice: enAttendanceOffice,
  platform: enPlatform,
  platformLicensing: enPlatformLicensing,
  schoolLicense: enSchoolLicense,
  onboarding: enOnboarding,
  academicGrading: enAcademicGrading,
  site: enSite,
};

export const arCatalog = {
  ...ar,
  adminPeople: arAdminPeople,
  adminSchool: arAdminSchool,
  finance: arFinance,
  financeReports: arFinanceReports,
  principal: arPrincipal,
  attendanceOffice: arAttendanceOffice,
  platform: arPlatform,
  platformLicensing: arPlatformLicensing,
  schoolLicense: arSchoolLicense,
  onboarding: arOnboarding,
  academicGrading: arAcademicGrading,
  site: arSite,
};
