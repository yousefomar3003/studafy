import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ask_ai_providers.dart';
import '../domain/ai_source.dart';
import 'key_concepts_screen.dart';
import 'material_summary_screen.dart';
import 'widgets/ai_error_view.dart';
import 'widgets/ai_source_picker.dart';

/// The per-source tools the AI hub opens through [AiSourceChooserScreen].
enum AiSourceTool { summary, concepts }

/// "Choose a source" for a per-source AI tool (summary, key concepts), opened from the AI hub: a
/// class's study material, one of the student's assignments, or a file or photo of their own.
/// Choosing one replaces this screen with the tool, run on that source.
class AiSourceChooserScreen extends ConsumerWidget {
  const AiSourceChooserScreen({required this.tool, super.key});

  final AiSourceTool tool;

  void _open(BuildContext context, AiSourceChoice choice) {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => switch (tool) {
          AiSourceTool.summary => MaterialSummaryScreen.source(
            materialId: choice.id,
            title: choice.title,
          ),
          AiSourceTool.concepts => KeyConceptsScreen.source(
            materialId: choice.id,
            title: choice.title,
          ),
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signedIn = ref.watch(askAiStudentIdProvider) != null;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: Text('aiSources.chooser.title'.tr())),
      body: !signedIn
          ? const AiSignedOutView()
          : ListView(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.space16,
                AppSpacing.space16,
                AppSpacing.space16,
                AppSpacing.space32,
              ),
              children: [
                Text(
                  'aiSources.chooser.${tool.name}Hint'.tr(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: AppSpacing.space16),
                AiSourcePicker(
                  multiSelect: false,
                  selected: const {},
                  onSelect: (choice) => _open(context, choice),
                  studyMaterials: AiStudyMaterialChoiceList(
                    onSelect: (choice) => _open(context, choice),
                  ),
                ),
              ],
            ),
    );
  }
}
