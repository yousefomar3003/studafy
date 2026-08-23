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
  widgets/          Small reusable widgets built on the theme (unchanged by this work).
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
