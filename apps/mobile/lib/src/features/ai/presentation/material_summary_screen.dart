import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/material.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_study_providers.dart';
import '../application/ask_ai_providers.dart';
import '../application/material_summary_controller.dart';
import '../domain/ai_study.dart';
import 'widgets/ai_error_view.dart';
import 'widgets/ai_quota_meter.dart';
import 'widgets/ai_source_anchor_chip.dart';

/// Per-material AI summary with brief / standard / detailed length presets. Switching to a preset
/// already fetched re-renders instantly from [MaterialSummaryController]'s in-memory cache; the
/// first switch to each preset costs one request, then the server serves that preset for free.
///
/// Pushed from [MaterialViewerScreen] for an AI-visible material. Needs the signed-in student's id
/// (their user id — see `askAiStudentIdProvider`); with no session it shows the signed-out state.
class MaterialSummaryScreen extends ConsumerStatefulWidget {
  const MaterialSummaryScreen({required this.material, super.key});

  final Material material;

  @override
  ConsumerState<MaterialSummaryScreen> createState() => _MaterialSummaryScreenState();
}

class _MaterialSummaryScreenState extends ConsumerState<MaterialSummaryScreen> {
  MaterialSummaryController? _controller;

  @override
  void initState() {
    super.initState();
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId != null) {
      final controller = MaterialSummaryController(
        client: ref.read(aiStudyClientProvider),
        studentId: studentId,
        materialId: widget.material.id,
        onUsageChanged: () => ref.invalidate(aiUsageProvider),
      )..addListener(_onChange);
      _controller = controller;
      // Kick off the first preset after the initial frame — select() notifies synchronously and
      // setState() during initState is not allowed.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) controller.select(AiSummaryLength.standard);
      });
    }
  }

  void _onChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller?.removeListener(_onChange);
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;

    return Scaffold(
      appBar: AppBar(
        title: _AppBarTitle(
          title: widget.material.title,
          subtitle: 'aiStudy.summary.subtitle'.tr(),
        ),
      ),
      body: controller == null
          ? const AiSignedOutView()
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space16,
                    AppSpacing.space8,
                  ),
                  child: _LengthSelector(
                    selected: controller.selected,
                    enabled: !controller.isLoading,
                    onChanged: controller.select,
                  ),
                ),
                Expanded(
                  child: _SummaryBody(
                    controller: controller,
                    materialId: widget.material.id,
                  ),
                ),
                const AiQuotaMeter(),
              ],
            ),
    );
  }
}

class _AppBarTitle extends StatelessWidget {
  const _AppBarTitle({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(title, style: textTheme.titleMedium, overflow: TextOverflow.ellipsis),
        Text(
          subtitle,
          style: textTheme.labelSmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _LengthSelector extends StatelessWidget {
  const _LengthSelector({
    required this.selected,
    required this.enabled,
    required this.onChanged,
  });

  final AiSummaryLength selected;
  final bool enabled;
  final ValueChanged<AiSummaryLength> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: SegmentedButton<AiSummaryLength>(
        segments: [
          for (final length in AiSummaryLength.values)
            ButtonSegment(value: length, label: Text('aiStudy.length.${length.name}'.tr())),
        ],
        selected: {selected},
        showSelectedIcon: false,
        onSelectionChanged: enabled ? (selection) => onChanged(selection.first) : null,
      ),
    );
  }
}

class _SummaryBody extends StatelessWidget {
  const _SummaryBody({required this.controller, required this.materialId});

  final MaterialSummaryController controller;
  final String materialId;

  @override
  Widget build(BuildContext context) {
    final summary = controller.current;

    if (summary == null) {
      if (controller.error != null) {
        return AiErrorView(error: controller.error!, onRetry: controller.retry);
      }
      return const Center(child: CircularProgressIndicator());
    }

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      children: [
        if (controller.isLoading)
          const Padding(
            padding: EdgeInsets.only(bottom: AppSpacing.space12),
            child: LinearProgressIndicator(),
          ),
        if (controller.error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: AiErrorView(
              error: controller.error!,
              onRetry: controller.retry,
              compact: true,
            ),
          ),
        if (summary.cached) ...[
          const _CachedBadge(),
          const SizedBox(height: AppSpacing.space8),
        ],
        SelectableText(summary.text),
        if (summary.sources.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space16),
          Text(
            'aiStudy.sources.heading'.tr(),
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space8),
          Wrap(
            spacing: AppSpacing.space8,
            runSpacing: AppSpacing.space4,
            children: [
              for (final anchor in summary.sources)
                AiSourceAnchorChip(anchor: anchor, materialId: materialId),
            ],
          ),
        ],
      ],
    );
  }
}

class _CachedBadge extends StatelessWidget {
  const _CachedBadge();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space8,
          vertical: AppSpacing.space4,
        ),
        decoration: BoxDecoration(
          color: colorScheme.secondaryContainer,
          borderRadius: AppRadius.smRadius,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.bolt_outlined, size: 14, color: colorScheme.onSecondaryContainer),
            const SizedBox(width: AppSpacing.space4),
            Text(
              'aiStudy.summary.cached'.tr(),
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: colorScheme.onSecondaryContainer,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
