import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/exam_controller.dart';
import '../../domain/exam_state.dart';
import 'exam_material_picker.dart';

/// The exam screen's landing step: pick up to [examMaxMaterials] ready materials, how many
/// questions to generate, and the time limit, then create the session. Generation itself runs on
/// a worker off the request path — [ExamController.create] moves on to [ExamGenerating]
/// immediately rather than waiting here.
class ExamSetupView extends StatefulWidget {
  const ExamSetupView({
    required this.state,
    required this.onCreate,
    required this.onRetryRestore,
    super.key,
  });

  final ExamSetup state;
  final void Function(List<String> materialIds, int questionCount, int durationMinutes) onCreate;
  final VoidCallback onRetryRestore;

  @override
  State<ExamSetupView> createState() => _ExamSetupViewState();
}

class _ExamSetupViewState extends State<ExamSetupView> {
  final Set<String> _selected = {};
  int _questionCount = examDefaultQuestions;
  int _durationMinutes = examDefaultDurationMinutes;

  void _toggle(String materialId) {
    setState(() {
      if (!_selected.remove(materialId)) _selected.add(materialId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final canCreate = _selected.isNotEmpty && !widget.state.isCreating;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        if (widget.state.restoreFailed) ...[
          _RestoreFailedBanner(onRetry: widget.onRetryRestore),
          const SizedBox(height: AppSpacing.space16),
        ],
        Text('examMode.setup.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text('examMode.setup.hint'.tr(), style: TextStyle(color: colorScheme.onSurfaceVariant)),
        const SizedBox(height: AppSpacing.space16),
        ExamMaterialPicker(selected: _selected, onToggle: _toggle, maxSelectable: examMaxMaterials),
        const SizedBox(height: AppSpacing.space20),
        Text('examMode.setup.questionCount'.tr(), style: Theme.of(context).textTheme.titleSmall),
        Slider(
          value: _questionCount.toDouble(),
          min: examMinQuestions.toDouble(),
          max: examMaxQuestions.toDouble(),
          divisions: examMaxQuestions - examMinQuestions,
          label: '$_questionCount',
          onChanged: (value) => setState(() => _questionCount = value.round()),
        ),
        const SizedBox(height: AppSpacing.space12),
        Text('examMode.setup.duration'.tr(), style: Theme.of(context).textTheme.titleSmall),
        Slider(
          value: _durationMinutes.toDouble(),
          min: examMinDurationMinutes.toDouble(),
          max: examMaxDurationMinutes.toDouble(),
          divisions: (examMaxDurationMinutes - examMinDurationMinutes) ~/ 5,
          label: '$_durationMinutes',
          onChanged: (value) => setState(() => _durationMinutes = value.round()),
        ),
        if (widget.state.createError != null) ...[
          const SizedBox(height: AppSpacing.space8),
          _CreateErrorBanner(error: widget.state.createError!),
        ],
        const SizedBox(height: AppSpacing.space16),
        FilledButton(
          onPressed: canCreate
              ? () => widget.onCreate(_selected.toList(), _questionCount, _durationMinutes)
              : null,
          child: widget.state.isCreating
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text('examMode.setup.start'.tr()),
        ),
      ],
    );
  }
}

class _RestoreFailedBanner extends StatelessWidget {
  const _RestoreFailedBanner({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(
        color: colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.wifi_off, size: 18, color: colorScheme.onErrorContainer),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              'examMode.setup.restoreFailed'.tr(),
              style: TextStyle(color: colorScheme.onErrorContainer),
            ),
          ),
          TextButton(onPressed: onRetry, child: Text('examMode.setup.retry'.tr())),
        ],
      ),
    );
  }
}

class _CreateErrorBanner extends StatelessWidget {
  const _CreateErrorBanner({required this.error});

  final ExamCreateError error;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(
        color: colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
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
    );
  }

  String _messageKeyFor(ExamCreateError error) => switch (error) {
    ExamCreateError.quotaExceeded => 'examMode.setup.createError.quotaExceeded',
    ExamCreateError.subscriptionInactive => 'examMode.setup.createError.subscriptionInactive',
    ExamCreateError.schoolInactive => 'examMode.setup.createError.schoolInactive',
    ExamCreateError.llmDisabled => 'examMode.setup.createError.llmDisabled',
    ExamCreateError.materialNotFound => 'examMode.setup.createError.materialNotFound',
    ExamCreateError.materialNotReady => 'examMode.setup.createError.materialNotReady',
    ExamCreateError.generationUnavailable => 'examMode.setup.createError.generationUnavailable',
    ExamCreateError.network => 'examMode.setup.createError.network',
    ExamCreateError.unknown => 'examMode.setup.createError.unknown',
  };
}
