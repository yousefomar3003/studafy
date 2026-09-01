import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/exam_state.dart';

/// The "lock-in start" step: the exam is generated but nothing about the timer has begun yet —
/// [ExamController.start] is the one action that stamps `started_at`/`expires_at` server-side,
/// so this view exists to make that a deliberate confirmation rather than something that could
/// happen by accident (a stray tap, a screen reopened at the wrong moment).
class ExamReadyView extends StatelessWidget {
  const ExamReadyView({required this.state, required this.onStart, super.key});

  final ExamReady state;
  final VoidCallback onStart;

  Future<void> _confirmStart(BuildContext context) async {
    final minutes = state.session.durationMinutes;
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('examMode.ready.confirmTitle'.tr()),
            content: Text(
              'examMode.ready.confirmBody'.tr(namedArgs: {'minutes': '$minutes'}),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: Text('examMode.ready.confirmCancel'.tr()),
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(true),
                child: Text('examMode.ready.confirmStart'.tr()),
              ),
            ],
          ),
        ) ??
        false;

    if (confirmed) onStart();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final session = state.session;

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.timer_outlined, size: 40, color: colorScheme.primary),
            const SizedBox(height: AppSpacing.space16),
            Text('examMode.ready.title'.tr(), style: textTheme.titleLarge),
            const SizedBox(height: AppSpacing.space8),
            Text(
              'examMode.ready.summary'.tr(
                namedArgs: {
                  'count': '${session.questionCount}',
                  'minutes': '${session.durationMinutes}',
                },
              ),
              style: textTheme.bodyLarge,
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'examMode.ready.warning'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
            if (state.startFailed) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(
                'examMode.ready.startFailed'.tr(),
                style: TextStyle(color: colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space24),
            FilledButton(
              onPressed: state.isStarting ? null : () => _confirmStart(context),
              child: state.isStarting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('examMode.ready.start'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
