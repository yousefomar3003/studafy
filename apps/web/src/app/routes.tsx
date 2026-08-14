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
const ApprovalsPage = lazy(() => import("../routes/portal/ApprovalsPage"));
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
            path: "approvals",
            element: (
              <RequirePermission permission={PERMISSIONS.APPROVAL_REVIEW}>
                <ApprovalsPage />
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
