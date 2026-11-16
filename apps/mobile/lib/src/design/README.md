# Mobile theme — tokens → `ThemeData`

Corporate Precision as a Flutter `ThemeData`. Canonical token source is
[`packages/ui/src/theme.ts`](../../../../../packages/ui/src/theme.ts) (mirrored to CSS in
`packages/ui/src/tokens.css` for the web app); this directory is the Flutter port of the same
spec. If a token value changes there, change it here too — nothing in this directory should
invent its own color, radius, or type value.

Note on layout: the ticket for this work names `/apps/mobile/lib/design` as the target
directory. This app puts app code under `lib/src/` (see `core/`, `features/`), so the design
system lives at `lib/src/design/` to stay consistent with that existing convention rather than
fork a second top-level layout.

## Layout

```
design/
  tokens/          Raw token values (color scale, spacing, radius, type scale) — 1:1 with theme.ts.
  theme/
    app_color_scheme.dart      ColorScheme.light / .dark, built field-by-field from tokens.
    app_semantic_colors.dart   ThemeExtension for the one role ColorScheme has no slot for (warning).
    app_theme.dart             Assembles everything into AppTheme.light / AppTheme.dark.
    component_themes/          One file per Material component family (button, input, card, chip).
  typography/
    app_typography.dart        Inter type scale (via google_fonts) mapped onto TextTheme roles.
  kit/             The visual kit: template widgets every screen is built from (see below).
  widgets/          Small reusable widgets built on the theme.
```

## Color

`AppColorScheme.light` / `.dark` build Flutter's `ColorScheme` explicitly — not via
`ColorScheme.fromSeed`, which derives a palette algorithmically and would not reproduce the
token spec's exact hex values. Every field is a direct assignment from `AppColorTokens`.

| Token spec (`semanticColor.light`) | `ColorScheme` field                              |
| ----------------------------------- | ------------------------------------------------- |
| `accent` / `accentForeground`       | `primary` / `onPrimary`                            |
| `accentSubtleBg` / `accentSubtleForeground` | `primaryContainer` / `onPrimaryContainer`  |
| `success*`                          | `tertiary*`                                        |
| `danger*`                           | `error*`                                           |
| `background`                        | `surface`                                          |
| `surface`                           | `surfaceContainerHighest`                          |
| `foreground`                        | `onSurface`                                        |
| `mutedForeground`                   | `onSurfaceVariant`                                 |
| `border`                            | `outline` / `outlineVariant`                       |

`warning*` has no `ColorScheme` counterpart — Material's scheme doesn't have a warning role —
so it lives in the `AppSemanticColors` `ThemeExtension` instead
(`Theme.of(context).extension<AppSemanticColors>()`), alongside light/dark `lerp` support for
implicit theme animations.

## Typography

`AppTypography.textTheme` builds a `TextTheme` from the 9-step token scale
(`AppFontSize`/`AppLineHeight`/`AppFontWeight`/`AppTracking`), then runs it through
`GoogleFonts.interTextTheme(...)` to apply Inter. Material3's `TextTheme` has 13 roles against
the token spec's 9 sizes, so adjacent roles intentionally share a size step and are
differentiated by weight (e.g. `headlineMedium` and `displaySmall` are both the `3xl` step —
semibold vs. bold).

Text colors are left unset in this theme: `ThemeData` merges a custom `textTheme` on top of
the Material3 default derived from `colorScheme` (`textTheme = defaultTextTheme.merge(...)` —
`TextStyle.merge` keeps the base color wherever the override's is null), so leaving color null
here is what makes the same `TextTheme` correct for both light and dark automatically.

`TextStyle.height` in Flutter is a **multiplier** of font size, not a pixel value — every style
computes it as `lineHeight / fontSize` to convert the token spec's pixel line-heights
correctly.

### Inter, offline

Inter is loaded via `google_fonts`'s `GoogleFonts.interTextTheme()`, per the acceptance
criteria — but it's bundled as an app asset (`assets/fonts/Inter-{Regular,Medium,SemiBold,
Bold}.ttf`, declared in `pubspec.yaml`) rather than fetched from `fonts.gstatic.com` at
runtime. `bootstrapApp` sets `GoogleFonts.config.allowRuntimeFetching = false` so the shipped
app always resolves Inter from that bundle. This also happens to be required for testing:
`flutter test` runs under `TestWidgetsFlutterBinding`, which fails every real `HttpClient`
request, so a runtime-fetch-only setup would make every themed golden test fail. See
`test/flutter_test_config.dart`.

## Spacing & radius

`AppSpacing` and `AppRadius` are direct ports of `space` and `radius` from `theme.ts`. Radius
per component follows the same values the web components use in
`packages/ui/src/components/*/*.css`:

| Component | Radius | Source |
| --- | --- | --- |
| Button, input | `md` (8px) | `button.css`, `input.css` |
| Card | `lg` (12px) | `card.css` |
| Chip | `full` (pill) | `chip.css` |

## Component themes

`component_themes/` has one file per family, each a pure function `(ColorScheme, ...) ->
FooThemeData`, assembled in `app_theme.dart`:

- **Button** (`app_button_theme.dart`) — the web token spec's three variants (primary/
  secondary/tertiary) map directly onto Material3's own three button widgets, which already
  carry the same intent: primary → `FilledButton`, secondary → `OutlinedButton`, tertiary →
  `TextButton`.
- **Input** (`app_input_theme.dart`) — `InputDecorationTheme` with an 8px-radius outline
  border, a 2px accent focus border standing in for the web's focus ring, and a danger-colored
  error border.
- **Card** (`app_card_theme.dart`) — `CardThemeData` with `elevation: 0` and a hairline
  `outline`-colored border at a 12px radius. The web card's default elevation shadow
  (`elevation-1`) is close to imperceptible, so the border — not a shadow — does the visual
  definition, same as the CSS.
- **Chip** (`app_chip_theme.dart`) — `ChipThemeData` on a `StadiumBorder`, styled after the
  CSS "filled" variant (`accentSubtleBg`/`accentSubtleForeground`, i.e.
  `primaryContainer`/`onPrimaryContainer`). `ChipThemeData` is one shared style, not
  per-variant, so the CSS "outlined" chip is a per-instance override (`side:`,
  `backgroundColor: Colors.transparent`) rather than a second theme.

## Tests

- `test/design/app_color_scheme_test.dart` — exact-hex assertions against the token spec
  (the "light theme matches token spec hex values exactly" acceptance criterion), for both
  brightnesses, plus `AppSemanticColors.lerp`.
- `test/design/app_theme_golden_test.dart` — a golden gallery (button/input/card/chip) for
  light and dark, pinned to a fixed surface size and `TextScaler.noScaling` for
  reproducibility.
- `test/design/app_theme_text_scale_test.dart` — pumps the same widgets at `TextScaler.linear`
  values above 1x and asserts rendered text actually grows, so a future change can't silently
  reintroduce a hardcoded `TextScaler.noScaling` somewhere in the theme.
- `test/flutter_test_config.dart` — global bootstrap that forces both themes to build (which
  requests every Inter weight) and awaits `GoogleFonts.pendingFonts()` before any test body
  runs, so font loading can't race a golden comparison.

## Visual kit (`kit/`)

Screens are built from a small set of template widgets so they read as designed layouts, not
text on a page. Import `kit/kit.dart` for all of them.

| Widget | Use |
| --- | --- |
| `AppHeroCard` | The headline card at the top of a screen: diagonal gradient in a strong accent, faint decorative rings, white contents. Structured (`icon`/`eyebrow`/`title`/`subtitle`) or a free `child`, plus `footer`. `TodayDateHero` and the parent child switcher use it. |
| `AppSectionCard` | A dashboard section: coloured icon badge + bold title (+ optional trailing count/action) over a body. The student, teacher and parent home cards are all built on it. |
| `AppCollapsibleSectionCard` | The same, with a body that folds away under its header (announces expanded state). |
| `AppSectionHeader` | The badge + title row on its own, for groups on a plain page. |
| `AppIconListTile` / `AppIconListCard` | A row led by a coloured badge, bold title, muted subtitle, optional trailing pill or `footer`, and a direction-aware chevron when tappable. The card form is a stand-alone tappable card (class list). |
| `AppStatTile` | One headline number on an accent tint ("78%" / "Term average"); lay 2–3 side by side. |
| `AppStatusPill` | A small rounded status label in a tone (`neutral`, `brand`, `info`, `success`, `warning`, `danger`), optional icon. |
| `AppEmptyState` | Icon-illustrated empty / error message: full (disc in a halo, title, message, action) or `compact` (one row inside a card). No image assets. |
| `AppIconBadge` | The rounded-square tinted icon (or short label) every other piece leads with. |
| `AppCardSurface` | The kit's card: the themed `Card` plus a soft shadow. |

### Colour

- `tokens/app_accent_tokens.dart` defines `AppAccent`, a set of hues from the same
  Tailwind-derived scale as the brand tokens, each with a light and dark `solid`/`onSolid` and
  `container`/`onContainer` pair. `AppAccent.blue` is the brand blue (`accent600`), so the whole
  kit is seeded from the one brand colour; the others are its siblings on the same scale.
- `AppTone` names what a colour means (brand, success, warning…) and maps each to one accent.
  `AppTone.forPercentage` tints a mark (the number is always printed too).
- `SubjectVisuals.of(name)` gives a subject or class a consistent accent and icon, reading English
  or Arabic course names and class codes ("Mathematics", "الرياضيات" and "MATH101-A" are the same
  blue calculator). Unknown names get a stable hashed hue. Rows with no known subject use their
  section's accent instead.
- Every accent pair, in both brightnesses, and every hero gradient stop against white, holds
  WCAG AA 4.5:1 — `test/design/kit/app_accent_test.dart` checks it, and
  `kit_widgets_test.dart` runs Flutter's `textContrastGuideline` over the components in light
  and dark, LTR and RTL.

### Direction

Everything is laid out with start/end (`EdgeInsetsDirectional`, `AlignmentDirectional`,
`PositionedDirectional`), so the kit mirrors in Arabic without per-screen work. The kit's widget
tests render each component in both directions and assert which side the badge lands on.

### Theme changes that came with the kit

- `ColorScheme` now fills the surface-container steps between `surface` and
  `surfaceContainerHighest` from the slate scale, instead of collapsing them onto `surface`.
  The token-mapped fields above are unchanged (still asserted exactly).
- Cards use the 16px `xl` radius (matching the hero) instead of 12px.
- Chip labels are semibold; list tiles get a 12px title gap and a muted semibold trailing text style.
- The shell's pill navigation draws the selected tab as a brand-blue capsule with the filled
  variant of its icon (`ShellDestination.selectedIcon`).
