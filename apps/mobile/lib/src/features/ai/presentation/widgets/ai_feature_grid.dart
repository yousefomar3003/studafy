import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/router/route_paths.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/ai_feature.dart';
import '../../../shell/presentation/shell_tab_placeholder.dart';

/// The subscribed-state feature hub: one tile per [AiFeature], in the same order as the backend's
/// own `AI_FEATURES` list.
class AiFeatureGrid extends StatelessWidget {
  const AiFeatureGrid({super.key});

  @override
  Widget build(BuildContext context) {
    return GridView.count(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisCount: 2,
      mainAxisSpacing: AppSpacing.space12,
      crossAxisSpacing: AppSpacing.space12,
      childAspectRatio: 1.3,
      children: [for (final feature in AiFeature.values) _AiFeatureTile(feature: feature)],
    );
  }
}

class _AiFeatureTile extends StatelessWidget {
  const _AiFeatureTile({required this.feature});

  final AiFeature feature;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Card(
      margin: EdgeInsets.zero,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        // Every feature but `quiz` (ST-230) and `flashcards` (ST-231) is still a later ticket
        // (ST-165 and siblings already implement the API side — see
        // apps/api/src/modules/ai/routes/*). Opening the same "coming soon" placeholder the shell
        // already uses for an unshipped tab keeps this honest rather than pretending the tile does
        // something it doesn't.
        onTap: () => switch (feature) {
          AiFeature.quiz => GoRouter.of(context).push(RoutePaths.quiz),
          AiFeature.flashcards => GoRouter.of(context).push(RoutePaths.flashcards),
          _ => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => Scaffold(
                appBar: AppBar(title: Text(feature.labelKey.tr())),
                body: ShellTabPlaceholder(titleKey: feature.labelKey),
              ),
            ),
          ),
        },
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(feature.icon, color: colorScheme.primary),
              const SizedBox(height: AppSpacing.space8),
              Text(feature.labelKey.tr(), style: textTheme.titleSmall),
            ],
          ),
        ),
      ),
    );
  }
}

/// UI-only presentation for [AiFeature] — icon and translation key. Kept out of the domain enum
/// itself, which stays a plain identifier list mirroring the backend's `AI_FEATURES`.
extension AiFeatureUi on AiFeature {
  IconData get icon => switch (this) {
    AiFeature.ask => Icons.chat_bubble_outline,
    AiFeature.exam => Icons.assignment_outlined,
    AiFeature.summary => Icons.summarize_outlined,
    AiFeature.concepts => Icons.lightbulb_outline,
    AiFeature.flashcards => Icons.style_outlined,
    AiFeature.quiz => Icons.quiz_outlined,
    AiFeature.explain => Icons.school_outlined,
  };

  String get labelKey => 'ai.hub.features.${name}.label';
}
