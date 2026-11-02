import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// Shown when item-bank generation failed on the worker (`ExamSessionStatus.failed`). The
/// server-side `failure_reason` is an internal diagnostic string, not user-facing copy — this
/// always renders the same generic message regardless of what it says.
class ExamFailedView extends StatelessWidget {
  const ExamFailedView({required this.onStartNew, super.key});

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
            Icon(Icons.error_outline, size: 40, color: colorScheme.error),
            const SizedBox(height: AppSpacing.space16),
            Text('examMode.failed.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'examMode.failed.body'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space20),
            FilledButton(onPressed: onStartNew, child: Text('examMode.failed.startNew'.tr())),
          ],
        ),
      ),
    );
  }
}
