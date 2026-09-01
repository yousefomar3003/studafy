import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/exam.dart';
import '../../domain/exam_state.dart';

/// Below this, the countdown reads as urgent (the header turns to the error color) — purely
/// cosmetic, no bearing on when the server actually cuts the exam off.
const Duration _urgentThreshold = Duration(minutes: 1);

/// The timed player: one item at a time, a countdown against [remaining] (computed by
/// `ExamController.remaining`, server-synced), and a final submit that's always reachable, not
/// just from the last item — a student who wants to hand in early shouldn't have to click
/// through every remaining question first.
///
/// Unlike `QuizQuestionView`, nothing here is graded as the student goes: no citation, no
/// correct/incorrect feedback, no "check answer" step. Every answer is local until
/// [onSubmit] — that's the "mixed item player" acceptance criterion paired with a genuinely
/// one-shot submission, matching the server's own `in_progress -> submitted` transition.
class ExamPlayerView extends StatefulWidget {
  const ExamPlayerView({
    required this.state,
    required this.remaining,
    required this.onAnswer,
    required this.onNext,
    required this.onPrevious,
    required this.onSubmit,
    super.key,
  });

  final ExamInProgress state;
  final Duration remaining;
  final void Function(String itemId, String answer) onAnswer;
  final VoidCallback onNext;
  final VoidCallback onPrevious;
  final VoidCallback onSubmit;

  @override
  State<ExamPlayerView> createState() => _ExamPlayerViewState();
}

class _ExamPlayerViewState extends State<ExamPlayerView> {
  ExamItem get _item => widget.state.currentItem;

  Future<void> _confirmAndSubmit() async {
    final total = widget.state.itemCount;
    final unanswered = total - widget.state.answeredCount;
    final confirmed =
        await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('examMode.player.confirmSubmitTitle'.tr()),
            content: unanswered > 0
                ? Text(
                    'examMode.player.confirmSubmitBody'.tr(
                      namedArgs: {'count': '$unanswered', 'total': '$total'},
                    ),
                  )
                : null,
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(false),
                child: Text('examMode.player.confirmSubmitCancel'.tr()),
              ),
              FilledButton(
                onPressed: () => Navigator.of(context).pop(true),
                child: Text('examMode.player.confirmSubmitConfirm'.tr()),
              ),
            ],
          ),
        ) ??
        false;

    if (confirmed) widget.onSubmit();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          state: state,
          remaining: widget.remaining,
          onSubmitNow: state.isSubmitting ? null : _confirmAndSubmit,
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.space16),
            child: _ItemBody(
              key: ValueKey(_item.id),
              item: _item,
              savedAnswer: state.answers[_item.id],
              enabled: !state.isSubmitting,
              onChanged: (value) => widget.onAnswer(_item.id, value),
            ),
          ),
        ),
        if (state.submitError != null) _SubmitErrorBanner(error: state.submitError!),
        Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Row(
            children: [
              if (state.currentIndex > 0)
                Expanded(
                  child: OutlinedButton(
                    onPressed: state.isSubmitting ? null : widget.onPrevious,
                    child: Text('examMode.player.previous'.tr()),
                  ),
                ),
              if (state.currentIndex > 0) const SizedBox(width: AppSpacing.space12),
              Expanded(
                child: FilledButton(
                  onPressed: state.isSubmitting
                      ? null
                      : (state.isLastItem ? _confirmAndSubmit : widget.onNext),
                  child: state.isSubmitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(
                          (state.isLastItem ? 'examMode.player.submit' : 'examMode.player.next')
                              .tr(),
                        ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.state, required this.remaining, required this.onSubmitNow});

  final ExamInProgress state;
  final Duration remaining;
  final VoidCallback? onSubmitNow;

  String _formatRemaining(Duration duration) {
    final totalSeconds = duration.inSeconds;
    final hours = totalSeconds ~/ 3600;
    final minutes = (totalSeconds % 3600) ~/ 60;
    final seconds = totalSeconds % 60;
    final mm = minutes.toString().padLeft(2, '0');
    final ss = seconds.toString().padLeft(2, '0');
    return hours > 0 ? '$hours:$mm:$ss' : '$mm:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final position = state.currentIndex + 1;
    final total = state.itemCount;
    final urgent = remaining <= _urgentThreshold;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space8,
        AppSpacing.space8,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'examMode.player.progress'.tr(
                    namedArgs: {'position': '$position', 'total': '$total'},
                  ),
                  style: Theme.of(context).textTheme.labelMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Icon(Icons.timer_outlined, size: 16, color: urgent ? colorScheme.error : colorScheme.onSurfaceVariant),
              const SizedBox(width: AppSpacing.space4),
              Text(
                remaining == Duration.zero
                    ? 'examMode.player.timeUp'.tr()
                    : 'examMode.player.timeRemaining'.tr(
                        namedArgs: {'time': _formatRemaining(remaining)},
                      ),
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: urgent ? colorScheme.error : colorScheme.onSurfaceVariant,
                  fontWeight: urgent ? FontWeight.bold : null,
                ),
              ),
              TextButton(
                onPressed: onSubmitNow,
                child: Text('examMode.player.submitNow'.tr()),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          LinearProgressIndicator(value: position / total),
        ],
      ),
    );
  }
}

class _ItemBody extends StatefulWidget {
  const _ItemBody({
    required this.item,
    required this.savedAnswer,
    required this.enabled,
    required this.onChanged,
    super.key,
  });

  final ExamItem item;
  final String? savedAnswer;
  final bool enabled;
  final ValueChanged<String> onChanged;

  @override
  State<_ItemBody> createState() => _ItemBodyState();
}

class _ItemBodyState extends State<_ItemBody> {
  String? _selectedOptionId;
  late final _answerController = TextEditingController(text: widget.savedAnswer);

  @override
  void initState() {
    super.initState();
    _selectedOptionId = widget.savedAnswer;
  }

  @override
  void dispose() {
    _answerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(item.prompt, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space16),
        if (item.type == ExamItemType.mcq)
          Column(
            children: [
              for (final option in item.options ?? const [])
                RadioListTile<String>(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(option.text),
                  value: option.id,
                  groupValue: _selectedOptionId,
                  onChanged: widget.enabled
                      ? (value) {
                          setState(() => _selectedOptionId = value);
                          widget.onChanged(value!);
                        }
                      : null,
                ),
            ],
          )
        else
          TextField(
            controller: _answerController,
            enabled: widget.enabled,
            onChanged: widget.onChanged,
            maxLines: 3,
            minLines: 1,
            decoration: InputDecoration(
              hintText: 'examMode.player.shortAnswerHint'.tr(),
              border: const OutlineInputBorder(),
            ),
          ),
      ],
    );
  }
}

class _SubmitErrorBanner extends StatelessWidget {
  const _SubmitErrorBanner({required this.error});

  final ExamSubmitError error;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Material(
      color: colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space16,
          vertical: AppSpacing.space8,
        ),
        child: Row(
          children: [
            Icon(Icons.error_outline, size: 18, color: colorScheme.onErrorContainer),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(_messageKeyFor(error).tr(), style: TextStyle(color: colorScheme.onErrorContainer)),
            ),
          ],
        ),
      ),
    );
  }

  String _messageKeyFor(ExamSubmitError error) => switch (error) {
    ExamSubmitError.expired => 'examMode.player.submitError.expired',
    ExamSubmitError.network => 'examMode.player.submitError.network',
    ExamSubmitError.unknown => 'examMode.player.submitError.unknown',
  };
}
