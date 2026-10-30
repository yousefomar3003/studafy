import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
/// label is still exposed to screen readers, and shown on the capsule as soon as a tab is selected.
///
/// Sliding a finger along the bar — straight away or after pressing and holding — selects the tab
/// under it as it passes, with a selection haptic on each change, the way Instagram's and
/// WhatsApp's tab bars scrub.
class PillNavigationBar extends StatefulWidget {
  const PillNavigationBar({
    super.key,
    required this.destinations,
    required this.selectedIndex,
    required this.onDestinationSelected,
  });

  final List<PillNavigationDestination> destinations;
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;

  @override
  State<PillNavigationBar> createState() => _PillNavigationBarState();
}

class _PillNavigationBarState extends State<PillNavigationBar> {
  static const double _barHeight = 64;

  // One key per tab, so a scrub can hit-test the finger against each tab's current (animating)
  // bounds rather than assume equal-width slots — the selected capsule is wider than the rest.
  late List<GlobalKey> _itemKeys = _keysFor(widget.destinations.length);

  // The tab this scrub last selected. The parent's selectedIndex only catches up on its next
  // rebuild, so this stops two moves inside one frame from selecting (and buzzing) twice.
  int? _scrubbedIndex;

  static List<GlobalKey> _keysFor(int count) =>
      List.generate(count, (_) => GlobalKey());

  @override
  void didUpdateWidget(PillNavigationBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.destinations.length != widget.destinations.length) {
      _itemKeys = _keysFor(widget.destinations.length);
    }
  }

  void _startScrub(Offset globalPosition) {
    _scrubbedIndex = widget.selectedIndex;
    _scrubTo(globalPosition);
  }

  /// Selects the tab whose bounds contain [globalPosition]'s x. A finger in the gap between two
  /// tabs keeps the current one, which also keeps the selection steady while the capsules resize.
  void _scrubTo(Offset globalPosition) {
    for (var index = 0; index < _itemKeys.length; index++) {
      final box = _itemKeys[index].currentContext?.findRenderObject();
      if (box is! RenderBox || !box.hasSize) continue;
      final left = box.localToGlobal(Offset.zero).dx;
      if (globalPosition.dx < left ||
          globalPosition.dx >= left + box.size.width) {
        continue;
      }
      if (index != _scrubbedIndex) {
        _scrubbedIndex = index;
        HapticFeedback.selectionClick();
        widget.onDestinationSelected(index);
      }
      return;
    }
  }

  void _endScrub() => _scrubbedIndex = null;

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
        // A drag that moves past touch slop scrubs at once; a press held still first becomes a
        // long press, whose moves scrub the same way. Either one wins over the tabs' own taps.
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onHorizontalDragStart: (details) =>
              _startScrub(details.globalPosition),
          onHorizontalDragUpdate: (details) => _scrubTo(details.globalPosition),
          onHorizontalDragEnd: (_) => _endScrub(),
          onHorizontalDragCancel: _endScrub,
          onLongPressStart: (details) {
            HapticFeedback.lightImpact();
            _startScrub(details.globalPosition);
          },
          onLongPressMoveUpdate: (details) => _scrubTo(details.globalPosition),
          onLongPressEnd: (_) => _endScrub(),
          onLongPressCancel: _endScrub,
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
                for (var index = 0; index < widget.destinations.length; index++)
                  _PillNavigationItem(
                    itemKey: _itemKeys[index],
                    destination: widget.destinations[index],
                    selected: index == widget.selectedIndex,
                    onTap: () => widget.onDestinationSelected(index),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PillNavigationItem extends StatelessWidget {
  const _PillNavigationItem({
    required this.itemKey,
    required this.destination,
    required this.selected,
    required this.onTap,
  });

  /// Marks this tab's bounds for the bar's scrub hit-test.
  final GlobalKey itemKey;
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
      key: itemKey,
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
    // Manual trigger: a press-and-hold on the bar scrubs between tabs, and a long-press tooltip
    // would compete with it for the same gesture. The scrubbed-to capsule shows the label instead.
    return Tooltip(
      message: destination.label,
      triggerMode: TooltipTriggerMode.manual,
      excludeFromSemantics: true,
      child: item,
    );
  }
}
