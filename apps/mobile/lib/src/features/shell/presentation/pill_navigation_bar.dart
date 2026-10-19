import 'package:flutter/material.dart';

import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

/// One tab in a [PillNavigationBar]: its icon (already decorated, e.g. with an unread badge) and
/// its translated label.
class PillNavigationDestination {
  const PillNavigationDestination({required this.icon, required this.label});

  final Widget icon;
  final String label;
}

/// The shell's floating bottom navigation: a rounded pill that floats above the bottom edge,
/// with the selected tab drawn as a filled inverse-colour capsule showing its icon and label.
///
/// Unselected tabs show only their icon so up to five tabs fit on a phone-width screen; their
/// label is still exposed through a tooltip (long-press) and to screen readers.
class PillNavigationBar extends StatelessWidget {
  const PillNavigationBar({
    super.key,
    required this.destinations,
    required this.selectedIndex,
    required this.onDestinationSelected,
  });

  final List<PillNavigationDestination> destinations;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;

  static const double _barHeight = 64;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return SafeArea(
      top: false,
      minimum: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space16,
          AppSpacing.space8,
          AppSpacing.space16,
          0,
        ),
        child: Container(
          height: _barHeight,
          padding: const EdgeInsets.all(AppSpacing.space8),
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: AppRadius.fullRadius,
            border: Border.all(color: colors.outlineVariant),
            boxShadow: [
              BoxShadow(
                color: colors.shadow.withValues(alpha: 0.08),
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceAround,
            children: [
              for (var index = 0; index < destinations.length; index++)
                _PillNavigationItem(
                  destination: destinations[index],
                  selected: index == selectedIndex,
                  onTap: () => onDestinationSelected(index),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PillNavigationItem extends StatelessWidget {
  const _PillNavigationItem({
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  final PillNavigationDestination destination;
  final bool selected;
  final VoidCallback onTap;

  static const Duration _duration = Duration(milliseconds: 220);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final foreground = selected
        ? colors.onInverseSurface
        : colors.onSurfaceVariant;

    final item = Semantics(
      button: true,
      selected: selected,
      label: destination.label,
      excludeSemantics: true,
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: onTap,
          customBorder: const StadiumBorder(),
          child: AnimatedContainer(
            duration: _duration,
            curve: Curves.easeOutCubic,
            height: double.infinity,
            constraints: const BoxConstraints(minWidth: 48),
            padding: EdgeInsets.symmetric(
              horizontal: selected ? AppSpacing.space16 : AppSpacing.space12,
            ),
            decoration: BoxDecoration(
              color: selected ? colors.inverseSurface : Colors.transparent,
              borderRadius: AppRadius.fullRadius,
            ),
            child: IconTheme.merge(
              data: IconThemeData(size: 22, color: foreground),
              child: AnimatedSize(
                duration: _duration,
                curve: Curves.easeOutCubic,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    destination.icon,
                    if (selected) ...[
                      const SizedBox(width: AppSpacing.space8),
                      Flexible(
                        child: Text(
                          destination.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelLarge?.copyWith(
                            color: foreground,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );

    if (selected) return Flexible(child: item);
    return Tooltip(
      message: destination.label,
      excludeFromSemantics: true,
      child: item,
    );
  }
}
