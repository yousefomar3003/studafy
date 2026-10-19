import 'package:flutter/material.dart';

import '../../tokens/app_radius_tokens.dart';
import '../../tokens/app_spacing_tokens.dart';

/// Corporate Precision — app chrome: bars, navigation, overlays and list rows.
///
/// Mirrors the web portal shell (`apps/web/src/layouts/portal/portal-shell.css`): a flat
/// background-coloured header (lifting onto the surface colour once content scrolls under it)
/// with a 600-weight brand title, navigation whose active item sits on the accent-subtle fill with accent-strong text, and
/// popovers at a 12px radius. Material3's tinted, elevated defaults are switched off so every
/// surface reads as the web's flat, border-defined chrome.
abstract final class AppChromeTheme {
  static AppBarTheme appBar(ColorScheme colors, TextTheme textTheme) {
    return AppBarTheme(
      // At rest the bar blends into the page (the scaffold background); once content scrolls
      // under it, it lifts onto the raised surface colour with a soft shadow to separate the two.
      backgroundColor: WidgetStateColor.resolveWith(
        (states) => states.contains(WidgetState.scrolledUnder)
            ? colors.surface
            : colors.surfaceContainerHighest,
      ),
      foregroundColor: colors.onSurface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 1,
      shadowColor: colors.shadow.withValues(alpha: 0.12),
      centerTitle: false,
      titleSpacing: AppSpacing.space16,
      titleTextStyle: textTheme.titleLarge?.copyWith(
        color: colors.onSurface,
        fontWeight: FontWeight.w600,
        fontSize: 18,
      ),
    );
  }

  static NavigationBarThemeData navigationBar(ColorScheme colors, TextTheme textTheme) {
    return NavigationBarThemeData(
      backgroundColor: colors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      height: 68,
      indicatorColor: colors.primaryContainer,
      indicatorShape: const RoundedRectangleBorder(borderRadius: AppRadius.mdRadius),
      labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(
          size: 22,
          color: selected ? colors.onPrimaryContainer : colors.onSurfaceVariant,
        );
      }),
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return textTheme.labelSmall?.copyWith(
          fontSize: 12,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          color: selected ? colors.onPrimaryContainer : colors.onSurfaceVariant,
        );
      }),
    );
  }

  static DialogThemeData dialog(ColorScheme colors, TextTheme textTheme) {
    return DialogThemeData(
      backgroundColor: colors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 3,
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.lgRadius,
        side: BorderSide(color: colors.outline),
      ),
      titleTextStyle: textTheme.titleLarge?.copyWith(
        color: colors.onSurface,
        fontWeight: FontWeight.w600,
      ),
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
    );
  }

  static BottomSheetThemeData bottomSheet(ColorScheme colors) {
    return BottomSheetThemeData(
      backgroundColor: colors.surface,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: colors.outline,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppRadius.xl)),
      ),
    );
  }

  /// Overflow menus: a 12px-radius bordered popover that opens below its anchor, matching the
  /// web's dropdowns rather than Material3's tinted sheet that covers the button.
  static PopupMenuThemeData popupMenu(ColorScheme colors, TextTheme textTheme) {
    return PopupMenuThemeData(
      color: colors.surface,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shadowColor: colors.shadow.withValues(alpha: 0.16),
      position: PopupMenuPosition.under,
      menuPadding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.lgRadius,
        side: BorderSide(color: colors.outline),
      ),
      labelTextStyle: WidgetStatePropertyAll(
        textTheme.bodyLarge?.copyWith(color: colors.onSurface, fontWeight: FontWeight.w500),
      ),
    );
  }

  static SnackBarThemeData snackBar(ColorScheme colors, TextTheme textTheme) {
    return SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: colors.inverseSurface,
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: colors.onInverseSurface),
      actionTextColor: colors.inversePrimary,
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.mdRadius),
    );
  }

  static ListTileThemeData listTile(ColorScheme colors, TextTheme textTheme) {
    return ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
      minVerticalPadding: AppSpacing.space12,
      iconColor: colors.onSurfaceVariant,
      titleTextStyle: textTheme.bodyLarge?.copyWith(
        color: colors.onSurface,
        fontWeight: FontWeight.w500,
      ),
      subtitleTextStyle: textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant),
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.mdRadius),
    );
  }

  static DividerThemeData divider(ColorScheme colors) {
    return DividerThemeData(color: colors.outline, thickness: 1, space: 1);
  }

  static FloatingActionButtonThemeData fab(ColorScheme colors) {
    return FloatingActionButtonThemeData(
      backgroundColor: colors.primary,
      foregroundColor: colors.onPrimary,
      elevation: 2,
      highlightElevation: 4,
      shape: const RoundedRectangleBorder(borderRadius: AppRadius.lgRadius),
    );
  }

  static SegmentedButtonThemeData segmentedButton(ColorScheme colors) {
    return SegmentedButtonThemeData(
      style: ButtonStyle(
        shape: const WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: AppRadius.mdRadius),
        ),
        side: WidgetStatePropertyAll(BorderSide(color: colors.outline)),
        backgroundColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? colors.primaryContainer : colors.surface,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) =>
              states.contains(WidgetState.selected) ? colors.onPrimaryContainer : colors.onSurface,
        ),
      ),
    );
  }

  static ProgressIndicatorThemeData progressIndicator(ColorScheme colors) {
    return ProgressIndicatorThemeData(
      color: colors.primary,
      linearTrackColor: colors.primaryContainer,
    );
  }
}
