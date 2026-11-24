import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_plans_providers.dart';
import '../application/predicted_grades_providers.dart';
import '../domain/academic_plans.dart';
import 'widgets/academic_plan_common.dart';
import 'widgets/mark_sheet_common.dart';

/// The subject teacher's learning outcome achievement (000267) for the class's section and
/// subject: pick a period and an outcome, then give each student a level of the school's scale,
/// saved together. Read-only once the period is finalized or the year is closed.
///
/// Pushed from [TeacherClassDetailScreen]. The class resolves to its grade section and subject
/// first; a class without a section has no outcomes.
class OutcomeAchievementScreen extends ConsumerWidget {
  const OutcomeAchievementScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = ref.watch(classGradingTargetProvider(classId));
    Widget shell(Widget body) => Scaffold(
      appBar: AppBar(title: Text('teacher.outcomes.title'.tr())),
      body: body,
    );
    return target.when(
      loading: () => shell(const Center(child: CircularProgressIndicator())),
      error: (_, _) => shell(
        MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.outcomes.error'.tr(),
          onRetry: () => ref.invalidate(classGradingTargetProvider(classId)),
        ),
      ),
      data: (target) => target == null
          ? shell(
              MarksMessage(
                icon: Icons.info_outline,
                message: 'teacher.outcomes.noSection'.tr(),
              ),
            )
          : OutcomeAchievementEditor(
              sectionId: target.sectionId,
              subjectId: target.subjectId,
              classCode: classCode,
            ),
    );
  }
}

class OutcomeAchievementEditor extends ConsumerStatefulWidget {
  const OutcomeAchievementEditor({
    required this.sectionId,
    required this.subjectId,
    required this.classCode,
    super.key,
  });

  final String sectionId;
  final String subjectId;
  final String classCode;

  @override
  ConsumerState<OutcomeAchievementEditor> createState() =>
      _OutcomeAchievementEditorState();
}

class _OutcomeAchievementEditorState
    extends ConsumerState<OutcomeAchievementEditor> {
  String? _termId;
  String? _outcomeId;

  /// Unsaved levels by (student, outcome); null clears.
  final Map<(String, String), int?> _edits = {};
  bool _saving = false;

  SectionSubjectPeriod get _key => (
    sectionId: widget.sectionId,
    subjectId: widget.subjectId,
    termId: _termId,
  );

  Map<(String, String), int?> _changes(SectionOutcomeAchievements data) => {
    for (final student in data.students)
      for (final outcome in data.outcomes)
        if (_edits.containsKey((student.studentId, outcome.id)) &&
            _edits[(student.studentId, outcome.id)] !=
                student.levels[outcome.id])
          (student.studentId, outcome.id):
              _edits[(student.studentId, outcome.id)],
  };

  Future<void> _save(SectionOutcomeAchievements data) async {
    final changes = _changes(data);
    if (changes.isEmpty) return;
    setState(() => _saving = true);
    try {
      await ref
          .read(academicPlansClientProvider)
          .saveAchievements(
            widget.sectionId,
            widget.subjectId,
            termId: _termId,
            levels: changes,
          );
      if (!mounted) return;
      _edits.clear();
      ref.invalidate(outcomeAchievementsProvider(_key));
      _snack('teacher.outcomes.saved'.tr());
    } catch (error) {
      _snack(planErrorMessage(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(outcomeAchievementsProvider(_key));
    final data = async.value;
    final dirty = data != null && _changes(data).isNotEmpty;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('teacher.outcomes.title'.tr()),
            Text(
              data == null
                  ? widget.classCode
                  : [
                      data.subjectName,
                      data.sectionLabel,
                    ].where((part) => part.isNotEmpty).join(' · '),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          if (data?.editable ?? false)
            TextButton(
              onPressed: dirty && !_saving ? () => _save(data) : null,
              child: Text('teacher.outcomes.save'.tr()),
            ),
        ],
      ),
      body: async.when(
        skipLoadingOnReload: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.outcomes.error'.tr(),
          onRetry: () => ref.invalidate(outcomeAchievementsProvider(_key)),
        ),
        data: _body,
      ),
    );
  }

  Widget _body(SectionOutcomeAchievements data) {
    final theme = Theme.of(context);
    final language = context.locale.languageCode;
    final outcome =
        data.outcomes.where((o) => o.id == _outcomeId).firstOrNull ??
        data.outcomes.firstOrNull;
    final notice = data.finalized
        ? 'teacher.outcomes.finalized'.tr()
        : !data.editable
        ? 'teacher.outcomes.readOnly'.tr()
        : null;
    return ListView(
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(
          'teacher.outcomes.help'.tr(),
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space12),
        DropdownButtonFormField<String?>(
          initialValue: _termId,
          isExpanded: true,
          decoration: InputDecoration(
            labelText: 'teacher.outcomes.period'.tr(),
            border: const OutlineInputBorder(),
          ),
          items: [
            DropdownMenuItem<String?>(
              child: Text('teacher.outcomes.wholeYear'.tr()),
            ),
            for (final term in data.terms)
              DropdownMenuItem<String?>(
                value: term.termId,
                child: Text(term.name),
              ),
          ],
          onChanged: (termId) => setState(() {
            _termId = termId;
            _edits.clear();
          }),
        ),
        if (notice != null) ...[
          const SizedBox(height: AppSpacing.space12),
          Text(notice, style: theme.textTheme.bodyMedium),
        ],
        const SizedBox(height: AppSpacing.space12),
        if (outcome == null)
          Text('teacher.outcomes.noOutcomes'.tr())
        else ...[
          DropdownButtonFormField<String>(
            key: ValueKey('outcome-${_termId ?? 'year'}'),
            initialValue: outcome.id,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: 'teacher.outcomes.outcome'.tr(),
              border: const OutlineInputBorder(),
            ),
            items: [
              for (final candidate in data.outcomes)
                DropdownMenuItem<String>(
                  value: candidate.id,
                  child: Text(
                    '${candidate.code} · ${candidate.textFor(language)}',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: (id) => setState(() => _outcomeId = id),
          ),
          const SizedBox(height: AppSpacing.space8),
          Text(
            outcome.textFor(language),
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: AppSpacing.space16),
          if (data.students.isEmpty) Text('teacher.outcomes.noStudents'.tr()),
          for (final student in data.students)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space12),
              child: _levelField(data, outcome, student),
            ),
        ],
      ],
    );
  }

  Widget _levelField(
    SectionOutcomeAchievements data,
    OutcomeRef outcome,
    ({String studentId, String name, Map<String, int> levels}) student,
  ) {
    final language = context.locale.languageCode;
    final key = (student.studentId, outcome.id);
    final current = _edits.containsKey(key)
        ? _edits[key]
        : student.levels[outcome.id];
    // A saved level the scale no longer has stays visible rather than crashing the dropdown.
    final levels = [
      ...data.levels,
      if (current != null && !data.levels.any((l) => l.level == current))
        AchievementLevel(level: current, label: '$current'),
    ];
    return DropdownButtonFormField<int?>(
      key: ValueKey('level-${student.studentId}-${outcome.id}-$_termId'),
      initialValue: current,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: student.name,
        border: const OutlineInputBorder(),
      ),
      items: [
        DropdownMenuItem<int?>(child: Text('teacher.outcomes.none'.tr())),
        for (final level in levels)
          DropdownMenuItem<int?>(
            value: level.level,
            child: Text('${level.level} · ${level.labelFor(language)}'),
          ),
      ],
      onChanged: data.editable && !outcome.archived
          ? (value) => setState(() => _edits[key] = value)
          : null,
    );
  }
}
