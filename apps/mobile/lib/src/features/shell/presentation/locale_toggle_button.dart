import 'dart:ui' show ImageFilter;

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/localization/app_locales.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// AppBar action that switches between the app's supported locales.
///
/// A globe icon opens an iOS-style pull-down menu (frosted panel, hairline dividers, leading
/// checkmark on the current locale) listing every supported locale by its own native name — a
/// language names itself, so the names aren't translated, matching the web app's locale
/// switcher convention.
class LocaleToggleButton extends StatelessWidget {
  const LocaleToggleButton({super.key});

  Future<void> _openMenu(BuildContext context) async {
    final button = context.findRenderObject()! as RenderBox;
    final anchor = button.localToGlobal(Offset.zero) & button.size;
    final current = context.locale;

    HapticFeedback.selectionClick();
    final selected = await Navigator.of(context).push(
      _LocaleMenuRoute(
        anchor: anchor,
        current: current,
        barrierLabel: MaterialLocalizations.of(
          context,
        ).modalBarrierDismissLabel,
      ),
    );
    if (selected != null && selected != current && context.mounted) {
      await context.setLocale(selected);
    }
  }

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: const Key('localeMenuButton'),
      icon: const Icon(Icons.language),
      tooltip: 'shell.switchLanguage'.tr(),
      onPressed: () => _openMenu(context),
    );
  }
}

/// Transparent, tap-outside-to-dismiss route that grows the menu out of the globe button.
class _LocaleMenuRoute extends PopupRoute<Locale> {
  _LocaleMenuRoute({
    required this.anchor,
    required this.current,
    required this.barrierLabel,
  });

  final Rect anchor;
  final Locale current;

  @override
  final String barrierLabel;

  @override
  Color? get barrierColor => null;

  @override
  bool get barrierDismissible => true;

  @override
  Duration get transitionDuration => const Duration(milliseconds: 220);

  @override
  Duration get reverseTransitionDuration => const Duration(milliseconds: 150);

  @override
  Widget buildPage(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
  ) {
    return CustomSingleChildLayout(
      delegate: _MenuLayout(
        anchor: anchor,
        padding: MediaQuery.paddingOf(context),
      ),
      child: _LocaleMenu(current: current),
    );
  }

  @override
  Widget buildTransitions(
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    // Grow from the corner nearest the button, like a UIKit pull-down menu.
    final growsFromRight =
        anchor.center.dx > MediaQuery.sizeOf(context).width / 2;
    final curved = CurvedAnimation(
      parent: animation,
      curve: Curves.easeOutBack,
      reverseCurve: Curves.easeIn,
    );
    return FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.85, end: 1).animate(curved),
        alignment: growsFromRight ? Alignment.topRight : Alignment.topLeft,
        child: child,
      ),
    );
  }
}

/// Places the menu just below the button, edge-aligned with it and kept inside the safe area.
class _MenuLayout extends SingleChildLayoutDelegate {
  const _MenuLayout({required this.anchor, required this.padding});

  static const double _width = 230;
  static const double _gap = AppSpacing.space4;
  static const double _margin = AppSpacing.space8;

  final Rect anchor;
  final EdgeInsets padding;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      BoxConstraints.tightFor(width: _width);

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final growsFromRight = anchor.center.dx > size.width / 2;
    final left = growsFromRight ? anchor.right - childSize.width : anchor.left;
    final minLeft = padding.left + _margin;
    final maxLeft = size.width - padding.right - _margin - childSize.width;
    return Offset(left.clamp(minLeft, maxLeft), anchor.bottom + _gap);
  }

  @override
  bool shouldRelayout(_MenuLayout oldDelegate) =>
      anchor != oldDelegate.anchor || padding != oldDelegate.padding;
}

class _LocaleMenu extends StatelessWidget {
  const _LocaleMenu({required this.current});

  final Locale current;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: AppRadius.lgRadius,
        boxShadow: [
          BoxShadow(
            color: colors.shadow.withValues(alpha: 0.18),
            blurRadius: 32,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: AppRadius.lgRadius,
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 30, sigmaY: 30),
          child: Material(
            type: MaterialType.transparency,
            child: Container(
              color: colors.surface.withValues(alpha: 0.82),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (index, locale)
                      in AppLocales.supported.indexed) ...[
                    if (index > 0)
                      Divider(
                        height: 0.5,
                        thickness: 0.5,
                        color: colors.outlineVariant,
                      ),
                    _LocaleMenuItem(
                      locale: locale,
                      selected: locale == current,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LocaleMenuItem extends StatelessWidget {
  const _LocaleMenuItem({required this.locale, required this.selected});

  final Locale locale;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: () => Navigator.of(context).pop(locale),
        splashFactory: NoSplash.splashFactory,
        highlightColor: colors.onSurface.withValues(alpha: 0.08),
        child: SizedBox(
          height: 44,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
            child: Row(
              children: [
                SizedBox(
                  width: AppSpacing.space24,
                  child: selected
                      ? Icon(
                          Icons.check_rounded,
                          size: 20,
                          color: colors.onSurface,
                        )
                      : null,
                ),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    AppLocales.nativeNames[locale] ?? locale.languageCode,
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      fontSize: 17,
                      color: colors.onSurface,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
