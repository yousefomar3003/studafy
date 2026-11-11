import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// Shown when the server refused a submission because time had run out (`ExamExpired`, 409
/// `AI_EXAM_EXPIRED`). Terminal: the session can never be scored, so the only action is a new
/// exam — unlike the player's inline error banner, there is no retry to offer.
class ExamExpiredView extends StatelessWidget {
  const ExamExpiredView({required this.onStartNew, super.key});

  final VoidCallback onStartNew;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.timer_off_outlined, size: 40, color: colorScheme.error),
            const SizedBox(height: AppSpacing.space16),
            Text('examMode.expired.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'examMode.expired.body'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space20),
            FilledButton(onPressed: onStartNew, child: Text('examMode.expired.startNew'.tr())),
          ],
        ),
      ),
    );
  }
}
