import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_color_tokens.dart';
import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';

/// The headline card at the top of a screen: a diagonal gradient in a strong accent with soft
/// decorative rings in its far corner and white contents. The same in light and dark (it is the
/// screen's one saturated surface), so its white text always reads: every gradient stop holds at
/// least 4.5:1 against white.
///
/// Either give it structured content ([icon], [eyebrow], [title], [subtitle]) or a free-form
/// [child]; [footer] sits underneath either.
class AppHeroCard extends StatelessWidget {
  const AppHeroCard({
    this.icon,
    this.eyebrow,
    this.title,
    this.subtitle,
    this.child,
    this.footer,
    this.trailing,
    this.accent = AppAccent.blue,
    this.padding = const EdgeInsets.all(AppSpacing.space20),
    super.key,
  }) : assert(
         child != null || title != null,
         'Give the hero a title or a child.',
       );

  final IconData? icon;
  final String? eyebrow;
  final String? title;
  final String? subtitle;
  final Widget? child;
  final Widget? footer;

  /// Sits at the end of the [title] row (structured content only).
  final Widget? trailing;
  final AppAccent accent;
  final EdgeInsetsGeometry padding;

  /// Text and icon colour on every hero.
  static const Color foreground = AppColorTokens.white;

  /// The two gradient stops for [accent]: its light-theme solid, deepening towards the end corner.
  static List<Color> gradientFor(AppAccent accent) {
    final start = accent.light.solid;
    return [start, Color.lerp(start, AppColorTokens.neutral950, 0.28)!];
  }

  @override
  Widget build(BuildContext context) {
    final stops = gradientFor(accent);

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: AppRadius.xlRadius,
        gradient: LinearGradient(
          begin: AlignmentDirectional.topStart,
          end: AlignmentDirectional.bottomEnd,
          colors: stops,
        ),
        boxShadow: [
          BoxShadow(
            color: stops.first.withValues(alpha: 0.28),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: AppRadius.xlRadius,
        child: Stack(
          children: [
            const PositionedDirectional(
              top: -48,
              end: -36,
              child: _Ring(size: 160),
            ),
            const PositionedDirectional(
              top: 36,
              end: -64,
              child: _Ring(size: 120),
            ),
            Padding(
              padding: padding,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  child ?? _StructuredContent(hero: this),
                  ?footer,
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StructuredContent extends StatelessWidget {
  const _StructuredContent({required this.hero});

  final AppHeroCard hero;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    const onHero = AppHeroCard.foreground;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (hero.icon != null) ...[
          DecoratedBox(
            decoration: BoxDecoration(
              color: onHero.withValues(alpha: 0.16),
              borderRadius: AppRadius.lgRadius,
            ),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space12),
              child: Icon(hero.icon, color: onHero, size: 28),
            ),
          ),
          const SizedBox(width: AppSpacing.space16),
        ],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (hero.eyebrow != null)
                Text(
                  hero.eyebrow!,
                  style: textTheme.labelLarge?.copyWith(
                    color: onHero,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              Text(
                hero.title!,
                style: textTheme.headlineSmall?.copyWith(
                  color: onHero,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (hero.subtitle != null) ...[
                const SizedBox(height: AppSpacing.space4),
                Text(
                  hero.subtitle!,
                  style: textTheme.bodyMedium?.copyWith(color: onHero),
                ),
              ],
            ],
          ),
        ),
        if (hero.trailing != null) ...[
          const SizedBox(width: AppSpacing.space12),
          hero.trailing!,
        ],
      ],
    );
  }
}

/// A faint decorative ring; purely visual, so hidden from screen readers.
class _Ring extends StatelessWidget {
  const _Ring({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: size,
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: AppHeroCard.foreground.withValues(alpha: 0.05),
            border: Border.all(
              color: AppHeroCard.foreground.withValues(alpha: 0.07),
              width: 12,
            ),
          ),
        ),
      ),
    );
  }
}
