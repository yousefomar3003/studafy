# i18n and RTL contribution guide

English (LTR) and Arabic (RTL) support for the web app, built on `i18next` / `react-i18next`. The
moving parts:

| Layer            | File(s)                                   | Responsibility                                                             |
| ---------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| Config           | `src/lib/i18n/config.ts`                  | The `Locale` union, its direction map, and the switcher's display labels   |
| Locale store     | `src/lib/i18n/store.ts`                   | Which locale is active, persisted to `localStorage`, subscribable          |
| i18next instance | `src/lib/i18n/i18next.ts`                 | Bundles `en.json`/`ar.json` (and, in dev, the pseudo-locale) synchronously |
| React wiring     | `src/lib/i18n/context.tsx`                | `LocaleProvider` (syncs `<html lang dir>`), `useLocale`                    |
| Formatting       | `src/lib/i18n/format.ts`                  | `Intl`-backed date/number/currency helpers, locale-aware                   |
| Message catalogs | `src/lib/i18n/locales/en.json`, `ar.json` | Translated strings, one flat namespace                                     |
| Pseudo-locale    | `src/lib/i18n/locales/qps-ploc.json`      | Generated QA locale — see "Pseudo-locale" below                            |
| Switcher UI      | `src/layouts/portal/LocaleSwitcher.tsx`   | The only control that calls `setLocale`                                    |
| Wiring           | `src/app/providers.tsx`                   | Mounts `LocaleProvider` outermost, before anything can render text         |

## Adding or changing a translated string

1. Add the key to `src/lib/i18n/locales/en.json`, nested under the component/feature it belongs to
   (see the existing `nav`, `userMenu`, `notificationBell` groups). Keep keys canonical: name the
   thing, not the screen it happens to appear on today.
2. Add the same key to `ar.json` with a real Arabic translation — not a copy of the English string.
   A missing Arabic key silently falls back to English (`fallbackLng` in `i18next.ts`), which will
   pass CI but ships an untranslated string, so don't rely on the fallback as a substitute for
   translating it.
3. In the component, call `useTranslation()` from `../../lib/i18n` (not directly from
   `"react-i18next"` — the barrel is the one place allowed to know the package exists) and render
   `t("your.key")`.
4. Regenerate the pseudo-locale: `bun run --cwd apps/web i18n:pseudo`. A test
   (`locales/pseudo-locale.test.ts`) fails CI if you forget.

**Never translate user data.** Notification titles/bodies, student names, uploaded document text,
anything that came from the database — none of it goes through `t()`. This is a UI-string layer
only; see `NotificationBell.tsx` for the boundary in practice (the chrome around a notification is
translated, `notification.title`/`notification.body` are rendered as-is).

**Plurals**: don't hand-roll `count === 1 ? "" : "s"`. Use i18next's plural-key suffixes
(`_zero`/`_one`/`_two`/`_few`/`_many`/`_other`, whichever your language's CLDR category set actually
needs) and pass `{ count }` to `t()`. Arabic has six plural categories, not two — see
`deviceSessions.activeSessions_*` in `ar.json` for a real example. This is also why it's wrong to
translate by having someone copy the English `.json` file's shape and fill in strings 1:1 without
checking whether the target language's plural or gender rules need more keys than English does.

## Adding a locale

There is no plugin architecture here — a third locale is a checklist:

1. Add its code to `SUPPORTED_LOCALES` in `config.ts`, and its direction to `LOCALE_DIRECTION` (most
   are `"ltr"`; the RTL set is small — see the Unicode CLDR).
2. Add its display name to `LOCALE_LABELS`, in its own script (a language names itself; don't
   translate the label).
3. Add `src/lib/i18n/locales/<code>.json` with every key `en.json` has.
4. Register it in `i18next.ts`'s `resources` map.
5. Update `apps/api/src/middleware/locale.ts`'s `SupportedLocale` too if the API-side error catalog
   should also speak it — the two lists are related but not shared by a package, so they don't
   update each other automatically.

## Pseudo-locale

`qps-ploc.json` is generated from `en.json` by `locales/generate-pseudo-locale.ts` — accents every
letter and pads the string ~35% longer, wrapped in brackets, so a layout that clips text or a
template that silently drops a string is obvious without reading Arabic. It's registered as an
i18next language only in dev builds (`import.meta.env.DEV` in `i18next.ts`) and is deliberately not
part of the `Locale` union: it never appears in the locale switcher and never touches `dir` or
persistence. To use it during a layout review, open the browser console and run:

```js
window.__STUDAFY_I18N__?.changeLanguage("qps-ploc");
```

That global is set in `i18next.ts` in dev builds only — it's a console/QA convenience, not a
production API, and isn't covered by SemVer. There's no on-screen toggle for it; nothing in this
ticket's acceptance criteria called for a permanent pseudo-locale UI, only that switching to it is
clean once you do.

Run `bun run --cwd apps/web i18n:pseudo` after every `en.json` change; `pseudo-locale.test.ts` fails
CI if `qps-ploc.json` has drifted out of sync, the same guarantee `@studafy/ui`'s
`tokens.consistency.test.ts` gives `tokens.css`.

## RTL: logical properties, not Tailwind

The ticket this foundation was built against describes flipping layout with Tailwind's `rtl:`
modifier. **This repo does not use Tailwind** — `apps/web` styles with plain CSS custom properties
and BEM-style class names (see `@studafy/ui/tokens.css` and `portal-shell.css`). The mechanism that
actually ships here is CSS logical properties plus the `dir` attribute, which is the vanilla-CSS
equivalent of what `rtl:` modifiers do and needs no build-time plugin:

- Use `margin-inline-start/end`, `padding-inline-start/end`, `border-inline-start/end`,
  `inset-inline-start/end`, `text-align: start/end` instead of their `left`/`right` physical
  equivalents.
- `top`/`bottom` (and `inset-block-*`) are unaffected by `dir` and don't need to change.
- CSS Grid and Flexbox already reorder their main axis under `direction: rtl` (which `dir="rtl"`
  sets via the UA stylesheet) — `portal-shell.css`'s `grid-template-areas: "sidebar content"` needs
  no RTL-specific rule at all; the sidebar simply renders on the right once `<html dir="rtl">`.
- `transform: translateX()` does **not** know about `dir` — it's a physical-axis operation. The
  off-canvas sidebar drawer used to slide via `translateX(-100%)`; it now animates
  `inset-inline-start` instead (see the comment above that rule in `portal-shell.css`), which mirrors
  automatically instead of needing a `[dir="rtl"]` override.

`src/layouts/portal/portal-shell.css` and `src/styles/global.css` (the skip link) have been
converted. That covers the shared portal shell — header, sidebar, popovers, the notification list,
the device/session rows — which is what every authenticated screen renders inside. It does **not**
cover feature-level CSS (finance ledger tables, the admin timetable grid, marketing pages): converting
those is the same handful of find-and-replace rules above, applied by whoever owns that screen, as
they touch it. Don't do a repo-wide sweep in one PR; do it screen by screen, verified in the browser.

## Locale persistence

`setLocale` writes to `localStorage` (`store.ts`) — it survives reloads and new tabs on that
browser profile. There is deliberately **no server-side per-user locale field**: the ticket this was
built against depends only on the portal app shell, not a user-preferences API, and no such field
exists on `app.users` today. `apps/api`'s `tenancy/settings` table has a school-level default
`locale`, which is a different thing (the school's default, not a signed-in user's override) and
isn't read by this foundation. If cross-device per-user persistence becomes a real requirement, that
is a backend ticket (a user preferences column/endpoint) plus wiring `LocaleProvider` to read it on
login — not a client-only change.

## Testing

`src/lib/i18n/context.test.tsx` asserts the acceptance criterion directly: switching locale sets
`<html dir>` and mirrors back. `store.test.ts` covers persistence/detection/fallback.
`locales/pseudo-locale.test.ts` keeps the generated pseudo-locale honest. Component tests
(`PortalSidebar.test.tsx`, `NotificationBell.test.tsx`, `UserMenu.test.tsx`, …) assert on the
rendered English text and needed no changes — i18next initializes as an import side effect and
defaults to `en`, so translated components still render exactly what they rendered before.
