# Offline cache strategy

This document covers the offline cache layer at `lib/src/core/offline` — a Drift (SQLite) cache
that lets timetable, published grades, materials, and announcements screens show data with no
network, then reconcile once one is available.

## Model: cache-aside, reconciled in the background

There is exactly one cache table, `CacheEntries` (`offline_database.dart`), storing one row per
`(resource, cacheKey)` pair:

| Column      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------- |
| `resource`  | A domain namespace, e.g. `"materials"`, `"timetable_slots"`         |
| `cacheKey`  | The scope within that namespace, e.g. a class ID, `"studentId:termId"` |
| `payload`   | The cached API response, JSON-encoded                               |
| `fetchedAt` | When that payload was last confirmed against the server              |

The payload is stored as opaque JSON rather than as typed columns per resource: the shape of each
resource already lives in its generated model (`core/api/generated/models/*.dart`), and its
`toJson`/`fromJson` is the codec. Adding a table per resource would just re-declare those same
fields in SQL for no benefit.

All cache policy — read, refresh, fall back, reconcile — lives once in
`OfflineCachedResource<T>` (`offline_cached_resource.dart`). Each domain repository
(`timetable_offline_repository.dart`, `published_grades_offline_repository.dart`,
`materials_offline_repository.dart`, `announcements_offline_repository.dart`) is a thin adapter
over it: it supplies the resource's JSON codec and the one API call that fills it.

## Reading a resource

Call a repository's method (e.g. `MaterialsOfflineRepository.materialsForClass(classId)`). It
returns a `Stream<CachedValue<T>>` that:

1. Immediately yields whatever is cached for that key, if anything — `CachedValue.source ==
   CacheSource.cache` — so the UI has something to render before the network round-trip even
   starts.
2. Then attempts the live API call.
   - On success: writes the fresh response to the cache and yields it with
     `CacheSource.network`. This is the reconciliation step — the cached row is
     now caught up.
   - On failure (no connectivity, timeout, server error): yields whatever is cached instead, still
     tagged `CacheSource.cache`. If nothing was ever cached for that key, the error propagates —
     there's nothing to fall back to.

`CachedValue.isStale` is `true` exactly when `source == CacheSource.cache`. A screen shows
`StalenessBanner` (`staleness_banner.dart`) whenever the value it's rendering is stale — that
single flag is what airplane mode looks like from the UI's side: the cached list renders, banner
shows "Showing saved data — updated 3m ago", and the label updates when a later `sync()` call
confirms fresh data and the banner disappears.

There's no separate "am I online" check anywhere in this layer. Whether a request succeeded or
failed is discovered by making it — checking connectivity first would only ever tell you about the
network interface, not whether the API is actually reachable, so it can't replace this.

## Background refresh

"Background refresh" here means: the UI never blocks on the network to show something. A screen's
notifier calls `sync()` once when it needs data; the first (cached) emission paints the screen
immediately, and the second (network) emission — whenever it lands — reconciles it. A pull-to-
refresh, a realtime "grades published" event, or an app-resume hook are all just additional callers
of the same `refresh()` — there's no separate polling scheduler to keep in sync with the cache
itself.

## Clearing on logout

`offlineDatabaseProvider` (`offline_providers.dart`) listens for `authStatusProvider` transitioning
from `authenticated` to `unauthenticated` and calls `OfflineDatabase.clearAll()` at that moment —
the same `ref.listen`-inside-a-provider pattern `app_providers.dart`'s `routerProvider` uses for
its own auth-driven side effect. This is deliberately a full wipe, not per-user partitioning:
cached school data must never be reachable from a different account that later signs in on the same
device, so there's nothing to gain from keeping it around keyed by user.

## Adding a new cached resource

1. Pick a `resource` namespace string and a `cacheKey` shape (usually whatever scopes the API
   call — a class ID, a `"parentId:childId"` pair, etc).
2. Write a repository the same shape as the four in this directory: construct an
   `OfflineCachedResource<T>` with `encode`/`decode` built on the model's own `toJson`/`fromJson`,
   and expose a `sync(...)` method that calls the one API endpoint it caches.
3. Wire a provider for it in `offline_providers.dart`, watching `offlineDatabaseProvider` and the
   relevant generated API client — same shape as the existing four.

Don't reach for a new Drift table — `CacheEntries` is generic on purpose.
