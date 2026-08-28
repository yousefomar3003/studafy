import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../design/theme/app_semantic_colors.dart';
import '../../design/tokens/app_spacing_tokens.dart';

/// Shown above content read from the offline cache instead of a live response — see
/// [CachedValue.isStale] (`cached_value.dart`). [fetchedAt] renders as a relative "updated X ago"
/// so the reader can judge how current the cached data might be.
class StalenessBanner extends StatelessWidget {
  const StalenessBanner({required this.fetchedAt, super.key});

  final DateTime fetchedAt;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final semanticColors = theme.extension<AppSemanticColors>()!;

    return ColoredBox(
      color: semanticColors.warningContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space12,
        ),
        child: Row(
          children: [
            Icon(Icons.cloud_off_outlined, size: 20, color: semanticColors.onWarningContainer),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                'offline.stalenessBanner'.tr(namedArgs: {'time': _relativeTime(fetchedAt)}),
                style: theme.textTheme.bodyMedium?.copyWith(color: semanticColors.onWarningContainer),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _relativeTime(DateTime fetchedAt) {
    final age = DateTime.now().difference(fetchedAt);
    if (age.inMinutes < 1) return 'offline.justNow'.tr();
    if (age.inMinutes < 60) {
      return 'offline.minutesAgo'.tr(namedArgs: {'count': '${age.inMinutes}'});
    }
    if (age.inHours < 24) return 'offline.hoursAgo'.tr(namedArgs: {'count': '${age.inHours}'});
    return 'offline.daysAgo'.tr(namedArgs: {'count': '${age.inDays}'});
  }
}
