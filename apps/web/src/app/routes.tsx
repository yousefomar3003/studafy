import { PERMISSIONS } from "@studafy/constants";
import { lazy } from "react";

import { RouteError } from "../components/RouteError";
import { AccountLayout } from "../layouts/AccountLayout";
import { MarketingLayout } from "../layouts/MarketingLayout";
import { OnboardingLayout } from "../layouts/OnboardingLayout";
import { PortalLayout } from "../layouts/PortalLayout";
import { RootLayout } from "../layouts/RootLayout";
import { SetupWizardLayout } from "../layouts/SetupWizardLayout";
import { RequireAuth, RequirePermission } from "../lib/auth";
import HomePage from "../routes/marketing/HomePage";

import type { RouteObject } from "react-router-dom";

// Secondary route groups are code-split so the initial (marketing) route stays small.
const FeaturesPage = lazy(() => import("../routes/marketing/FeaturesPage"));
const PricingPage = lazy(() => import("../routes/marketing/PricingPage"));
const AboutPage = lazy(() => import("../routes/marketing/AboutPage"));
const AuthLoginPage = lazy(() => import("../routes/auth/LoginPage"));
const AuthCallbackPage = lazy(() => import("../routes/auth/CallbackPage"));
const AuthErrorPage = lazy(() => import("../routes/auth/ErrorPage"));
const InvitePage = lazy(() => import("../routes/invite/InvitePage"));
const InviteCompletePage = lazy(() => import("../routes/invite/InviteCompletePage"));
const OnboardingPage = lazy(() => import("../routes/onboarding/OnboardingPage"));
const SetupWizardPage = lazy(() => import("../routes/onboarding-setup/SetupWizardPage"));
const PortalPage = lazy(() => import("../routes/portal/PortalPage"));
const AdminDashboardPage = lazy(() => import("../features/admin/AdminDashboardPage"));
const UsersListPage = lazy(() => import("../features/admin/users/UsersListPage"));
const InvitationsListPage = lazy(() => import("../features/admin/invitations/InvitationsListPage"));
const StudentsListPage = lazy(() => import("../features/admin/students/StudentsListPage"));
const StudentProfilePage = lazy(() => import("../features/admin/students/StudentProfilePage"));
const ImportStudentsPage = lazy(() => import("../features/admin/students/ImportStudentsPage"));
const TimetableBuilderPage = lazy(() => import("../features/admin/timetable/TimetableBuilderPage"));
const SchoolSettingsPage = lazy(() => import("../features/admin/settings/SchoolSettingsPage"));
const AuditLogExplorerPage = lazy(() => import("../features/admin/audit/AuditLogExplorerPage"));
const AnnouncementsPage = lazy(() => import("../features/admin/announcements/AnnouncementsPage"));
const PrincipalDashboardPage = lazy(() => import("../features/principal/PrincipalDashboardPage"));
const IncidentListPage = lazy(() => import("../features/principal/discipline/IncidentListPage"));
const IncidentDetailPage = lazy(
  () => import("../features/principal/discipline/IncidentDetailPage"),
);
const AttendanceDashboardView = lazy(
  () => import("../features/principal/attendance/views/AttendanceDashboardView"),
);
const EvaluationListPage = lazy(
  () => import("../features/principal/evaluations/EvaluationListPage"),
);
const EvaluationDetailPage = lazy(
  () => import("../features/principal/evaluations/EvaluationDetailPage"),
);
const CriteriaTemplatesPage = lazy(
  () => import("../features/principal/evaluations/CriteriaTemplatesPage"),
);
const ApprovalQueuePage = lazy(() => import("../features/principal/approvals/ApprovalQueuePage"));
const FinanceDashboardPage = lazy(() => import("../features/finance/FinanceDashboardPage"));
const FinanceOverdueInstallmentsPage = lazy(
  () => import("../features/finance/FinanceOverdueInstallmentsPage"),
);
const FeeStructureBuilderPage = lazy(
  () => import("../features/finance/fees/FeeStructureBuilderPage"),
);
const InvoiceListPage = lazy(() => import("../features/finance/invoices/InvoiceListPage"));
const InvoiceDetailPage = lazy(() => import("../features/finance/invoices/InvoiceDetailPage"));
const InvoiceBatchPage = lazy(() => import("../features/finance/invoices/InvoiceBatchPage"));
const PaymentsListPage = lazy(() => import("../features/finance/payments/PaymentsListPage"));
const RecordPaymentPage = lazy(() => import("../features/finance/payments/RecordPaymentPage"));
const ScholarshipAwardsListPage = lazy(
  () => import("../features/finance/adjustments/ScholarshipAwardsListPage"),
);
const NewScholarshipAwardPage = lazy(
  () => import("../features/finance/adjustments/NewScholarshipAwardPage"),
);
const RefundsListPage = lazy(() => import("../features/finance/adjustments/RefundsListPage"));
const NewRefundPage = lazy(() => import("../features/finance/adjustments/NewRefundPage"));
const ExpenseListPage = lazy(() => import("../features/finance/expenses/ExpenseListPage"));
const NewExpensePage = lazy(() => import("../features/finance/expenses/NewExpensePage"));
const ExpenseDetailPage = lazy(() => import("../features/finance/expenses/ExpenseDetailPage"));
const AccountPage = lazy(() => import("../routes/account/AccountPage"));

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
        // Post-activation: the admin is already signed in, unlike the public registration flow above.
        path: "onboarding/setup",
        element: (
          <RequireAuth>
            <SetupWizardLayout />
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
        path: "portal",
        element: (
          <RequireAuth>
            <PortalLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <PortalPage /> },
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
            path: "admin/invitations",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <InvitationsListPage />
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
            path: "admin/timetable",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <TimetableBuilderPage />
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
            // Gated on the specific `auditLog:read` permission, not `organization:manageSettings` —
            // FINANCE and SUPPORT_AGENT hold the former without the latter (see
            // `packages/constants/src/permissions.ts`) and are meant to reach this page directly.
            path: "admin/audit",
            element: (
              <RequirePermission permission={PERMISSIONS.AUDIT_LOG_READ}>
                <AuditLogExplorerPage />
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
            // Same gate as "Admin" — there is no distinct PRINCIPAL role/permission (see
            // nav-items.ts). A leadership-facing view (approvals, attendance, discipline,
            // announcements) alongside the ops-facing admin console, not a replacement for it.
            path: "principal",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <PrincipalDashboardPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/discipline",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <IncidentListPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/discipline/:incidentId",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <IncidentDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/attendance",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <AttendanceDashboardView />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <EvaluationListPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations/templates",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <CriteriaTemplatesPage />
              </RequirePermission>
            ),
          },
          {
            path: "principal/evaluations/:evaluationId",
            element: (
              <RequirePermission permission={PERMISSIONS.ORGANIZATION_MANAGE_SETTINGS}>
                <EvaluationDetailPage />
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
            // Gated on `billing:read`, matching the scholarship/award gateway's own read routes
            // (apps/api/src/modules/finance/scholarships/routes.ts). Confirming a pending award (the
            // checker step) still requires `billing:update` — enforced both by the route the API
            // itself requires and, client-side, by `ScholarshipAwardsListPage`'s own row actions.
            path: "finance/adjustments/scholarships",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_READ}>
                <ScholarshipAwardsListPage />
              </RequirePermission>
            ),
          },
          {
            // Gated on `billing:update` — awarding a scholarship/discount is the maker step, the
            // same write gate `POST /api/finance/scholarship-discounts/awards` itself requires.
            // Static path, matching `finance/payments/new`'s own note on why registration order
            // doesn't matter here (no dynamic `:awardId` segment to collide with).
            path: "finance/adjustments/scholarships/new",
            element: (
              <RequirePermission permission={PERMISSIONS.BILLING_UPDATE}>
                <NewScholarshipAwardPage />
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
            <AccountLayout />
          </RequireAuth>
        ),
        children: [{ index: true, element: <AccountPage /> }],
      },
    ],
  },
];
