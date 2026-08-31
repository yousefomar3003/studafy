import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/quiz_controller.dart';
import '../../domain/quiz_state.dart';
import 'quiz_material_picker.dart';

/// The quiz screen's landing step: pick up to [quizMaxMaterials] ready materials and how many
/// questions to generate, then start round 1.
class QuizSetupView extends StatefulWidget {
  const QuizSetupView({required this.state, required this.onGenerate, super.key});

  final QuizSetup state;
  final void Function(List<String> materialIds, int questionCount) onGenerate;

  @override
  State<QuizSetupView> createState() => _QuizSetupViewState();
}

class _QuizSetupViewState extends State<QuizSetupView> {
  final Set<String> _selected = {};
  int _questionCount = quizDefaultQuestions;

  void _toggle(String materialId) {
    setState(() {
      if (!_selected.remove(materialId)) _selected.add(materialId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final canGenerate = _selected.isNotEmpty && !widget.state.isGenerating;

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        Text('quiz.setup.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text(
          'quiz.setup.hint'.tr(),
          style: TextStyle(color: colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: AppSpacing.space16),
        QuizMaterialPicker(
          selected: _selected,
          onToggle: _toggle,
          maxSelectable: quizMaxMaterials,
        ),
        const SizedBox(height: AppSpacing.space20),
        Text('quiz.setup.questionCount'.tr(), style: Theme.of(context).textTheme.titleSmall),
        Slider(
          value: _questionCount.toDouble(),
          min: quizMinQuestions.toDouble(),
          max: quizMaxQuestions.toDouble(),
          divisions: quizMaxQuestions - quizMinQuestions,
          label: '$_questionCount',
          onChanged: (value) => setState(() => _questionCount = value.round()),
        ),
        if (widget.state.generateError != null) ...[
          const SizedBox(height: AppSpacing.space8),
          _GenerateErrorBanner(error: widget.state.generateError!),
        ],
        const SizedBox(height: AppSpacing.space16),
        FilledButton(
          onPressed: canGenerate ? () => widget.onGenerate(_selected.toList(), _questionCount) : null,
          child: widget.state.isGenerating
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text('quiz.setup.start'.tr()),
        ),
      ],
    );
  }
}

class _GenerateErrorBanner extends StatelessWidget {
  const _GenerateErrorBanner({required this.error});

  final QuizGenerateError error;

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

  String _messageKeyFor(QuizGenerateError error) => switch (error) {
    QuizGenerateError.quotaExceeded => 'quiz.setup.generateError.quotaExceeded',
    QuizGenerateError.subscriptionInactive => 'quiz.setup.generateError.subscriptionInactive',
    QuizGenerateError.schoolInactive => 'quiz.setup.generateError.schoolInactive',
    QuizGenerateError.llmDisabled => 'quiz.setup.generateError.llmDisabled',
    QuizGenerateError.materialNotFound => 'quiz.setup.generateError.materialNotFound',
    QuizGenerateError.materialNotReady => 'quiz.setup.generateError.materialNotReady',
    QuizGenerateError.generationFailed => 'quiz.setup.generateError.generationFailed',
    QuizGenerateError.network => 'quiz.setup.generateError.network',
    QuizGenerateError.unknown => 'quiz.setup.generateError.unknown',
  };
}
