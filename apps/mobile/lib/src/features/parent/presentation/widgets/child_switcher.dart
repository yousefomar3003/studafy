import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/tokens/app_color_tokens.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../../../design/widgets/live_date_header.dart';
import '../../application/parent_providers.dart';
import '../../domain/attendance_alert.dart';
import '../comparison_screen.dart';

/// The child switcher: a filled hero card with one selectable avatar tile per linked child, horizontally scrollable. Tapping a
/// chip persists the choice (`SelectedChildController.select`) so it survives leaving and
/// re-opening the app. A child whose term attendance is elevated carries a warning dot and icon on
/// its tile.
///
/// Only children the child-comparison endpoint returns are shown, and that endpoint scopes to
/// the caller's `parent_child_links` rows — so the "only linked children appear" acceptance
/// criterion holds without any filtering here.
///
/// With two or more linked children, the header also carries the entry point to
/// [ChildComparisonScreen] — there is nothing to compare with only one.
class ChildSwitcher extends ConsumerWidget {
  const ChildSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final children = ref.watch(linkedChildrenProvider);
    final selected = ref.watch(selectedChildProvider).value;
    final canCompare = (children.value?.length ?? 0) >= 2;

    // The hero of the parent home: every card below it is scoped to the child picked here, so it
    // sits on the brand blue (the same in both themes) rather than the plain white card the
    // summary cards use, under today's date and time.
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        color: AppColorTokens.accent600,
        borderRadius: AppRadius.xlRadius,
        boxShadow: [
          BoxShadow(
            color: AppColorTokens.accent600.withValues(alpha: 0.25),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const LiveDateHeader(color: _onHero),
          const SizedBox(height: AppSpacing.space16),
          Divider(height: 1, color: _onHero.withValues(alpha: 0.16)),
          const SizedBox(height: AppSpacing.space12),
          Row(
            children: [
              Icon(Icons.family_restroom_outlined, size: 20, color: _onHero),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text(
                  'parent.switcher.title'.tr(),
                  style: theme.textTheme.titleMedium?.copyWith(
                    color: _onHero,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (canCompare)
                IconButton(
                  icon: const Icon(Icons.compare_arrows),
                  tooltip: 'parent.comparison.title'.tr(),
                  style: IconButton.styleFrom(
                    foregroundColor: _onHero,
                    backgroundColor: _onHero.withValues(alpha: 0.14),
                  ),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(builder: (_) => const ChildComparisonScreen()),
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.space12),
          children.when(
            loading: () => const _ChildTileSkeleton(),
            error: (_, _) => _HeroMessage(
              messageKey: 'parent.children.error',
              icon: Icons.error_outline,
            ),
            data: (list) {
              if (list.isEmpty) {
                return _HeroMessage(messageKey: 'parent.children.empty', icon: Icons.info_outline);
              }
              return SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                clipBehavior: Clip.none,
                child: Row(
                  children: [
                    for (final child in list)
                      Padding(
                        padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
                        child: _ChildTile(
                          name: child.studentName,
                          selected: child.studentId == selected?.studentId,
                          needsAttention: AttendanceAlert.fromMetrics(child.attendance).isElevated,
                          onTap: () => ref
                              .read(selectedChildControllerProvider.notifier)
                              .select(child.studentId),
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

/// One child in the switcher: an initials avatar and the child's name. The selected child is a
/// solid white tile that stands out from the translucent unselected ones.
class _ChildTile extends StatelessWidget {
  const _ChildTile({
    required this.name,
    required this.selected,
    required this.needsAttention,
    required this.onTap,
  });

  final String name;
  final bool selected;
  final bool needsAttention;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final background = selected ? AppColorTokens.white : _onHero.withValues(alpha: 0.14);
    final foreground = selected ? AppColorTokens.accent600 : _onHero;

    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: background,
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(
              AppSpacing.space4,
              AppSpacing.space4,
              AppSpacing.space16,
              AppSpacing.space4,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Badge(
                  isLabelVisible: needsAttention,
                  backgroundColor: colorScheme.error,
                  smallSize: 10,
                  child: ExcludeSemantics(
                    child: CircleAvatar(
                      radius: 18,
                      backgroundColor: selected
                          ? AppColorTokens.accent600
                          : _onHero.withValues(alpha: 0.2),
                      foregroundColor: _onHero,
                      child: Text(
                        _initials(name),
                        style: theme.textTheme.labelLarge?.copyWith(
                          color: _onHero,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                Text(
                  name,
                  style: theme.textTheme.titleSmall?.copyWith(
                    color: foreground,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                  ),
                ),
                if (needsAttention) ...[
                  const SizedBox(width: AppSpacing.space4),
                  Icon(
                    Icons.warning_amber_rounded,
                    size: 18,
                    color: selected ? colorScheme.error : _onHero,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _HeroMessage extends StatelessWidget {
  const _HeroMessage({required this.messageKey, required this.icon});

  final String messageKey;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    const color = _onHero;
    return Row(
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: AppSpacing.space8),
        Expanded(
          child: Text(messageKey.tr(), style: theme.textTheme.bodyMedium?.copyWith(color: color)),
        ),
      ],
    );
  }
}

/// Static loading placeholder in the shape of two child tiles (no animation, so goldens settle).
class _ChildTileSkeleton extends StatelessWidget {
  const _ChildTileSkeleton();

  @override
  Widget build(BuildContext context) {
    final color = _onHero.withValues(alpha: 0.14);
    return Row(
      children: [
        for (final width in const [128.0, 104.0]) ...[
          Container(
            width: width,
            height: 44,
            decoration: BoxDecoration(color: color, borderRadius: AppRadius.fullRadius),
          ),
          const SizedBox(width: AppSpacing.space8),
        ],
      ],
    );
  }
}

/// Text and icons on the blue hero.
const _onHero = AppColorTokens.white;

/// Up to two initials ("Adam Fares" → "AF").
String _initials(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '';
  final first = words.first.characters.first;
  final last = words.length > 1 ? words.last.characters.first : '';
  return (first + last).toUpperCase();
}
