import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/ai_study_providers.dart';
import '../application/ask_ai_providers.dart';
import '../domain/ai_explain.dart';
import '../domain/ai_study.dart';
import '../domain/ask_ai_conversation.dart';
import 'widgets/ai_error_view.dart';
import 'widgets/ai_quota_meter.dart';
import 'widgets/ask_ai_citation_chip.dart';

/// "Explain it simply": the student types a topic, picks how simple the explanation should be,
/// and gets the best-matching passage from their materials rewritten in plain language, with a
/// link back to where it came from. Changing the level re-explains the same passage; the other
/// matches are listed underneath to explain instead.
///
/// Route-only (`/me/explain`), reached from the AI hub's "Explain it simply" tile. Shows the
/// signed-out state with no session.
class ExplainScreen extends ConsumerStatefulWidget {
  const ExplainScreen({super.key});

  @override
  ConsumerState<ExplainScreen> createState() => _ExplainScreenState();
}

enum _Phase { idle, searching, explaining, ready, noMatch, failed }

class _ExplainScreenState extends ConsumerState<ExplainScreen> {
  final _topicController = TextEditingController();

  _Phase _phase = _Phase.idle;
  AiExplainLevel _level = AiExplainLevel.middle;
  List<AiExplainPassage> _passages = const [];
  AiExplainPassage? _passage;
  String? _explanation;
  AiStudyError? _error;

  /// Bumped on every request so a slow response for an abandoned one is dropped.
  int _request = 0;

  bool get _busy => _phase == _Phase.searching || _phase == _Phase.explaining;

  @override
  void initState() {
    super.initState();
    _topicController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _topicController.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final studentId = ref.read(askAiStudentIdProvider);
    final topic = _topicController.text.trim();
    if (studentId == null || topic.isEmpty || _busy) return;
    FocusScope.of(context).unfocus();

    final request = ++_request;
    setState(() {
      _phase = _Phase.searching;
      _passages = const [];
      _passage = null;
      _explanation = null;
      _error = null;
    });
    try {
      final passages = await ref
          .read(aiExplainClientProvider)
          .search(studentId: studentId, topic: topic);
      if (!mounted || request != _request) return;
      ref.invalidate(aiUsageProvider);
      if (passages.isEmpty) {
        setState(() => _phase = _Phase.noMatch);
        return;
      }
      setState(() => _passages = passages);
      await _explain(passages.first);
    } catch (error) {
      if (!mounted || request != _request) return;
      setState(() {
        _phase = _Phase.failed;
        _error = AiStudyError.classify(error);
      });
    }
  }

  Future<void> _explain(AiExplainPassage passage) async {
    final studentId = ref.read(askAiStudentIdProvider);
    if (studentId == null) return;

    final request = ++_request;
    setState(() {
      _phase = _Phase.explaining;
      _passage = passage;
      _explanation = null;
      _error = null;
    });
    try {
      final explanation = await ref
          .read(aiExplainClientProvider)
          .explain(
            studentId: studentId,
            chunkId: passage.chunkId,
            level: _level,
          );
      if (!mounted || request != _request) return;
      ref.invalidate(aiUsageProvider);
      setState(() {
        _phase = _Phase.ready;
        _explanation = explanation;
      });
    } catch (error) {
      if (!mounted || request != _request) return;
      setState(() {
        _phase = _Phase.failed;
        _error = AiStudyError.classify(error);
      });
    }
  }

  void _onLevelChanged(AiExplainLevel level) {
    if (level == _level) return;
    setState(() => _level = level);
    final passage = _passage;
    if (passage != null && !_busy) _explain(passage);
  }

  Future<void> _retry() async {
    final passage = _passage;
    if (passage != null) return _explain(passage);
    return _search();
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = ref.watch(askAiStudentIdProvider) != null;

    return Scaffold(
      appBar: AppBar(title: Text('aiExplain.title'.tr())),
      body: !signedIn
          ? const AiSignedOutView()
          : Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpacing.space16,
                      AppSpacing.space16,
                      AppSpacing.space16,
                      AppSpacing.space32,
                    ),
                    children: [
                      if (_phase == _Phase.idle) ...[
                        const _Intro(),
                        const SizedBox(height: AppSpacing.space24),
                      ],
                      _TopicField(
                        controller: _topicController,
                        enabled: !_busy,
                        onSubmitted: _search,
                      ),
                      const SizedBox(height: AppSpacing.space16),
                      _LevelPicker(
                        level: _level,
                        enabled: !_busy,
                        onChanged: _onLevelChanged,
                      ),
                      const SizedBox(height: AppSpacing.space16),
                      FilledButton.icon(
                        onPressed: _busy || _topicController.text.trim().isEmpty
                            ? null
                            : _search,
                        icon: const Icon(Icons.auto_awesome, size: 18),
                        label: Text('aiExplain.action'.tr()),
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(48),
                          shape: const RoundedRectangleBorder(
                            borderRadius: AppRadius.lgRadius,
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.space24),
                      ..._result(context),
                    ],
                  ),
                ),
                const AiQuotaMeter(),
              ],
            ),
    );
  }

  List<Widget> _result(BuildContext context) {
    final passage = _passage;
    final others = [
      for (final candidate in _passages)
        if (candidate.chunkId != passage?.chunkId) candidate,
    ];

    return [
      switch (_phase) {
        _Phase.idle => const SizedBox.shrink(),
        _Phase.searching => _Working(label: 'aiExplain.searching'.tr()),
        _Phase.explaining => _Working(label: 'aiExplain.explaining'.tr()),
        _Phase.noMatch => const _NoMatch(),
        _Phase.failed => AiErrorView(
          error: _error ?? AiStudyError.unknown,
          onRetry: _retry,
          compact: true,
        ),
        _Phase.ready => _ExplanationCard(
          explanation: _explanation ?? '',
          level: _level,
          passage: passage!,
        ),
      },
      if (others.isNotEmpty && _phase != _Phase.searching) ...[
        const SizedBox(height: AppSpacing.space24),
        Text(
          'aiExplain.others'.tr(),
          style: Theme.of(context).textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space8),
        for (final candidate in others)
          _PassageTile(
            passage: candidate,
            onTap: _busy ? null : () => _explain(candidate),
          ),
      ],
    ];
  }
}

class _Intro extends StatelessWidget {
  const _Intro();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [colorScheme.primaryContainer, colorScheme.surface],
            ),
            border: Border.all(color: colorScheme.primaryContainer),
          ),
          child: Icon(
            Icons.school_outlined,
            size: 30,
            color: colorScheme.primary,
          ),
        ),
        const SizedBox(height: AppSpacing.space16),
        Text(
          'aiExplain.intro.title'.tr(),
          style: theme.textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: AppSpacing.space8),
        Text(
          'aiExplain.intro.body'.tr(),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}

class _TopicField extends StatelessWidget {
  const _TopicField({
    required this.controller,
    required this.enabled,
    required this.onSubmitted,
  });

  final TextEditingController controller;
  final bool enabled;
  final VoidCallback onSubmitted;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      enabled: enabled,
      maxLength: 500,
      textInputAction: TextInputAction.search,
      onSubmitted: (_) => onSubmitted(),
      decoration: InputDecoration(
        labelText: 'aiExplain.topicLabel'.tr(),
        hintText: 'aiExplain.topicHint'.tr(),
        prefixIcon: const Icon(Icons.search_rounded),
        counterText: '',
        border: const OutlineInputBorder(borderRadius: AppRadius.lgRadius),
      ),
    );
  }
}

class _LevelPicker extends StatelessWidget {
  const _LevelPicker({
    required this.level,
    required this.enabled,
    required this.onChanged,
  });

  final AiExplainLevel level;
  final bool enabled;
  final ValueChanged<AiExplainLevel> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'aiExplain.levelLabel'.tr(),
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space8),
        SegmentedButton<AiExplainLevel>(
          showSelectedIcon: false,
          segments: [
            for (final value in AiExplainLevel.values)
              ButtonSegment(
                value: value,
                label: Text('aiExplain.levels.${value.name}'.tr()),
              ),
          ],
          selected: {level},
          onSelectionChanged: enabled
              ? (selection) => onChanged(selection.first)
              : null,
        ),
      ],
    );
  }
}

class _Working extends StatelessWidget {
  const _Working({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: AppRadius.lgRadius,
      ),
      child: Row(
        children: [
          const SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Text(
              label,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}

class _NoMatch extends StatelessWidget {
  const _NoMatch();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space16),
      decoration: BoxDecoration(
        borderRadius: AppRadius.lgRadius,
        border: Border.all(color: colorScheme.outlineVariant),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.travel_explore_outlined,
            size: 20,
            color: colorScheme.onSurfaceVariant,
          ),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'aiExplain.noMatch.title'.tr(),
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'aiExplain.noMatch.body'.tr(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ExplanationCard extends StatelessWidget {
  const _ExplanationCard({
    required this.explanation,
    required this.level,
    required this.passage,
  });

  final String explanation;
  final AiExplainLevel level;
  final AiExplainPassage passage;

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: explanation));
    if (!context.mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text('aiExplain.copied'.tr())));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    // A Material, not a decorated box, so the original-passage tile's ink shows.
    return Material(
      color: colorScheme.surface,
      shape: RoundedRectangleBorder(
        borderRadius: AppRadius.xlRadius,
        side: BorderSide(color: colorScheme.outlineVariant),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: colorScheme.primaryContainer.withValues(alpha: 0.5),
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space16,
              AppSpacing.space12,
              AppSpacing.space8,
              AppSpacing.space12,
            ),
            child: Row(
              children: [
                Icon(Icons.auto_awesome, size: 18, color: colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(
                    'aiExplain.resultTitle'.tr(),
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: colorScheme.onPrimaryContainer,
                    ),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space8,
                    vertical: AppSpacing.space4,
                  ),
                  decoration: BoxDecoration(
                    color: colorScheme.surface,
                    borderRadius: AppRadius.fullRadius,
                  ),
                  child: Text(
                    'aiExplain.levels.${level.name}'.tr(),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colorScheme.primary,
                    ),
                  ),
                ),
                IconButton(
                  onPressed: () => _copy(context),
                  icon: const Icon(Icons.content_copy_rounded, size: 18),
                  tooltip: 'aiExplain.copy'.tr(),
                  visualDensity: VisualDensity.compact,
                  color: colorScheme.onPrimaryContainer,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.space16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectableText(
                  explanation,
                  style: theme.textTheme.bodyLarge?.copyWith(height: 1.55),
                ),
                const SizedBox(height: AppSpacing.space16),
                Text(
                  'aiExplain.basedOn'.tr(),
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: AppSpacing.space4),
                AskAiCitationChip(
                  citation: AskAiCitation(
                    order: 1,
                    chunkId: passage.chunkId,
                    materialId: passage.materialId,
                    materialTitle: passage.materialTitle,
                    pageNumber: passage.pageNumber,
                    sectionTitle: passage.sectionTitle,
                  ),
                ),
              ],
            ),
          ),
          if (passage.content.isNotEmpty)
            Theme(
              // The tile's own dividers would double the card border.
              data: theme.copyWith(dividerColor: Colors.transparent),
              child: ExpansionTile(
                tilePadding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space16,
                ),
                childrenPadding: const EdgeInsets.fromLTRB(
                  AppSpacing.space16,
                  0,
                  AppSpacing.space16,
                  AppSpacing.space16,
                ),
                expandedCrossAxisAlignment: CrossAxisAlignment.start,
                title: Text(
                  'aiExplain.original'.tr(),
                  style: theme.textTheme.labelLarge,
                ),
                children: [
                  Text(
                    passage.content,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _PassageTile extends StatelessWidget {
  const _PassageTile({required this.passage, required this.onTap});

  final AiExplainPassage passage;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final source = [
      passage.materialTitle ?? 'askAi.citation.fallback'.tr(),
      if (passage.sectionTitle?.isNotEmpty ?? false) passage.sectionTitle!,
      if (passage.pageNumber != null)
        'aiStudy.sources.page'.tr(namedArgs: {'page': '${passage.pageNumber}'}),
    ].join(' · ');

    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Material(
        color: colorScheme.surface,
        shape: RoundedRectangleBorder(
          borderRadius: AppRadius.lgRadius,
          side: BorderSide(color: colorScheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space12),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        source,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: colorScheme.primary,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.space4),
                      Text(
                        passage.content,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                Icon(
                  Icons.chevron_right_rounded,
                  color: colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
