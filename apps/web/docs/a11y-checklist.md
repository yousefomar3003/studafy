# Accessibility checklist

The web portal targets WCAG 2.1 AA. This is the reference for verifying a screen meets that bar,
and for what CI actually gates versus what still needs a human. Read this before shipping a new
route, dialog, table, or form — and whenever a `color-contrast` or focus finding shows up in axe.

## What the design system already gives you

| Concern                  | Where it's handled                                                                                                                  | What you get for free                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog focus trap        | `@studafy/ui`'s `Modal` (`internal/use-focus-trap.ts`)                                                                              | Tab/Shift+Tab confined to the dialog, `Esc` closes, focus returns to whatever opened it, initial focus lands on the dialog's first _content_ control (not the close button — see below)                                                                                                                                                                                                                                                                              |
| Table semantics          | `@studafy/ui`'s `Table`                                                                                                             | `<caption>`, `scope` on header cells, a labelled/focusable scroll region for wide tables, `aria-busy` loading and empty states                                                                                                                                                                                                                                                                                                                                       |
| Form field/error binding | `@studafy/ui`'s `Input`/`Select`                                                                                                    | `<label htmlFor>`, `aria-invalid`, `aria-describedby` wired to helper/error text, `role="alert"` on the error itself                                                                                                                                                                                                                                                                                                                                                 |
| Focus ring               | `tokens.css`'s `--focus-ring-*`                                                                                                     | A visible, theme-aware focus indicator on every interactive primitive — don't override it with `outline: none`                                                                                                                                                                                                                                                                                                                                                       |
| Skip link + landmarks    | `RootLayout`                                                                                                                        | A skip-to-content link and a `<main>` landmark on every route                                                                                                                                                                                                                                                                                                                                                                                                        |
| Popover dismissal        | `layouts/portal/use-disclosure.ts` (bell, user menu)                                                                                | `Esc` closes and returns focus to the trigger; outside click closes; not a focus trap (non-modal, correctly)                                                                                                                                                                                                                                                                                                                                                         |
| Reduced motion           | `tokens.css`'s `prefers-reduced-motion` block                                                                                       | Every `--duration-*` token collapses to ~0 automatically — don't hand-roll a motion check in a new component                                                                                                                                                                                                                                                                                                                                                         |
| Color contrast           | `tokens.css`'s semantic color pairs (`--color-*-foreground` on `--color-*`, `--color-*-subtle-foreground` on `--color-*-subtle-bg`) | Every paired token combination is ≥ 4.5:1 in both themes. **Only use the paired tokens together** — e.g. a tertiary button's `--color-accent` text needs `--color-accent-subtle-foreground` if you put it on `--color-accent-subtle-bg`, not the other way around. Mixing an unpaired foreground/background is exactly how `notifications.css`'s unread-row "Mark as read" button ended up at 4.23:1 (just under AA) — fixed, but the failure mode is worth knowing. |

**Modal's default initial focus**: it skips the header (title/close button) and focuses the first
focusable element in the body/footer, falling back to the close button only when the dialog truly
has no other control. A field's `autoFocus` prop does **not** control this — `autoFocus` never
actually focuses anything inside `Modal` (or any other `Portal`-based component): React applies it
during the commit's mutation phase, before `Portal`'s own effect has attached its container to
`document.body`, so the call lands on a disconnected node and silently no-ops, in every React
version. If you need a _specific_ control focused instead of "first in DOM order", pass
`initialFocusRef` — it's the only mechanism that actually works.

## Verifying a screen

**1. Component-level (`bun run test`, every PR, fast).** Add an `a11y.test.tsx` next to the
feature, one `test()` per meaningfully different state (list, empty, loading, each modal open).
Mirror an existing one — `features/principal/approvals/a11y.test.tsx` is a good template for a
list+modals screen. The pattern:

```tsx
import { expectNoA11yViolations } from "../../../lib/test/axe";

test("some state", async () => {
  const { container } = renderInMain(await loadPage()); // wrap in <main>, matches RootLayout
  await screen.findByText("something that proves this state rendered");
  await expectNoA11yViolations(container);
});
```

This runs axe-core against the rendered DOM under happy-dom. It catches missing labels, bad ARIA,
heading/landmark structure, missing table semantics, dangling `aria-describedby` — everything
axe can check without laying out or painting anything. It **cannot** check `color-contrast`: happy-dom
has no layout or cascade to sample painted pixels from, so that rule is disabled in
`lib/test/axe.ts` on purpose. Don't re-enable it there — it would only ever report false negatives
(nothing painted, nothing sampled) or crash.

**2. Real-browser audit (`bun run e2e:a11y`, CI-gated, ST-211's budget).**
`e2e/accessibility-audit.spec.ts` runs the _full_ default axe ruleset — including
`color-contrast` — against real Chromium, over a stubbed backend (no Postgres, no `apps/api`
process). Every route/state it doesn't already cover is a real coverage gap; add the route's stub
next to the existing ones (list) rather than opening a new file. The budget: **zero `critical` or
`serious` violations** fails the run; `moderate`/`minor` findings are attached to the Playwright
report but don't fail it, so a low-severity finding stays visible without blocking a merge.

This file — and `e2e/keyboard-accessibility-walkthrough.spec.ts` (below) — run against a
**production build** (`vite build && vite preview`), not `vite dev`. React 18's `<StrictMode>`
(dev-only) makes an already-portalled dialog's initial-focus destination genuinely non-deterministic
in the dev server, for reasons that don't exist in what ships — see
`playwright.a11y.config.ts`'s doc comment if you need the full story. If you add a focus-destination
or color-contrast assertion to a _new_ spec file, put it in this config's `testMatch`, not the
default `playwright.config.ts`.

**3. Manual keyboard-only walkthrough.** `keyboard-accessibility-walkthrough.spec.ts` drives 5 core
journeys end to end using only `page.keyboard.*` — never `.click()` — recorded on every run
(`test.use({ video: "on" })`; CI uploads them as the `a11y-walkthrough-videos` artifact). Today's
five: approve an item from the approval queue (dialog trap + Tab-order regression check via
`tabTo`, which fails loudly if a control becomes unreachable rather than silently passing), mark a
notification read and change a channel preference, invite a user through a modal form (typeahead
combobox), record a payment (search-and-pick + radio group), and triage a discipline incident
(two chained dialogs). Add a 6th journey here — following the same `tabTo`/no-`.click()` pattern —
whenever a new screen introduces a materially different interaction shape (a new widget type, a
multi-step flow), not for every new route.

## Sweep checklist for a new or changed screen

- **Focus order.** Tab through it without a mouse. Does focus follow visual/reading order? Does
  anything trap focus that isn't a modal dialog? Does a popover's `Esc` return focus to its trigger
  (use `useDisclosure`, don't hand-roll)?
- **Dialog traps.** Any new modal-like UI goes through `@studafy/ui`'s `Modal` — don't build a
  second dialog primitive. If it needs a specific initial focus target, pass `initialFocusRef`
  rather than relying on `autoFocus` (see above).
- **Table semantics.** Use `@studafy/ui`'s `Table` for tabular data. If a table's layout genuinely
  can't use it (see `TimetableGrid.tsx`'s grid), hand-write `<caption>` (or `aria-label`) + `scope`
  on every header cell — every hand-rolled table in this codebase does this; match the pattern.
- **Form error associations.** Use `@studafy/ui`'s `Input`/`Select` for form fields; they wire
  `aria-invalid`/`aria-describedby`/`role="alert"` correctly by construction. If you must render a
  raw `<input>`, replicate that wiring by hand — don't render error text with no association to the
  field it describes.
- **Color contrast.** Use the _paired_ semantic tokens (see the table above), don't invent a new
  foreground/background combination. If you do need one, check it — `bun run e2e:a11y` will catch
  a real miss, but computing it yourself (4.5:1 normal text, 3:1 large text ≥ 18.66px/24px) before
  opening a PR is faster than waiting on CI.
- **Keyboard-only pass.** Actually try the journey with a mouse unplugged (or DevTools' "Emulate
  focused page" + keyboard only) before calling a screen done. It catches things axe structurally
  cannot: a control that's technically labelled and reachable but the _order_ is confusing, or a
  custom widget that responds to click but not Enter/Space.
