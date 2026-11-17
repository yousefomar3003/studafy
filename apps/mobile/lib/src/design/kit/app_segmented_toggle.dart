import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../tokens/app_radius_tokens.dart';
import '../tokens/app_spacing_tokens.dart';

/// One option of an [AppSegmentedToggle]: its value, translated label and icon.
class AppSegment<T> {
  const AppSegment({
    required this.value,
    required this.label,
    required this.icon,
    this.selectedIcon,
  });

  final T value;
  final String label;
  final IconData icon;

  /// The filled variant shown while this segment is selected; [icon] when null.
  final IconData? selectedIcon;
}

/// A pill-shaped switch between two or more sections of one screen ("Assignments | Grades"): a
/// soft track with equal-width segments, the selected one drawn as the brand-coloured capsule
/// the shell's bottom navigation uses, sliding across as the selection changes (mirrored in RTL).
///
/// Each segment is its own labelled, selectable button for screen readers, in one mutually
/// exclusive group; [semanticLabel] names the group.
class AppSegmentedToggle<T> extends StatelessWidget {
  const AppSegmentedToggle({
    required this.segments,
    required this.selected,
    required this.onChanged,
    this.semanticLabel,
    super.key,
  }) : assert(segments.length >= 2, 'a toggle needs at least two segments');

  final List<AppSegment<T>> segments;
  final T selected;
  final ValueChanged<T> onChanged;
  final String? semanticLabel;

  static const Duration _duration = Duration(milliseconds: 220);

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final selectedIndex = segments.indexWhere((segment) => segment.value == selected);
    final count = segments.length;

    return Semantics(
      container: true,
      explicitChildNodes: true,
      label: semanticLabel,
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.space4),
        decoration: BoxDecoration(
          color: colors.surfaceContainer,
          borderRadius: AppRadius.fullRadius,
          border: Border.all(color: colors.outlineVariant),
        ),
        child: Stack(
          children: [
            if (selectedIndex >= 0)
              Positioned.fill(
                child: AnimatedAlign(
                  duration: _duration,
                  curve: Curves.easeOutCubic,
                  alignment: AlignmentDirectional(-1 + 2 * selectedIndex / (count - 1), 0),
                  child: FractionallySizedBox(
                    widthFactor: 1 / count,
                    heightFactor: 1,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.primary,
                        borderRadius: AppRadius.fullRadius,
                        boxShadow: [
                          BoxShadow(
                            color: colors.primary.withValues(alpha: 0.28),
                            blurRadius: 10,
                            offset: const Offset(0, 3),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            Row(
              children: [
                for (final (index, segment) in segments.indexed)
                  Expanded(
                    child: _SegmentButton(
                      segment: segment,
                      selected: index == selectedIndex,
                      onTap: () {
                        if (index == selectedIndex) return;
                        HapticFeedback.selectionClick();
                        onChanged(segment.value);
                      },
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SegmentButton<T> extends StatelessWidget {
  const _SegmentButton({required this.segment, required this.selected, required this.onTap});

  final AppSegment<T> segment;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    return Semantics(
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      label: segment.label,
      // The ink well's own tap is excluded with its subtree, so the action is restated here.
      onTap: onTap,
      excludeSemantics: true,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          customBorder: const StadiumBorder(),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.space12,
                vertical: AppSpacing.space8,
              ),
              child: TweenAnimationBuilder<Color?>(
                tween: ColorTween(end: selected ? colors.onPrimary : colors.onSurfaceVariant),
                duration: AppSegmentedToggle._duration,
                curve: Curves.easeOutCubic,
                builder: (context, foreground, _) => Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      selected ? (segment.selectedIcon ?? segment.icon) : segment.icon,
                      size: 18,
                      color: foreground,
                    ),
                    const SizedBox(width: AppSpacing.space8),
                    Flexible(
                      child: Text(
                        segment.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: foreground,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
