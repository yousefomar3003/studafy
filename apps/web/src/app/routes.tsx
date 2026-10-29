import { PERMISSIONS } from "@studafy/constants";
import { lazy } from "react";

import { RouteError } from "../components/RouteError";
import { DeletionPendingGate } from "../features/account/privacy/DeletionPendingGate";
import { AccountLayout } from "../layouts/AccountLayout";
import { HelpLayout } from "../layouts/HelpLayout";
import { MarketingLayout } from "../layouts/MarketingLayout";
import { OnboardingLayout } from "../layouts/OnboardingLayout";
import { PortalLayout } from "../layouts/PortalLayout";
import { RootLayout } from "../layouts/RootLayout";
import { SetupWizardLayout } from "../layouts/SetupWizardLayout";
import { RequireAuth, RequirePermission } from "../lib/auth";
import { loadCatalogAreas } from "../lib/i18n";
import HomePage from "../routes/marketing/HomePage";

import type { CatalogArea } from "../lib/i18n";
import type { ComponentType } from "react";
import type { RouteObject } from "react-router-dom";

// Secondary route groups are code-split so the initial (marketing) route stays small.
// Translation catalogs each route group needs beyond the bundled shell (see lib/i18n/catalog-loader).
const ADMIN_CATALOGS: readonly CatalogArea[] = ["adminPeople", "adminSchool"];
const PRINCIPAL_CATALOGS: readonly CatalogArea[] = ["principal"];
// The attendance office reuses the principal's term picker, correction modal and reports view, so it
// loads their strings alongside its own.
const ATTENDANCE_OFFICE_CATALOGS: readonly CatalogArea[] = ["attendanceOffice", "principal"];
// The license console (platformLicensing) is part of every console page: the nav and the school page
// use its strings.
const PLATFORM_CATALOGS: readonly CatalogArea[] = ["platform", "platformLicensing"];
const FINANCE_CATALOGS: readonly CatalogArea[] = ["finance", "financeReports"];
// The school's license pages; the admin and principal dashboards also load it for their license tile.
const LICENSE_CATALOGS: readonly CatalogArea[] = ["schoolLicense"];
const ONBOARDING_CATALOGS: readonly CatalogArea[] = ["onboarding"];

/**
 * `React.lazy` that also fetches the page's translation catalogs for the active language, in
 * parallel with its code chunk, so the page never renders before its strings exist.
 */
function lazyWithCatalogs<T extends ComponentType>(
  areas: readonly CatalogArea[],
  importPage: () => Promise<{ default: T }>,
) {
  return lazy(() => Promise.all([importPage(), loadCatalogAreas(areas)]).then(([page]) => page));
}

const FeaturesPage = lazy(() => import("../routes/marketing/FeaturesPage"));
const PricingPage = lazy(() => import("../routes/marketing/PricingPage"));
const AboutPage = lazy(() => import("../routes/marketing/AboutPage"));
const AuthLoginPage = lazy(() => import("../routes/auth/LoginPage"));
const AuthCallbackPage = lazy(() => import("../routes/auth/CallbackPage"));
const AuthErrorPage = lazy(() => import("../routes/auth/ErrorPage"));
const InvitePage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/invite/InvitePage"),
);
const InviteCompletePage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/invite/InviteCompletePage"),
);
const OnboardingPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/onboarding/OnboardingPage"),
);
const SignupPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/signup/SignupPage"),
);
const ApplyPage = lazyWithCatalogs(ONBOARDING_CATALOGS, () => import("../routes/signup/ApplyPage"));
const SetupWizardPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/onboarding-setup/SetupWizardPage"),
);
// Its strings live in the shell catalog (`globalSearch`), like the palette's.
const SearchResultsPage = lazy(() => import("../features/search/SearchResultsPage"));
const PortalPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/portal/PortalPage"),
);
const AdminDashboardPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, ...LICENSE_CATALOGS, "recordTemplates"],
  () => import("../features/admin/AdminDashboardPage"),
);
const UsersListPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, "records"],
  () => import("../features/admin/users/UsersListPage"),
);
const StaffAccountsPage = lazyWithCatalogs(
  ADMIN_CATALOGS,
  () => import("../features/admin/staff/StaffAccountsPage"),
);
const SchoolMembersPage = lazyWithCatalogs(
  ADMIN_CATALOGS,
  () => import("../features/admin/members/SchoolMembersPage"),
);
const StudentsListPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, "records"],
  () => import("../features/admin/students/StudentsListPage"),
);
const StudentProfilePage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, "records"],
  () => import("../features/admin/students/StudentProfilePage"),
);
const AdminParentRecordsPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, "records"],
  () => import("../features/records/AdminParentRecordsPage"),
);
const ImportStudentsPage = lazyWithCatalogs(
  ADMIN_CATALOGS,
  () => import("../features/admin/students/ImportStudentsPage"),
);
const TimetableBuilderPage = lazyWithCatalogs(
  ADMIN_CATALOGS,
  () => import("../features/admin/timetable/TimetableBuilderPage"),
);
const SchoolSettingsPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, "recordTemplates"],
  () => import("../features/admin/settings/SchoolSettingsPage"),
);
const AnnouncementsPage = lazyWithCatalogs(
  ADMIN_CATALOGS,
  () => import("../features/admin/announcements/AnnouncementsPage"),
);
// The principal's `SchoolCalendarPage`, reused for the school admin; its strings live in the
// principal catalog.
const AdminSchoolCalendarPage = lazyWithCatalogs(
  [...ADMIN_CATALOGS, ...PRINCIPAL_CATALOGS],
  () => import("../features/principal/calendar/SchoolCalendarPage"),
);
const PlatformOverviewPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/PlatformOverviewPage"),
);
const PlatformApplicationsPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/ApplicationsPage"),
);
const PlatformApplicationDetailPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/ApplicationDetailPage"),
);
const PlatformSchoolsListPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/SchoolsListPage"),
);
const PlatformSchoolDetailPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/SchoolDetailPage"),
);
const PlatformPlansPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/PlansPage"),
);
const PlatformSettingsPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/PlatformSettingsPage"),
);
const PlatformFinancePage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/PlatformFinancePage"),
);
const PlatformAiUsagePage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/AiUsagePage"),
);
const PlatformInquiriesPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/InquiriesPage"),
);
const PlatformUserLookupPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/UserLookupPage"),
);
const PlatformRefundsPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/RefundsPage"),
);
const PlatformFeaturesPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/FeaturesPage"),
);
const PlatformTiersPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/TiersPage"),
);
const PlatformPricingPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/PricingSettingsPage"),
);
const PlatformQuotesPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/CalculatorPage"),
);
const PlatformLicensesPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/LicensesPage"),
);
const PlatformPaymentsPage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/PaymentsPage"),
);
const PlatformInvoicePage = lazyWithCatalogs(
  PLATFORM_CATALOGS,
  () => import("../features/platform/licensing/InvoicePage"),
);
const PrincipalDashboardPage = lazyWithCatalogs(
  [...PRINCIPAL_CATALOGS, ...LICENSE_CATALOGS, "recordTemplates"],
  () => import("../features/principal/PrincipalDashboardPage"),
);
const LicensePage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/LicensePage"),
);
const LicenseSeatsPage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/SeatsPage"),
);
const LicenseQuotesPage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/QuotesPage"),
);
const LicenseQuotePage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/QuoteDetailPage"),
);
const LicenseInvoicesPage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/InvoicesPage"),
);
const LicenseInvoicePage = lazyWithCatalogs(
  LICENSE_CATALOGS,
  () => import("../features/license/InvoiceDetailPage"),
);
const PrincipalGradesPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/grades/PrincipalGradesPage"),
);
const SchoolCalendarPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/calendar/SchoolCalendarPage"),
);
// Also loads the admin catalog: the page renders the shared admin `TimetableWorkspace`.
const PrincipalTimetablePage = lazyWithCatalogs(
  [...PRINCIPAL_CATALOGS, ...ADMIN_CATALOGS],
  () => import("../features/principal/timetable/PrincipalTimetablePage"),
);
const PrincipalClassesPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/classes/PrincipalClassesPage"),
);
const GradesSectionsPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/sections/GradesSectionsPage"),
);
// Loads the principal catalog too: it names sections the way the grades & sections page does.
const AcademicSetupPage = lazyWithCatalogs(
  [...PRINCIPAL_CATALOGS, "academicGrading"],
  () => import("../features/principal/academic-setup/AcademicSetupPage"),
);
// School-defined student and parent records: the template editor and the missing-information
// list, one component each, mounted by both the admin and the principal portal.
const RecordTemplatesPage = lazyWithCatalogs(
  ["recordTemplates"],
  () => import("../features/records/templates/RecordTemplatesPage"),
);
const MissingInformationPage = lazyWithCatalogs(
  ["recordTemplates"],
  () => import("../features/records/missing/MissingInformationPage"),
);
const PrincipalStudentsPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/students/PrincipalStudentsPage"),
);
// The principal's student and parent pages mount the shared records panel, so they load its strings.
const PrincipalStudentPage = lazyWithCatalogs(
  [...PRINCIPAL_CATALOGS, "records"],
  () => import("../features/principal/students/PrincipalStudentPage"),
);
const PrincipalParentPage = lazyWithCatalogs(
  [...PRINCIPAL_CATALOGS, "records"],
  () => import("../features/principal/students/PrincipalParentPage"),
);
const IncidentListPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/discipline/IncidentListPage"),
);
const IncidentDetailPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/discipline/IncidentDetailPage"),
);
const MessageReportListPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/message-reports/MessageReportListPage"),
);
const MessageReportDetailPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/message-reports/MessageReportDetailPage"),
);
const AttendanceDashboardView = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/attendance/views/AttendanceDashboardView"),
);
const EvaluationListPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/evaluations/EvaluationListPage"),
);
const EvaluationDetailPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/evaluations/EvaluationDetailPage"),
);
const CriteriaTemplatesPage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/evaluations/CriteriaTemplatesPage"),
);
const AttendanceOfficePage = lazyWithCatalogs(
  ATTENDANCE_OFFICE_CATALOGS,
  () => import("../features/attendance-office/AttendanceOfficePage"),
);
const AttendanceRegisterPage = lazyWithCatalogs(
  ATTENDANCE_OFFICE_CATALOGS,
  () => import("../features/attendance-office/RegisterPage"),
);
const StudentAttendancePage = lazyWithCatalogs(
  ATTENDANCE_OFFICE_CATALOGS,
  () => import("../features/attendance-office/StudentAttendancePage"),
);
const AttendanceOfficeReportsPage = lazyWithCatalogs(
  ATTENDANCE_OFFICE_CATALOGS,
  () => import("../features/principal/attendance/views/AttendanceDashboardView"),
);
const ApprovalQueuePage = lazyWithCatalogs(
  PRINCIPAL_CATALOGS,
  () => import("../features/principal/approvals/ApprovalQueuePage"),
);
const NotificationInboxPage = lazy(() => import("../features/notifications/NotificationInboxPage"));
const NotificationPreferencesPage = lazy(
  () => import("../features/notifications/NotificationPreferencesPage"),
);
const FinanceDashboardPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/FinanceDashboardPage"),
);
const FinanceOverdueInstallmentsPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/FinanceOverdueInstallmentsPage"),
);
const FeeStructureBuilderPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/fees/FeeStructureBuilderPage"),
);
const InvoiceListPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/invoices/InvoiceListPage"),
);
const InvoiceDetailPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/invoices/InvoiceDetailPage"),
);
const InvoiceBatchPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/invoices/InvoiceBatchPage"),
);
const FamiliesListPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/families/FamiliesListPage"),
);
const FamilyDetailPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/families/FamilyDetailPage"),
);
// The link-children picker on this page is the admin one, with its adminPeople strings.
const UnlinkedPage = lazyWithCatalogs(
  [...FINANCE_CATALOGS, "adminPeople"],
  () => import("../features/finance/unlinked/UnlinkedPage"),
);
const RecordFamilyPaymentPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/families/RecordFamilyPaymentPage"),
);
const PaymentsListPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/payments/PaymentsListPage"),
);
const RecordPaymentPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/payments/RecordPaymentPage"),
);
const RefundsListPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/adjustments/RefundsListPage"),
);
const NewRefundPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/adjustments/NewRefundPage"),
);
const ScholarshipsPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/adjustments/ScholarshipsPage"),
);
const ReportsCenterPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/reports/ReportsCenterPage"),
);
const ExpenseListPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/expenses/ExpenseListPage"),
);
const NewExpensePage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/expenses/NewExpensePage"),
);
const ExpenseDetailPage = lazyWithCatalogs(
  FINANCE_CATALOGS,
  () => import("../features/finance/expenses/ExpenseDetailPage"),
);
const AccountPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/account/AccountPage"),
);
const SessionsPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../features/account/sessions/SessionsPage"),
);
const DeleteAccountPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../features/account/privacy/DeleteAccountPage"),
);
const PrivacyPolicyPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/legal/PrivacyPolicyPage"),
);
const DeleteAccountInfoPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/legal/DeleteAccountInfoPage"),
);
const ConfirmAccountDeletionPage = lazyWithCatalogs(
  ONBOARDING_CATALOGS,
  () => import("../routes/legal/ConfirmAccountDeletionPage"),
);
const HelpHomePage = lazy(() => import("../features/help/HelpHomePage"));
const HelpArticlePage = lazy(() => import("../features/help/HelpArticlePage"));

/**
 * Application route tree, shared by the browser router (`main.tsx`) and the memory router used in
 * tests. Each top-level child is a route group with its own layout. To add a route, add a child to
 * the relevant group — or a new group object with its own layout.
 */
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      {
        element: <MarketingLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "features", element: <FeaturesPage /> },
          { path: "pricing", element: <PricingPage /> },
          { path: "about", element: <AboutPage /> },
          // Public: both app stores' listing forms require these to be reachable without an
          // account. See apps/mobile/store/review-checklist.md and privacy-labels.md.
          { path: "privacy", element: <PrivacyPolicyPage /> },
          { path: "legal/delete-account", element: <DeleteAccountInfoPage /> },
          // Where the emailed deletion link lands (ST-302).
          { path: "legal/delete-account/confirm", element: <ConfirmAccountDeletionPage /> },
          // School sign-up: Google/Microsoft sign-in, then the application form and its status.
          // Public; /signup/apply is authorized by the API's applicant cookie, not RequireAuth.
          { path: "signup", element: <SignupPage /> },
          { path: "signup/apply", element: <ApplyPage /> },
        ],
      },
      {
        path: "auth",
        children: [
          { path: "login", element: <AuthLoginPage /> },
          // The OAuth callbacks 302 here after a failed exchange, with the failure in `?code=`
          // (see oauth/error-redirect.ts and routes/auth/ErrorPage.tsx).
          { path: "error", element: <AuthErrorPage /> },
          { path: "callback", element: <AuthCallbackPage /> },
        ],
      },
      {
        // Public: the invitation token in the path is the credential (see
        // apps/api/src/modules/auth/routes/activation-oauth-routes.ts). No RequireAuth wrapper.
        path: "invite/:token",
        children: [
          { index: true, element: <InvitePage /> },
          { path: "complete", element: <InviteCompletePage /> },
        ],
      },
      {
        path: "onboarding",
        element: <OnboardingLayout />,
        children: [{ index: true, element: <OnboardingPage /> }],
      },
      {
        path: "onboarding/setup",
        element: (
          <RequireAuth>
            <DeletionPendingGate>
              <SetupWizardLayout />
            </DeletionPendingGate>
          </RequireAuth>
        ),
        children: [
          {
            index: true,
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <SetupWizardPage />
              </RequirePermission>
            ),
          },
        ],
      },
      {
        // Public help center, separate from the marketing shell — no `RequireAuth`.
        path: "help",
        element: <HelpLayout />,
        children: [
          { index: true, element: <HelpHomePage /> },
          { path: ":slug", element: <HelpArticlePage /> },
        ],
      },
      {
        path: "portal",
        element: (
          <RequireAuth>
            <DeletionPendingGate>
              <PortalLayout routes={() => routes} />
            </DeletionPendingGate>
          </RequireAuth>
        ),
        children: [
          { index: true, element: <PortalPage /> },
          // Studafy platform console. Reads gate on platform:read (SUPER_ADMIN only); each write
          // is additionally refused server-side without platform:manage.
          ...(
            [
              ["platform", <PlatformOverviewPage key="overview" />],
              ["platform/schools", <PlatformSchoolsListPage key="schools" />],
              ["platform/schools/:schoolId", <PlatformSchoolDetailPage key="school" />],
              ["platform/applications", <PlatformApplicationsPage key="applications" />],
              [
                "platform/applications/:applicationId",
                <PlatformApplicationDetailPage key="application" />,
              ],
              ["platform/inquiries", <PlatformInquiriesPage key="inquiries" />],
              ["platform/refunds", <PlatformRefundsPage key="refunds" />],
              ["platform/finance", <PlatformFinancePage key="finance" />],
              ["platform/ai", <PlatformAiUsagePage key="ai" />],
              ["platform/plans", <PlatformPlansPage key="plans" />],
              ["platform/settings", <PlatformSettingsPage key="settings" />],
              ["platform/users", <PlatformUserLookupPage key="users" />],
              // The license console (docs/billing/feature-licensing.md, session 4).
              ["platform/features", <PlatformFeaturesPage key="features" />],
              ["platform/tiers", <PlatformTiersPage key="tiers" />],
              ["platform/pricing", <PlatformPricingPage key="pricing" />],
              ["platform/quotes", <PlatformQuotesPage key="quotes" />],
              ["platform/licenses", <PlatformLicensesPage key="licenses" />],
              ["platform/payments", <PlatformPaymentsPage key="payments" />],
              ["platform/payments/:schoolId/:invoiceId", <PlatformInvoicePage key="invoice" />],
            ] as const
          ).map(([path, page]) => ({
            path,
            element: (
              <RequirePermission permission={PERMISSIONS.PLATFORM_READ}>{page}</RequirePermission>
            ),
          })),
          {
            path: "admin",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <AdminDashboardPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/users",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <UsersListPage />
              </RequirePermission>
            ),
          },
          {
            path: "accounts",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <StaffAccountsPage />
              </RequirePermission>
            ),
          },
          {
            path: "members",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <SchoolMembersPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/students",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <StudentsListPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/students/import",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <ImportStudentsPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/students/:studentId",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <StudentProfilePage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/parents/:parentUserId/records",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <AdminParentRecordsPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/timetable",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <TimetableBuilderPage />
              </RequirePermission>
            ),
          },
          {
            // Same permission and page as `principal/calendar`; ORG_ADMIN holds `calendarEvent:*`.
            path: "admin/calendar",
            element: (
              <RequirePermission permission={PERMISSIONS.CALENDAR_EVENT_READ}>
                <AdminSchoolCalendarPage />
              </RequirePermission>
            ),
          },
          {
            path: "admin/settings",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <SchoolSettingsPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `recordTemplate:manage`, not the admin console's own permission: the same
            // editor is mounted for a PRINCIPAL at `principal/school/records`.
            path: "admin/settings/records",
            element: (
              <RequirePermission permission={PERMISSIONS.RECORD_TEMPLATE_MANAGE}>
                <RecordTemplatesPage portal="admin" />
              </RequirePermission>
            ),
          },
          {
            path: "admin/records/missing",
            element: (
              <RequirePermission permission={PERMISSIONS.STUDENT_RECORD_READ}>
                <MissingInformationPage portal="admin" />
              </RequirePermission>
            ),
          },
          {
            // Gated on `notification:manage`, matching the API's own route
            // (apps/api/src/modules/announcements/routes.ts) rather than `organization:manageSettings`.
            path: "admin/announcements",
            element: (
              <RequirePermission permission={PERMISSIONS.NOTIFICATION_MANAGE}>
                <AnnouncementsPage />
              </RequirePermission>
            ),
          },
          {
            // School leadership view (approvals, attendance, discipline, evaluations,
            // announcements), held by PRINCIPAL and by ORG_ADMIN alongside its ops console. Gated on
            // its own permission so a PRINCIPAL gets these pages without the admin console.
            path: "principal",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalDashboardPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/discipline",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <IncidentListPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/discipline/:incidentId",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <IncidentDetailPage />
              </RequirePermission>
            ),
          },
          {
            // Parent <-> teacher message report review queue. Its own permission, held by
            // PRINCIPAL, ORG_ADMIN and SUPER_ADMIN.
            path: "principal/message-reports",
            element: (
              <RequirePermission permission={PERMISSIONS.MESSAGE_REPORT_REVIEW}>
                <MessageReportListPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/message-reports/:reportId",
            element: (
              <RequirePermission permission={PERMISSIONS.MESSAGE_REPORT_REVIEW}>
                <MessageReportDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/attendance",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <AttendanceDashboardView />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <EvaluationListPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations/templates",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <CriteriaTemplatesPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations/:evaluationId",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <EvaluationDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/grades",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalGradesPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/calendar",
            element: (
              <RequirePermission permission={PERMISSIONS.CALENDAR_EVENT_READ}>
                <SchoolCalendarPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/timetable",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalTimetablePage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/classes",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalClassesPage />
              </RequirePermission>
            ),
          },
          {
            // Grades, their per-year sections, and who is placed in each — the "Grade 10 – C" a
            // timetable is built for. Every write behind it requires `timetable:manage`.
            path: "principal/sections",
            element: (
              <RequirePermission permission={PERMISSIONS.TIMETABLE_MANAGE}>
                <GradesSectionsPage />
              </RequirePermission>
            ),
          },
          {
            // Academic grading setup for a year: readiness, grade subjects and rules, section
            // overrides, scales, approvals, results and certificates (sub-routes inside the page).
            // Reading needs `academicConfig:read`; each write is gated on its own permission.
            path: "principal/academic-setup/*",
            element: (
              <RequirePermission permission={PERMISSIONS.ACADEMIC_CONFIG_READ}>
                <AcademicSetupPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `recordTemplate:manage` rather than `principalDashboard:view`, matching the
            // admin mount at `admin/settings/records`.
            path: "principal/school/records",
            element: (
              <RequirePermission permission={PERMISSIONS.RECORD_TEMPLATE_MANAGE}>
                <RecordTemplatesPage portal="principal" />
              </RequirePermission>
            ),
          },
          {
            path: "principal/records/missing",
            element: (
              <RequirePermission permission={PERMISSIONS.STUDENT_RECORD_READ}>
                <MissingInformationPage portal="principal" />
              </RequirePermission>
            ),
          },
          {
            path: "principal/students",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalStudentsPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/students/:studentId",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalStudentPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/parents/:parentUserId",
            element: (
              <RequirePermission permission={PERMISSIONS.PRINCIPAL_DASHBOARD_VIEW}>
                <PrincipalParentPage />
              </RequirePermission>
            ),
          },
          {
            // The attendance office: daily registers for every class, corrections inside the
            // window, and attendance reports. Held by ATTENDANCE_OFFICER and ORG_ADMIN; its own
            // permission so an attendance officer gets these pages and nothing of the principal's.
            path: "attendance",
            element: (
              <RequirePermission permission={PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW}>
                <AttendanceOfficePage />
              </RequirePermission>
            ),
          },
          {
            path: "attendance/register/:classId",
            element: (
              <RequirePermission permission={PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW}>
                <AttendanceRegisterPage />
              </RequirePermission>
            ),
          },
          {
            path: "attendance/students/:studentId",
            element: (
              <RequirePermission permission={PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW}>
                <StudentAttendancePage />
              </RequirePermission>
            ),
          },
          {
            // The full reports view (exports, grids) stays with the roles that export attendance:
            // the attendance officer, principal and school admin. Teachers use the dashboard.
            path: "attendance/reports",
            element: (
              <RequirePermission permission={PERMISSIONS.ATTENDANCE_REPORT_EXPORT}>
                <AttendanceOfficeReportsPage />
              </RequirePermission>
            ),
          },
          {
            path: "approvals",
            element: (
              <RequirePermission permission={PERMISSIONS.APPROVAL_REVIEW}>
                <ApprovalQueuePage />
              </RequirePermission>
            ),
          },
          // The school's feature license (docs/billing/feature-licensing.md, session 5): ORG_ADMIN
          // and PRINCIPAL hold `license:read`; each page gates its changes on `license:manage`.
          ...(
            [
              ["license", <LicensePage key="license" />],
              ["license/seats", <LicenseSeatsPage key="seats" />],
              ["license/quotes", <LicenseQuotesPage key="quotes" />],
              ["license/quotes/:quoteId", <LicenseQuotePage key="quote" />],
              ["license/invoices", <LicenseInvoicesPage key="invoices" />],
              ["license/invoices/:invoiceId", <LicenseInvoicePage key="invoice" />],
            ] as const
          ).map(([path, page]) => ({
            path,
            element: (
              <RequirePermission permission={PERMISSIONS.LICENSE_READ}>{page}</RequirePermission>
            ),
          })),
          {
            // The palette's "See all" results. No `RequirePermission`, the same posture as
            // `GET /api/search` itself: every session may search, and the API scopes each record
            // type to the caller's permissions and row-level security.
            path: "search",
            element: <SearchResultsPage />,
          },
          {
            // No `RequirePermission` — self-service on the caller's own rows, matching the API's
            // own no-gate posture (see `notificationRoutes`'s doc comment). Every authenticated
            // session sees its own inbox regardless of role.
            path: "notifications",
            element: <NotificationInboxPage />,
          },
          {
            // Same no-gate posture as above (see `notificationPreferencesRoutes`'s doc comment).
            path: "notifications/preferences",
            element: <NotificationPreferencesPage />,
          },
          {
            // Gated on the same permission the finance report endpoints themselves require
            // (`REPORT_VIEW_FINANCIAL` — see apps/api/src/modules/finance/reports/routes.ts), which
            // the FINANCE role and ORG_ADMIN both hold.
            path: "finance",
            element: (
              <RequirePermission permission={PERMISSIONS.REPORT_VIEW_FINANCIAL}>
                <FinanceDashboardPage />
              </RequirePermission>
            ),
          },
          {
            path: "finance/overdue",
            element: (
              <RequirePermission permission={PERMISSIONS.REPORT_VIEW_FINANCIAL}>
                <FinanceOverdueInstallmentsPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update`, matching the fee-structure gateway routes themselves
            // (apps/api/src/modules/finance/fee-structures/routes.ts) rather than the dashboard's
            // read-only `report:viewFinancial` — building/editing a structure is a write.
            path: "finance/fees",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <FeeStructureBuilderPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the invoice gateway's own read routes
            // (apps/api/src/modules/finance/invoices/routes.ts).
            path: "finance/invoices",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <InvoiceListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — starting a batch calls ERPNext on the caller's behalf,
            // the same write gate `POST /api/finance/invoices/batches` itself requires. React
            // Router ranks this static path ahead of the `:invoiceId` route below regardless of
            // registration order, so "batches" never matches as an invoice id.
            path: "finance/invoices/batches/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <InvoiceBatchPage />
              </RequirePermission>
            ),
          },
          {
            path: "finance/invoices/:invoiceId",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <InvoiceDetailPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the family finance API's read routes
            // (apps/api/src/modules/finance/family-accounts/routes.ts).
            path: "finance/families",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <FamiliesListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, like the families list it complements and the read routes
            // behind it (apps/api/src/modules/finance/unlinked/routes.ts).
            path: "finance/unlinked",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <UnlinkedPage />
              </RequirePermission>
            ),
          },
          {
            path: "finance/families/:familyId",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <FamilyDetailPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — one family payment posts a Payment Entry per invoice to
            // ERPNext, the same write gate `POST /api/finance/families/{familyId}/payments` requires.
            path: "finance/families/:familyId/payments/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <RecordFamilyPaymentPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the payment gateway's own read routes
            // (apps/api/src/modules/finance/payments/routes.ts).
            path: "finance/payments",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <PaymentsListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — recording a payment posts a Payment Entry to ERPNext on
            // the caller's behalf, the same write gate `POST /api/finance/payments` itself
            // requires. Static path, so React Router matches it ahead of any future dynamic
            // `finance/payments/:paymentId` regardless of registration order, same as
            // `finance/invoices/batches/new` above.
            path: "finance/payments/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <RecordPaymentPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the refund gateway's own read routes
            // (apps/api/src/modules/finance/refunds/routes.ts). Approving or rejecting a pending
            // refund (the checker step) requires the stricter `billing:refund` — enforced both by
            // the API route itself and, client-side, by `RefundsListPage`'s own row actions.
            path: "finance/adjustments/refunds",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <RefundsListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — initiating a refund is the maker step, the same write gate
            // `POST /api/finance/refunds/initiate` itself requires.
            path: "finance/adjustments/refunds/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <NewRefundPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the scholarship API's read routes. Requesting an award
            // needs `billing:update` and deciding one `billing:approveScholarship` (ORG_ADMIN) — both
            // enforced by the API and reflected by `ScholarshipsPage`'s own controls.
            path: "finance/scholarships",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <ScholarshipsPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on the same `report:viewFinancial` the report endpoints themselves require —
            // matching `finance`'s own gate above. Export additionally requires `report:export`,
            // enforced both by the API route and, client-side, by `ExportPanel` hiding the download
            // controls from a viewer who only has read access.
            path: "finance/reports",
            element: (
              <RequirePermission permission={PERMISSIONS.REPORT_VIEW_FINANCIAL}>
                <ReportsCenterPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:read`, matching the expense gateway's own read routes
            // (apps/api/src/modules/finance/expenses/routes.ts).
            path: "finance/expenses",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <ExpenseListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — recording an expense posts to ERPNext on the caller's
            // behalf, the same write gate `POST /api/finance/expenses` itself requires. Static path,
            // so React Router matches it ahead of `finance/expenses/:expenseId` regardless of
            // registration order, same as `finance/payments/new`'s own note above.
            path: "finance/expenses/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <NewExpensePage />
              </RequirePermission>
            ),
          },
          {
            path: "finance/expenses/:expenseId",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <ExpenseDetailPage />
              </RequirePermission>
            ),
          },
        ],
      },
      {
        path: "account",
        element: (
          <RequireAuth>
            <DeletionPendingGate>
              <AccountLayout />
            </DeletionPendingGate>
          </RequireAuth>
        ),
        children: [
          { index: true, element: <AccountPage /> },
          {
            // Account security: every live session and registered device for the caller, with a
            // current-device indicator and revoke actions. No `RequirePermission`, same as the rest
            // of `/account` (STUDENT and PARENT hold no distinct permission set of their own, and
            // the API's own tenant scoping is what actually restricts a session to its own school).
            path: "sessions",
            element: <SessionsPage />,
          },
          {
            // Self-service account deletion — no `RequirePermission`, same posture as the rest of
            // `/account`: the caller can only ever act on their own account, enforced by the API
            // (`POST /api/privacy/me/dsr` is bearer-authenticated only, the subject is always the
            // caller, never a body parameter).
            path: "delete",
            element: <DeleteAccountPage />,
          },
          // No `/account/ai`: buying the AI add-on on the website is switched off for now — it is
          // sold only in the mobile app. `features/billing/AiSubscriptionPurchasePage` is kept for
          // when it comes back (route it here and restore the tile in `AccountPage`).
        ],
      },
    ],
  },
];
