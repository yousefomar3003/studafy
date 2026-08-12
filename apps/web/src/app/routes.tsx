import { lazy } from "react";

import { RouteError } from "../components/RouteError";
import { AccountLayout } from "../layouts/AccountLayout";
import { MarketingLayout } from "../layouts/MarketingLayout";
import { OnboardingLayout } from "../layouts/OnboardingLayout";
import { PortalLayout } from "../layouts/PortalLayout";
import { RootLayout } from "../layouts/RootLayout";
import { RequireAuth } from "../lib/auth";
import HomePage from "../routes/marketing/HomePage";

import type { RouteObject } from "react-router-dom";

// Secondary route groups are code-split so the initial (marketing) route stays small.
const AuthLoginPage = lazy(() => import("../routes/auth/LoginPage"));
const AuthCallbackPage = lazy(() => import("../routes/auth/CallbackPage"));
const OnboardingPage = lazy(() => import("../routes/onboarding/OnboardingPage"));
const PortalPage = lazy(() => import("../routes/portal/PortalPage"));
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
        children: [{ index: true, element: <HomePage /> }],
      },
      {
        path: "auth",
        children: [
          { path: "login", element: <AuthLoginPage /> },
          { path: "callback", element: <AuthCallbackPage /> },
        ],
      },
      {
        path: "onboarding",
        element: <OnboardingLayout />,
        children: [{ index: true, element: <OnboardingPage /> }],
      },
      {
        path: "portal",
        element: (
          <RequireAuth>
            <PortalLayout />
          </RequireAuth>
        ),
        children: [{ index: true, element: <PortalPage /> }],
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
