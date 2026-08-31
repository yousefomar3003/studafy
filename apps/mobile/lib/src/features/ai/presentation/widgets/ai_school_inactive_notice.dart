import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The school-inactive state: the school's own Studafy subscription has lapsed, so the AI add-on
/// is refused regardless of whether this student ever purchased one (see `AiHubSchoolInactive`'s
/// doc comment). Nothing this app or its checkout link can fix — the school's own subscription is
/// reactivated by the school, not a parent or student — so this is messaging only, with no action
/// button, unlike [AiUpsellCard].
class AiSchoolInactiveNotice extends StatelessWidget {
  const AiSchoolInactiveNotice({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space20),
      decoration: BoxDecoration(
        color: colorScheme.errorContainer,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, color: colorScheme.onErrorContainer),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ai.schoolInactive.title'.tr(),
                  style: textTheme.titleSmall?.copyWith(color: colorScheme.onErrorContainer),
                ),
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'ai.schoolInactive.body'.tr(),
                  style: textTheme.bodyMedium?.copyWith(color: colorScheme.onErrorContainer),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
