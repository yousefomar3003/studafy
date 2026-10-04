import { ToastProvider, UiStringsProvider } from "@studafy/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState, type PropsWithChildren } from "react";

import { AuthProvider, sessionStore, useAuthStatus } from "../lib/auth";
import { LocaleProvider, useTranslation } from "../lib/i18n";
import { MonitoringUserSync } from "../lib/monitoring";
import { RealtimeClient, RealtimeProvider } from "../lib/realtime";

import { createQueryClient } from "./query-client";

import type { SessionStore } from "../lib/auth";
import type { RealtimeClientOptions, RealtimeSocket } from "../lib/realtime";

/**
 * Composes all app-wide providers in one place. Add new context providers here so the rest of the
 * app never wires them directly. The query client is created once per app instance; the realtime
 * socket client is built against it so live events can invalidate server state (see
 * `src/lib/realtime/invalidations.ts`).
 *
 * The session store defaults to the app-wide singleton, but callers may inject one (tests build a
 * store over an in-memory refresh client). The same store feeds both the `AuthProvider` and the
 * realtime handshake token — the socket authenticates as the active session and stays disconnected
 * (`unauthorized`) while signed out. `realtimeSocketFactory` is a test seam threaded through to the
 * `RealtimeClient`; production uses the browser `WebSocket`.
 *
 * `LocaleProvider` sits outermost: it sets `<html lang dir>` from the persisted locale, and every
 * provider below it (and the routed tree) may render translated text or logical-property layout that
 * depends on that attribute already being correct.
 *
 * `MonitoringUserSync` renders nothing; it sits inside `AuthProvider` purely so
 * `useSyncMonitoringUser` (`lib/monitoring`) can read the session and keep Sentry's user context —
 * the session's own id, nothing else — aligned with sign-in/sign-out.
 */
export function AppProviders({
  children,
  sessionStore: sessionStoreOverride,
  realtimeSocketFactory,
}: PropsWithChildren<{
  sessionStore?: SessionStore;
  realtimeSocketFactory?: RealtimeClientOptions["socketFactory"];
}>) {
  const store = sessionStoreOverride ?? sessionStore;
  const [queryClient] = useState(createQueryClient);
  const [realtimeClient] = useState(
    () =>
      new RealtimeClient({
        baseUrl: import.meta.env.VITE_REALTIME_BASE_URL ?? "ws://localhost:3001",
        getToken: () => store.getToken(),
        queryClient,
        ...(realtimeSocketFactory ? { socketFactory: realtimeSocketFactory } : {}),
      }),
  );

  return (
    <LocaleProvider>
      <TranslatedUiStrings>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AuthProvider store={store}>
              <MonitoringUserSync />
              <SessionRealtimeProvider client={realtimeClient}>{children}</SessionRealtimeProvider>
            </AuthProvider>
          </ToastProvider>
        </QueryClientProvider>
      </TranslatedUiStrings>
    </LocaleProvider>
  );
}

/**
 * Feeds the `@studafy/ui` components' built-in strings (close/dismiss labels, table empty and loading
 * states, filter-bar labels, select placeholder) from the `ui.*` catalog, rebuilt whenever the active
 * language changes so the kit follows a runtime switch like the rest of the app.
 */
function TranslatedUiStrings({ children }: PropsWithChildren) {
  const { t, i18n } = useTranslation();
  const strings = useMemo(
    () => ({
      closeDialog: t("ui.closeDialog"),
      dismissToast: (title: string) => t("ui.dismissToast", { title }),
      removeChip: (label: string) => t("ui.removeChip", { label }),
      removeItem: t("ui.removeItem"),
      selectRow: (label: string) => t("ui.selectRow", { label }),
      selectRowFallback: t("ui.selectRowFallback"),
      selectAllRows: t("ui.selectAllRows"),
      selectPlaceholder: t("ui.selectPlaceholder"),
      tableLoading: t("ui.tableLoading"),
      tableEmpty: t("ui.tableEmpty"),
      filterSearch: t("ui.filterSearch"),
      filterDateRange: t("ui.filterDateRange"),
      filterDateFrom: t("ui.filterDateFrom"),
      filterDateTo: t("ui.filterDateTo"),
      filterClearAll: t("ui.filterClearAll"),
    }),
    // `i18n.language` is the dependency that matters: `t` is stable across a language switch.
    [t, i18n.language],
  );
  return <UiStringsProvider strings={strings}>{children}</UiStringsProvider>;
}

/**
 * Connects the realtime socket only while the session is authenticated. The session store restores
 * lazily (a guard or an authenticated request asks first), so connecting unconditionally on mount
 * would make every public page — the marketing home included — call the refresh endpoint just to
 * learn there is no session. Signing out (or the session expiring) disconnects the socket.
 */
function SessionRealtimeProvider({
  client,
  children,
}: PropsWithChildren<{ client: RealtimeClient }>) {
  const status = useAuthStatus();
  return (
    <RealtimeProvider client={client} enabled={status === "authenticated"}>
      {children}
    </RealtimeProvider>
  );
}

/**
 * An inert socket for routing/component tests: never opens, never closes, never dials the network.
 * Handlers are retained but not fired, which keeps the client in its initial state with no retry
 * timers. Mirrors `RealtimeSocket`'s contract without reaching for a real connection.
 */
export function createInertRealtimeSocket(): RealtimeSocket {
  return {
    readyState: 0,
    send() {
      return;
    },
    close() {
      return;
    },
    onOpen() {
      return () => undefined;
    },
    onMessage() {
      return () => undefined;
    },
    onClose() {
      return () => undefined;
    },
    onError() {
      return () => undefined;
    },
  };
}
