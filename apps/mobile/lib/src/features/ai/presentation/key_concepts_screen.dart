import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/material.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_study_providers.dart';
import '../application/ask_ai_providers.dart';
import '../domain/ai_study.dart';
import 'widgets/ai_error_view.dart';
import 'widgets/ai_quota_meter.dart';
import 'widgets/ai_source_anchor_chip.dart';

/// Per-material key-concepts list: each concept with a one-line grounded explanation and the
/// source anchors it draws on. One-shot (no length preset), so it reads straight from
/// [keyConceptsProvider].
///
/// Pushed from [MaterialViewerScreen] for an AI-visible material; shows the signed-out state with
/// no session.
class KeyConceptsScreen extends ConsumerWidget {
  const KeyConceptsScreen({required this.material, super.key});

  final Material material;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final signedIn = ref.watch(askAiStudentIdProvider) != null;
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(material.title, style: textTheme.titleMedium, overflow: TextOverflow.ellipsis),
            Text(
              'aiStudy.concepts.subtitle'.tr(),
              style: textTheme.labelSmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
      body: !signedIn
          ? const AiSignedOutView()
          : Column(
              children: [
                Expanded(child: _ConceptsBody(materialId: material.id)),
                const AiQuotaMeter(),
              ],
            ),
    );
  }
}

class _ConceptsBody extends ConsumerWidget {
  const _ConceptsBody({required this.materialId});

  final String materialId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ref
        .watch(keyConceptsProvider(materialId))
        .when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => AiErrorView(
            error: AiStudyError.classify(error),
            onRetry: () async => ref.invalidate(keyConceptsProvider(materialId)),
          ),
          data: (concepts) {
            if (concepts.isEmpty) return const _EmptyConcepts();
            return ListView.separated(
              padding: const EdgeInsets.all(AppSpacing.space16),
              itemCount: concepts.length,
              separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.space12),
              itemBuilder: (_, index) =>
                  _ConceptCard(concept: concepts[index], materialId: materialId),
            );
          },
        );
  }
}

class _ConceptCard extends StatelessWidget {
  const _ConceptCard({required this.concept, required this.materialId});

  final AiConcept concept;
  final String materialId;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.space12),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
        border: Border.all(color: colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(concept.name, style: textTheme.titleSmall),
          if (concept.explanation.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space4),
            Text(concept.explanation, style: textTheme.bodyMedium),
          ],
          if (concept.sources.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            Wrap(
              spacing: AppSpacing.space8,
              runSpacing: AppSpacing.space4,
              children: [
                for (final anchor in concept.sources)
                  AiSourceAnchorChip(anchor: anchor, materialId: materialId),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _EmptyConcepts extends StatelessWidget {
  const _EmptyConcepts();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.lightbulb_outline, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'aiStudy.concepts.empty'.tr(),
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}
