import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

import { AppProviders } from "./app/providers";
import { routes } from "./app/routes";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { prepareLocale } from "./lib/i18n";
import { i18next } from "./lib/i18n/i18next";
import { initMonitoring, triggerTestErrorFromQueryParam } from "./lib/monitoring";

import "@fontsource-variable/inter";
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

function render(container: HTMLElement) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <AppProviders>
          <RouterProvider router={router} />
        </AppProviders>
      </ErrorBoundary>
    </StrictMode>,
  );
}

// English ships in the entry bundle, so this resolves at once for it; a saved non-English locale
// fetches its shell catalog first so the first paint is already in that language. A failed fetch
// still renders (i18next falls back to English) rather than leaving a blank page.
void prepareLocale(i18next.language).finally(() => render(rootElement));
