# @studafy/web

Studafy's web client — a Vite + React 18 + TypeScript single-page app. This is the application
**shell**: routing, providers, and error/loading states. Real screens are added per feature ticket.

## Local development

```sh
bun run dev          # start the Vite dev server (http://localhost:5173)
bun run build        # production build to dist/
bun run preview      # serve the production build locally
bun run check-types  # tsc --noEmit
bun run lint         # eslint .
bun test             # bun test (happy-dom + @testing-library/react)
```

## Route map

Routes are declared in [`src/app/routes.tsx`](src/app/routes.tsx). Every group nests under the
shared [`RootLayout`](src/layouts/RootLayout.tsx) (skip link, primary nav, `<main>`).

| Path          | Group      | Page                                                         | Loading    |
| ------------- | ---------- | ------------------------------------------------------------ | ---------- |
| `/`           | marketing  | [`HomePage`](src/routes/marketing/HomePage.tsx)              | eager      |
| `/onboarding` | onboarding | [`OnboardingPage`](src/routes/onboarding/OnboardingPage.tsx) | lazy chunk |
| `/portal`     | portal     | [`PortalPage`](src/routes/portal/PortalPage.tsx)             | lazy chunk |
| `/account`    | account    | [`AccountPage`](src/routes/account/AccountPage.tsx)          | lazy chunk |

## Where to add new routes

- **New page in an existing group:** add a child route to that group in `src/app/routes.tsx` and
  create the page under `src/routes/<group>/`. Page components use a **default export** so they can
  be `React.lazy`-loaded.
- **New group:** add a top-level child object with its own layout under `src/layouts/`, then add the
  group to the primary nav in `RootLayout` if it should be linked.

## Provider structure

Providers are isolated in [`src/app/providers.tsx`](src/app/providers.tsx) (`AppProviders`) so the
rest of the app never wires context directly:

```
StrictMode
└─ ErrorBoundary            // src/components/ErrorBoundary.tsx — render/provider errors
   └─ AppProviders          // src/app/providers.tsx
      └─ QueryClientProvider // TanStack Query (client from src/app/query-client.ts)
         └─ RealtimeProvider // RealtimeClient (src/lib/realtime) + useRealtime hooks
            └─ RouterProvider   // route-level errors via RouteError (errorElement)
```

Add new app-wide providers inside `AppProviders`.

## Realtime client

`src/lib/realtime/` implements the WebSocket client for the gateway (`apps/realtime`):

| Module             | Responsibility                                                    |
| ------------------ | ----------------------------------------------------------------- |
| `protocol.ts`      | Wire grammar (`EventEnvelope`, system messages), close-code 4401. |
| `client.ts`        | `RealtimeClient`: auth, jittered-backoff reconnect, resubscribe.  |
| `invalidations.ts` | Event name → TanStack Query invalidation map.                     |
| `backoff.ts`       | Pure reconnect delay computation.                                 |
| `connection.tsx`   | `RealtimeProvider` + `useRealtime` / `useRealtimeConnection`.     |

`AppProviders` wires one `RealtimeClient` behind the query client. The base URL comes from
`VITE_REALTIME_BASE_URL` (default `ws://localhost:3001`); auth is supplied by
`getRealtimeToken()` (`src/lib/realtime/token.ts`).

### Query-key contract

When an event arrives, the client invalidates every query whose key starts with one of the event's
prefixes in `EVENT_QUERY_INVALIDATIONS`, and — on a successful reconnect — all mapped prefixes.

| Wire event         | Query-key prefixes invalidated     |
| ------------------ | ---------------------------------- |
| `grades.published` | `["approval-queue"]`, `["grades"]` |

New screens that consume server state should use a prefix covered here (or extend the map alongside
a gateway route in `apps/realtime/src/event-routing.ts`); otherwise their data goes stale until the
next reconnect.

## Shared schemas

`@studafy/shared-schemas` (Zod primitives) is a dependency used by the realtime wire validation and
will be shared as more routes need it. Import the workspace package rather than redefining schema
primitives locally.

## Build-size expectation

The initial route (`/`) must stay **well under 300 KB gzip**. React + React Router + TanStack Query
core is roughly 70 KB gzip; the onboarding/portal/account groups are separate lazy chunks and do not
count against the initial route. Keep it that way — prefer lazy route groups and avoid heavy deps.
