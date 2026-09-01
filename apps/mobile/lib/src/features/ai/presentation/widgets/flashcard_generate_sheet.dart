import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/flashcard_providers.dart';
import '../../domain/flashcard_state.dart';
import 'flashcard_material_picker.dart';

/// The deck-generation form, opened as a modal sheet from the deck browser: pick up to
/// [flashcardMaxMaterials] ready materials and how many cards to generate, mirroring
/// `QuizSetupView`'s layout for the equivalent quiz step.
class FlashcardGenerateSheet extends StatefulWidget {
  const FlashcardGenerateSheet({
    required this.isGenerating,
    required this.generateError,
    required this.onGenerate,
    super.key,
  });

  final bool isGenerating;
  final FlashcardGenerateError? generateError;
  final void Function(List<String> materialIds, List<String> materialTitles, int cardCount)
  onGenerate;

  @override
  State<FlashcardGenerateSheet> createState() => _FlashcardGenerateSheetState();
}

class _FlashcardGenerateSheetState extends State<FlashcardGenerateSheet> {
  final Map<String, String> _selected = {};
  int _cardCount = flashcardDefaultCards;

  void _toggle(String materialId, String materialTitle) {
    setState(() {
      if (_selected.remove(materialId) == null) _selected[materialId] = materialTitle;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final canGenerate = _selected.isNotEmpty && !widget.isGenerating;

    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.space16,
        right: AppSpacing.space16,
        top: AppSpacing.space16,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.space16,
      ),
      child: ListView(
        shrinkWrap: true,
        children: [
          Text('flashcards.generate.title'.tr(), style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: AppSpacing.space4),
          Text('flashcards.generate.hint'.tr(), style: TextStyle(color: colorScheme.onSurfaceVariant)),
          const SizedBox(height: AppSpacing.space16),
          FlashcardMaterialPicker(
            selected: _selected.keys.toSet(),
            onToggle: _toggle,
            maxSelectable: flashcardMaxMaterials,
          ),
          const SizedBox(height: AppSpacing.space20),
          Text('flashcards.generate.cardCount'.tr(), style: Theme.of(context).textTheme.titleSmall),
          Slider(
            value: _cardCount.toDouble(),
            min: flashcardMinCards.toDouble(),
            max: flashcardMaxCards.toDouble(),
            divisions: flashcardMaxCards - flashcardMinCards,
            label: '$_cardCount',
            onChanged: (value) => setState(() => _cardCount = value.round()),
          ),
          if (widget.generateError != null) ...[
            const SizedBox(height: AppSpacing.space8),
            _GenerateErrorBanner(error: widget.generateError!),
          ],
          const SizedBox(height: AppSpacing.space16),
          FilledButton(
            onPressed: canGenerate
                ? () => widget.onGenerate(_selected.keys.toList(), _selected.values.toList(), _cardCount)
                : null,
            child: widget.isGenerating
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text('flashcards.generate.start'.tr()),
          ),
        ],
      ),
    );
  }
}

class _GenerateErrorBanner extends StatelessWidget {
  const _GenerateErrorBanner({required this.error});

  final FlashcardGenerateError error;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(color: colorScheme.errorContainer, borderRadius: BorderRadius.circular(8)),
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

  String _messageKeyFor(FlashcardGenerateError error) => switch (error) {
    FlashcardGenerateError.quotaExceeded => 'flashcards.generate.generateError.quotaExceeded',
    FlashcardGenerateError.subscriptionInactive =>
      'flashcards.generate.generateError.subscriptionInactive',
    FlashcardGenerateError.schoolInactive => 'flashcards.generate.generateError.schoolInactive',
    FlashcardGenerateError.llmDisabled => 'flashcards.generate.generateError.llmDisabled',
    FlashcardGenerateError.materialNotFound => 'flashcards.generate.generateError.materialNotFound',
    FlashcardGenerateError.materialNotReady => 'flashcards.generate.generateError.materialNotReady',
    FlashcardGenerateError.generationFailed => 'flashcards.generate.generateError.generationFailed',
    FlashcardGenerateError.network => 'flashcards.generate.generateError.network',
    FlashcardGenerateError.unknown => 'flashcards.generate.generateError.unknown',
  };
}
