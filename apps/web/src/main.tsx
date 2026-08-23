import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { AppProviders } from "./app/providers";
import { routes } from "./app/routes";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initMonitoring, triggerTestErrorFromQueryParam } from "./lib/monitoring";

import "@studafy/ui/styles.css";

import "./layouts/marketing/marketing-shell.css";
import "./layouts/portal/portal-shell.css";
import "./routes/marketing/marketing-pages.css";
import "./styles/global.css";

initMonitoring();
triggerTestErrorFromQueryParam(window.location.search);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

const router = createBrowserRouter(routes);

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </ErrorBoundary>
  </StrictMode>,
);
