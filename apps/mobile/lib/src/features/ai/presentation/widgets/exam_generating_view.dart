import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';

/// Shown while an exam session is `ExamSessionStatus.generating` — item-bank generation runs on
/// a worker, off the request path, so this is a wait, not a progress bar with a known endpoint.
/// `ExamController` polls in the background on its own; there is nothing for this view to do but
/// stay on screen.
class ExamGeneratingView extends StatelessWidget {
  const ExamGeneratingView({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.space20),
            Text('examMode.generating.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'examMode.generating.hint'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
