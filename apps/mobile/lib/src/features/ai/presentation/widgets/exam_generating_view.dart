import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/exam_state.dart';

/// Shown while an exam session is `ExamSessionStatus.generating` — item-bank generation runs on
/// a worker, off the request path, so this is a wait, not a progress bar with a known endpoint.
/// `ExamController` polls in the background on its own (with backoff, paused while the app is
/// backgrounded); once its polling window runs out ([ExamGenerating.pollingStopped]) this swaps
/// the spinner for a "check again" button, so a stuck job never keeps the screen polling forever.
class ExamGeneratingView extends StatelessWidget {
  const ExamGeneratingView({required this.state, required this.onCheckAgain, super.key});

  final ExamGenerating state;
  final VoidCallback onCheckAgain;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final stopped = state.pollingStopped;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (stopped)
              Icon(Icons.hourglass_bottom, size: 40, color: colorScheme.onSurfaceVariant)
            else
              const CircularProgressIndicator(),
            const SizedBox(height: AppSpacing.space20),
            Text(
              (stopped ? 'examMode.generating.stoppedTitle' : 'examMode.generating.title').tr(),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.space8),
            Text(
              (stopped ? 'examMode.generating.stoppedHint' : 'examMode.generating.hint').tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            if (stopped) ...[
              const SizedBox(height: AppSpacing.space20),
              FilledButton(
                onPressed: onCheckAgain,
                child: Text('examMode.generating.checkAgain'.tr()),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
