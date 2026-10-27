import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/theme/app_semantic_colors.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/status_pill.dart';
import '../application/mark_sheet_providers.dart';
import '../domain/mark_sheet.dart';
import 'assessment_marks_screen.dart';
import 'widgets/add_mark_assessment_sheet.dart';
import 'widgets/mark_sheet_common.dart';

/// One section + subject's mark sheet, one period (a term, or the annual period) at a time.
///
/// Shows the period's approval state (with the reviewer's reason when it was returned, and a
/// read-only notice once it is submitted or approved), the subject's grading rules, the period's
/// assessments grouped by category with how many marks are recorded or missing, and every
/// student's live result preview — a provisional percentage is always labelled as provisional and
/// never shown as a grade. Opening an assessment pushes [AssessmentMarksScreen] to enter marks;
/// "Submit for approval" sends the period to the reviewer.
class MarkSheetScreen extends ConsumerStatefulWidget {
  const MarkSheetScreen({
    required this.sectionId,
    required this.subjectId,
    required this.title,
    super.key,
  });

  final String sectionId;
  final String subjectId;

  /// Shown in the app bar before the sheet loads (the subject name from the list).
  final String title;

  @override
  ConsumerState<MarkSheetScreen> createState() => _MarkSheetScreenState();
}

class _MarkSheetScreenState extends ConsumerState<MarkSheetScreen> {
  /// The selected period. Only meaningful once [_periodChosen]; null is the annual period.
  String? _termId;
  bool _periodChosen = false;
  bool _submitting = false;

  MarkSheetKey get _key =>
      (sectionId: widget.sectionId, subjectId: widget.subjectId);

  @override
  Widget build(BuildContext context) {
    final sheetAsync = ref.watch(markSheetProvider(_key));
    final sheet = sheetAsync.value;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(sheet?.subjectName ?? widget.title),
            if (sheet != null)
              Text(
                'teacher.marks.list.sectionLine'.tr(
                  namedArgs: {
                    'grade': sheet.gradeLevelName,
                    'section': sheet.sectionName,
                  },
                ),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
      ),
      body: sheetAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.marks.sheet.error'.tr(),
          onRetry: () => ref.invalidate(markSheetProvider(_key)),
        ),
        data: _buildSheet,
      ),
    );
  }

  String? _resolvePeriod(MarkSheet sheet) {
    if (_periodChosen && sheet.periods.any((p) => p.termId == _termId)) {
      return _termId;
    }
    for (final period in sheet.periods) {
      if (period.status.isOpen) return period.termId;
    }
    return sheet.periods.first.termId;
  }

  Widget _buildSheet(MarkSheet sheet) {
    if (sheet.periods.isEmpty) {
      return MarksMessage(
        icon: Icons.assignment_outlined,
        message: 'teacher.marks.sheet.noPeriods'.tr(),
      );
    }
    final termId = _resolvePeriod(sheet);
    final period = sheet.periodFor(termId)!;
    final groups = sheet.assessmentGroupsFor(termId);
    final editable = sheet.isPeriodEditable(termId);

    return Column(
      children: [
        _PeriodSelector(
          sheet: sheet,
          selected: termId,
          onSelect: (id) => setState(() {
            _termId = id;
            _periodChosen = true;
          }),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _reload,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(
                AppSpacing.space16,
              ).withBottomInset(context),
              children: [
                _PeriodStatusCard(
                  sheet: sheet,
                  period: period,
                  submitting: _submitting,
                  onSubmit: groups.isEmpty
                      ? null
                      : () => _submit(sheet, termId),
                ),
                const SizedBox(height: AppSpacing.space12),
                _RulesCard(sheet: sheet),
                const SizedBox(height: AppSpacing.space16),
                _SectionHeader(
                  title: 'teacher.marks.sheet.assessments'.tr(),
                  action: sheet.canAddAssessments && editable
                      ? TextButton.icon(
                          onPressed: () => _addAssessment(sheet, termId),
                          icon: const Icon(Icons.add),
                          label: Text('teacher.marks.sheet.addAssessment'.tr()),
                        )
                      : null,
                ),
                if (groups.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      vertical: AppSpacing.space8,
                    ),
                    child: Text(
                      'teacher.marks.sheet.noAssessmentsInPeriod'.tr(),
                    ),
                  ),
                for (final group in groups) ...[
                  _CategoryHeader(category: group.category),
                  for (final assessment in group.assessments)
                    _AssessmentTile(
                      sheet: sheet,
                      assessment: assessment,
                      onOpen: () => _openAssessment(assessment),
                    ),
                ],
                const SizedBox(height: AppSpacing.space16),
                _SectionHeader(title: 'teacher.marks.sheet.students'.tr()),
                for (final student in sheet.students)
                  _StudentTile(
                    sheet: sheet,
                    student: student,
                    termId: termId,
                    onTap: () => _showStudent(sheet, student, termId),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _reload() async {
    try {
      await ref.read(markSheetProvider(_key).notifier).reload();
    } catch (error) {
      _snack(markErrorMessage(error));
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _openAssessment(MarkSheetAssessment assessment) {
    if (!assessment.isActive) {
      _snack('teacher.marks.sheet.proposedHint'.tr());
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            AssessmentMarksScreen(sheetKey: _key, assessmentId: assessment.id),
      ),
    );
  }

  Future<void> _addAssessment(MarkSheet sheet, String? termId) async {
    final status = await AddMarkAssessmentSheet.show(
      context,
      sheet: sheet,
      termId: termId,
    );
    if (status == null || !mounted) return;
    _snack(
      status == 'proposed'
          ? 'teacher.marks.addAssessment.proposed'.tr()
          : 'teacher.marks.addAssessment.added'.tr(),
    );
    await _reload();
  }

  Future<void> _submit(MarkSheet sheet, String? termId) async {
    final missing = sheet.studentsMissingMarks(termId);
    if (missing.isNotEmpty) {
      await _showIncomplete(sheet, termId, missing);
      return;
    }
    final periodLabel = markPeriodLabel(sheet, termId);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          'teacher.marks.submit.title'.tr(namedArgs: {'period': periodLabel}),
        ),
        content: Text('teacher.marks.submit.body'.tr()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(
              MaterialLocalizations.of(dialogContext).cancelButtonLabel,
            ),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('teacher.marks.submit.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _submitting = true);
    MarkSheetPeriodStatus? status;
    DioException? failure;
    try {
      status = await ref
          .read(markSheetClientProvider)
          .submitPeriod(widget.sectionId, widget.subjectId, termId: termId);
    } on DioException catch (error) {
      failure = error;
    }
    if (!mounted) return;
    setState(() => _submitting = false);
    // Re-read either way: the period's status (or its missing marks) changed server-side.
    await _reload();
    if (!mounted) return;

    if (failure == null) {
      _snack(
        status == MarkSheetPeriodStatus.approved
            ? 'teacher.marks.submit.approved'.tr()
            : 'teacher.marks.submit.success'.tr(),
      );
    } else if (failure.apiError?.code == 'RESULTS_INCOMPLETE') {
      final fresh = ref.read(markSheetProvider(_key)).value ?? sheet;
      await _showIncomplete(
        fresh,
        termId,
        fresh.studentsMissingMarks(termId),
        serverDetail: failure.apiError?.detail,
      );
    } else {
      _snack(markErrorMessage(failure));
    }
  }

  /// Lists who is missing which marks. The API's 409 `RESULTS_INCOMPLETE` names them only in its
  /// prose `detail`, so the list comes from the sheet's own previews; [serverDetail] is the
  /// fallback when the local sheet disagrees (e.g. it was stale).
  Future<void> _showIncomplete(
    MarkSheet sheet,
    String? termId,
    List<MarkSheetStudent> missing, {
    String? serverDetail,
  }) {
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.marks.submit.incompleteTitle'.tr()),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('teacher.marks.submit.incompleteBody'.tr()),
              const SizedBox(height: AppSpacing.space12),
              if (missing.isEmpty && serverDetail != null) Text(serverDetail),
              for (final student in missing)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        student.displayName,
                        style: Theme.of(dialogContext).textTheme.titleSmall,
                      ),
                      Text(
                        sheet
                            .missingFor(student, termId)
                            .map((a) => a.name)
                            .join(
                              context.locale.languageCode == 'ar' ? '، ' : ', ',
                            ),
                        style: Theme.of(dialogContext).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text('teacher.marks.submit.ok'.tr()),
          ),
        ],
      ),
    );
  }

  Future<void> _showStudent(
    MarkSheet sheet,
    MarkSheetStudent student,
    String? termId,
  ) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) =>
          _StudentMarksSheet(sheet: sheet, student: student, termId: termId),
    );
  }
}

// ---------------------------------------------------------------------------
// Period selector + status
// ---------------------------------------------------------------------------

class _PeriodSelector extends StatelessWidget {
  const _PeriodSelector({
    required this.sheet,
    required this.selected,
    required this.onSelect,
  });

  final MarkSheet sheet;
  final String? selected;
  final ValueChanged<String?> onSelect;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space8,
        AppSpacing.space16,
        AppSpacing.space4,
      ),
      child: Row(
        children: [
          for (final period in sheet.periods)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: AppSpacing.space8),
              child: ChoiceChip(
                label: Text(markPeriodLabel(sheet, period.termId)),
                avatar: _statusIcon(context, period.status),
                selected: period.termId == selected,
                onSelected: (_) => onSelect(period.termId),
              ),
            ),
        ],
      ),
    );
  }

  static Widget? _statusIcon(
    BuildContext context,
    MarkSheetPeriodStatus status,
  ) {
    final colorScheme = Theme.of(context).colorScheme;
    return switch (status) {
      MarkSheetPeriodStatus.draft => null,
      MarkSheetPeriodStatus.returned => Icon(
        Icons.reply,
        size: 16,
        color: colorScheme.error,
      ),
      MarkSheetPeriodStatus.submitted => const Icon(
        Icons.hourglass_top,
        size: 16,
      ),
      MarkSheetPeriodStatus.approved => Icon(
        Icons.check_circle_outline,
        size: 16,
        color: colorScheme.primary,
      ),
      MarkSheetPeriodStatus.unknown => const Icon(Icons.lock_outline, size: 16),
    };
  }
}

class _PeriodStatusCard extends StatelessWidget {
  const _PeriodStatusCard({
    required this.sheet,
    required this.period,
    required this.submitting,
    required this.onSubmit,
  });

  final MarkSheet sheet;
  final MarkSheetPeriod period;
  final bool submitting;
  final VoidCallback? onSubmit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final locale = context.locale.toString();
    final editable = sheet.isPeriodEditable(period.termId);
    final missing = sheet.studentsMissingMarks(period.termId).length;
    final hasAssessments = sheet.assessmentsFor(period.termId).isNotEmpty;

    String? lockMessage;
    if (!sheet.canEditMarks) {
      lockMessage = 'teacher.marks.sheet.yearNotActive'.tr();
    } else if (period.status.isLocked) {
      lockMessage = switch (period.status) {
        MarkSheetPeriodStatus.submitted =>
          'teacher.marks.sheet.lockedSubmitted'.tr(),
        MarkSheetPeriodStatus.approved =>
          'teacher.marks.sheet.lockedApproved'.tr(),
        _ => 'teacher.marks.sheet.lockedUnknown'.tr(),
      };
    }

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    markPeriodLabel(sheet, period.termId),
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                MarkPeriodStatusPill(status: period.status),
              ],
            ),
            if (period.submittedAt != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'teacher.marks.sheet.submittedOn'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(
                      locale,
                    ).format(period.submittedAt!.toLocal()),
                  },
                ),
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (period.decidedAt != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(
                'teacher.marks.sheet.decidedOn'.tr(
                  namedArgs: {
                    'date': DateFormat.yMMMd(
                      locale,
                    ).format(period.decidedAt!.toLocal()),
                  },
                ),
                style: theme.textTheme.bodySmall,
              ),
            ],
            if (period.status == MarkSheetPeriodStatus.returned) ...[
              const SizedBox(height: AppSpacing.space12),
              _Notice(
                icon: Icons.reply,
                tone: StatusPillTone.danger,
                message: (period.returnReason?.trim().isNotEmpty ?? false)
                    ? 'teacher.marks.sheet.returned'.tr(
                        namedArgs: {'reason': period.returnReason!.trim()},
                      )
                    : 'teacher.marks.sheet.returnedNoReason'.tr(),
              ),
            ],
            if (lockMessage != null) ...[
              const SizedBox(height: AppSpacing.space12),
              _Notice(
                icon: Icons.lock_outline,
                tone: StatusPillTone.neutral,
                message: lockMessage,
              ),
            ],
            if (editable && hasAssessments) ...[
              const SizedBox(height: AppSpacing.space12),
              Row(
                children: [
                  Icon(
                    missing > 0
                        ? Icons.error_outline
                        : Icons.check_circle_outline,
                    size: 18,
                    color: missing > 0
                        ? theme.colorScheme.error
                        : theme.colorScheme.primary,
                  ),
                  const SizedBox(width: AppSpacing.space8),
                  Expanded(
                    child: Text(
                      missing > 0
                          ? 'teacher.marks.sheet.missingSummary'.tr(
                              namedArgs: {'count': '$missing'},
                            )
                          : 'teacher.marks.sheet.allComplete'.tr(),
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.space12),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: submitting ? null : onSubmit,
                  icon: submitting
                      ? const SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.send_outlined),
                  label: Text('teacher.marks.sheet.submit'.tr()),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A tinted, icon-led notice box.
class _Notice extends StatelessWidget {
  const _Notice({
    required this.icon,
    required this.tone,
    required this.message,
  });

  final IconData icon;
  final StatusPillTone tone;
  final String message;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final semantic = Theme.of(context).extension<AppSemanticColors>()!;
    final (background, foreground) = switch (tone) {
      StatusPillTone.danger => (
        colorScheme.errorContainer,
        colorScheme.onErrorContainer,
      ),
      StatusPillTone.warning => (
        semantic.warningContainer,
        semantic.onWarningContainer,
      ),
      StatusPillTone.success => (
        colorScheme.primaryContainer,
        colorScheme.onPrimaryContainer,
      ),
      StatusPillTone.neutral => (
        colorScheme.surfaceContainerHighest,
        colorScheme.onSurfaceVariant,
      ),
    };
    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: AppRadius.mdRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: foreground),
            const SizedBox(width: AppSpacing.space8),
            Expanded(
              child: Text(
                message,
                style: Theme.of(
                  context,
                ).textTheme.bodyMedium?.copyWith(color: foreground),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Grading rules
// ---------------------------------------------------------------------------

class _RulesCard extends StatelessWidget {
  const _RulesCard({required this.sheet});

  final MarkSheet sheet;

  @override
  Widget build(BuildContext context) {
    final config = sheet.config;
    final theme = Theme.of(context);
    String percent(double value) => 'teacher.marks.rules.percentValue'.tr(
      namedArgs: {'value': formatMarkNumber(value)},
    );

    return Card(
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        leading: const Icon(Icons.rule_outlined),
        title: Text('teacher.marks.rules.title'.tr()),
        subtitle: Text(
          '${'teacher.marks.rules.maxMarks'.tr()}: '
          '${formatMarkNumber(config.maxMarks)} · '
          '${'teacher.marks.rules.passMark'.tr()}: '
          '${percent(config.passPercentage)}',
          style: theme.textTheme.bodySmall,
        ),
        childrenPadding: const EdgeInsets.fromLTRB(
          AppSpacing.space16,
          0,
          AppSpacing.space16,
          AppSpacing.space16,
        ),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _RuleRow(
            label: 'teacher.marks.rules.method'.tr(),
            value: config.gradingMethod == 'total_points'
                ? 'teacher.marks.rules.methodTotal'.tr()
                : 'teacher.marks.rules.methodWeighted'.tr(),
          ),
          _RuleRow(
            label: 'teacher.marks.rules.maxMarks'.tr(),
            value: formatMarkNumber(config.maxMarks),
          ),
          _RuleRow(
            label: 'teacher.marks.rules.passMark'.tr(),
            value: percent(config.passPercentage),
          ),
          if (config.finalExamPassPercentage != null)
            _RuleRow(
              label: 'teacher.marks.rules.finalExamPass'.tr(),
              value: percent(config.finalExamPassPercentage!),
            ),
          _RuleRow(
            label: 'teacher.marks.rules.rounding'.tr(),
            value: '${config.roundingDecimals}',
          ),
          _RuleRow(
            label: 'teacher.marks.rules.missingPolicy'.tr(),
            value: _policy(config.missingMarkPolicy),
          ),
          _RuleRow(
            label: 'teacher.marks.rules.absentPolicy'.tr(),
            value: _policy(config.absentPolicy),
          ),
          _RuleRow(
            label: 'teacher.marks.rules.retakePolicy'.tr(),
            value: _retake(config.retakePolicy),
          ),
          if (sheet.terms.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'teacher.marks.rules.termWeights'.tr(),
              style: theme.textTheme.titleSmall,
            ),
            for (final term in sheet.terms)
              _RuleRow(label: term.name, value: percent(term.weight)),
          ],
          if (sheet.categories.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'teacher.marks.rules.categoryWeights'.tr(),
              style: theme.textTheme.titleSmall,
            ),
            for (final category in sheet.categories)
              _RuleRow(
                label: category.name,
                value: category.weight == null
                    ? 'teacher.marks.rules.noWeight'.tr()
                    : percent(category.weight!),
              ),
          ],
          if (!config.weightsValid) ...[
            const SizedBox(height: AppSpacing.space8),
            _Notice(
              icon: Icons.warning_amber_outlined,
              tone: StatusPillTone.warning,
              message: 'teacher.marks.rules.weightsInvalid'.tr(),
            ),
          ],
          if (config.instructions?.trim().isNotEmpty ?? false) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'teacher.marks.rules.instructions'.tr(),
              style: theme.textTheme.titleSmall,
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(config.instructions!.trim()),
          ],
        ],
      ),
    );
  }

  static String _policy(String value) => switch (value) {
    'incomplete' => 'teacher.marks.rules.policyIncomplete'.tr(),
    'zero' => 'teacher.marks.rules.policyZero'.tr(),
    _ => value,
  };

  static String _retake(String value) => switch (value) {
    'none' => 'teacher.marks.rules.retakeNone'.tr(),
    'replace' => 'teacher.marks.rules.retakeReplace'.tr(),
    'highest' => 'teacher.marks.rules.retakeHighest'.tr(),
    'capped' => 'teacher.marks.rules.retakeCapped'.tr(),
    _ => value,
  };
}

class _RuleRow extends StatelessWidget {
  const _RuleRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.space12),
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, this.action});

  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Row(
        children: [
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.titleMedium),
          ),
          ?action,
        ],
      ),
    );
  }
}

class _CategoryHeader extends StatelessWidget {
  const _CategoryHeader({required this.category});

  final MarkSheetCategory? category;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final name = category?.name ?? 'teacher.marks.sheet.uncategorized'.tr();
    final weight = category?.weight;
    return Padding(
      padding: const EdgeInsets.only(
        top: AppSpacing.space8,
        bottom: AppSpacing.space4,
      ),
      child: Text(
        weight == null
            ? name
            : 'teacher.marks.sheet.categoryWeight'.tr(
                namedArgs: {'name': name, 'weight': formatMarkNumber(weight)},
              ),
        style: theme.textTheme.labelLarge?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _AssessmentTile extends StatelessWidget {
  const _AssessmentTile({
    required this.sheet,
    required this.assessment,
    required this.onOpen,
  });

  final MarkSheet sheet;
  final MarkSheetAssessment assessment;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final recorded = sheet.recordedCount(assessment);
    final missing = sheet.students
        .where(
          (s) =>
              !s.isExempt &&
              (s.preview?.missingAssessmentIds.contains(assessment.id) ??
                  false),
        )
        .length;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: ListTile(
        title: Text(assessment.name),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'teacher.marks.sheet.assessmentMeta'.tr(
                namedArgs: {
                  'max': formatMarkNumber(assessment.maxMarks),
                  'weight': formatMarkNumber(assessment.weight),
                },
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
            Wrap(
              spacing: AppSpacing.space8,
              runSpacing: AppSpacing.space4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (assessment.isActive)
                  Text(
                    'teacher.marks.sheet.recorded'.tr(
                      namedArgs: {
                        'count': '$recorded',
                        'total': '${sheet.enrolledCount}',
                      },
                    ),
                    style: theme.textTheme.bodySmall,
                  ),
                if (missing > 0)
                  StatusPill(
                    label: 'teacher.marks.sheet.missingCount'.tr(
                      namedArgs: {'count': '$missing'},
                    ),
                    tone: StatusPillTone.danger,
                  ),
                if (!assessment.isMandatory)
                  StatusPill(
                    label: 'teacher.marks.sheet.optional'.tr(),
                    tone: StatusPillTone.neutral,
                  ),
                if (assessment.isProposed)
                  StatusPill(
                    label: 'teacher.marks.sheet.proposed'.tr(),
                    tone: StatusPillTone.warning,
                  )
                else if (!assessment.isActive)
                  StatusPill(
                    label: 'teacher.marks.sheet.rejected'.tr(),
                    tone: StatusPillTone.danger,
                  ),
              ],
            ),
          ],
        ),
        trailing: assessment.isActive ? const Icon(Icons.chevron_right) : null,
        onTap: onOpen,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

class _StudentTile extends StatelessWidget {
  const _StudentTile({
    required this.sheet,
    required this.student,
    required this.termId,
    required this.onTap,
  });

  final MarkSheet sheet;
  final MarkSheetStudent student;
  final String? termId;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final missing = sheet.missingFor(student, termId).length;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: ListTile(
        title: Text(student.displayName),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (student.admissionNumber.isNotEmpty)
              Text(student.admissionNumber),
            if (missing > 0)
              Text(
                'teacher.marks.preview.missingInPeriod'.tr(
                  namedArgs: {'count': '$missing'},
                ),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                  fontWeight: FontWeight.w600,
                ),
              ),
          ],
        ),
        trailing: MarkPreviewBadge(student: student),
        onTap: onTap,
      ),
    );
  }
}

/// A student's live result. Complete: the percentage, grade label and pass/fail. Incomplete: the
/// provisional percentage, always worded as provisional, with an "Incomplete" pill — never a
/// grade label. Exempt: an "Exempt" pill.
class MarkPreviewBadge extends StatelessWidget {
  const MarkPreviewBadge({required this.student, super.key});

  final MarkSheetStudent student;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (student.isExempt) {
      return StatusPill(
        label: 'teacher.marks.preview.exempt'.tr(),
        tone: StatusPillTone.neutral,
      );
    }
    final preview = student.preview;
    if (preview == null) return const SizedBox.shrink();

    if (preview.isComplete && preview.percentage != null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            [
              '${formatMarkNumber(preview.percentage!)}%',
              ?preview.gradeLabel,
            ].join(' · '),
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w700,
            ),
          ),
          if (preview.passed != null) ...[
            const SizedBox(height: AppSpacing.space4),
            StatusPill(
              label: preview.passed!
                  ? 'teacher.marks.preview.passed'.tr()
                  : 'teacher.marks.preview.failed'.tr(),
              tone: preview.passed!
                  ? StatusPillTone.success
                  : StatusPillTone.danger,
            ),
          ],
        ],
      );
    }

    final provisional = preview.provisionalPercentage;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          provisional == null
              ? 'teacher.marks.preview.noMarks'.tr()
              : 'teacher.marks.preview.provisional'.tr(
                  namedArgs: {'percentage': formatMarkNumber(provisional)},
                ),
          style: theme.textTheme.bodySmall?.copyWith(
            fontStyle: FontStyle.italic,
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: AppSpacing.space4),
        StatusPill(
          label: 'teacher.marks.preview.incomplete'.tr(),
          tone: StatusPillTone.warning,
        ),
      ],
    );
  }
}

class _StudentMarksSheet extends StatelessWidget {
  const _StudentMarksSheet({
    required this.sheet,
    required this.student,
    required this.termId,
  });

  final MarkSheet sheet;
  final MarkSheetStudent student;
  final String? termId;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final preview = student.preview;
    final missing = sheet.missingFor(student, termId).map((a) => a.id).toSet();

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space16,
            0,
            AppSpacing.space16,
            AppSpacing.space24,
          ),
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    student.displayName,
                    style: theme.textTheme.titleLarge,
                  ),
                ),
                MarkPreviewBadge(student: student),
              ],
            ),
            if (student.isExempt) ...[
              const SizedBox(height: AppSpacing.space8),
              Text('teacher.marks.entry.exempt'.tr()),
            ] else ...[
              if (preview != null && !preview.isComplete) ...[
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'teacher.marks.preview.provisionalHint'.tr(),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.space16),
              Text(
                'teacher.marks.student.periodMarks'.tr(),
                style: theme.textTheme.titleSmall,
              ),
              const SizedBox(height: AppSpacing.space8),
              for (final assessment in sheet.assessmentsFor(termId))
                _RuleRow(
                  label: assessment.name,
                  value: _markText(assessment, missing.contains(assessment.id)),
                ),
              if (preview != null && preview.termPercentages.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.space16),
                Text(
                  'teacher.marks.student.byTerm'.tr(),
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: AppSpacing.space8),
                for (final term in preview.termPercentages)
                  _RuleRow(
                    label: markPeriodLabel(sheet, term.termId),
                    value: term.percentage == null
                        ? 'teacher.marks.rules.noWeight'.tr()
                        : term.incomplete
                        ? 'teacher.marks.preview.provisional'.tr(
                            namedArgs: {
                              'percentage': formatMarkNumber(term.percentage!),
                            },
                          )
                        : '${formatMarkNumber(term.percentage!)}%',
                  ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  String _markText(MarkSheetAssessment assessment, bool isMissing) {
    String one(RecordedMark mark) => switch (mark.status) {
      MarkStatus.graded =>
        '${formatMarkNumber(mark.score ?? 0)} / ${formatMarkNumber(assessment.maxMarks)}',
      MarkStatus.absent => 'teacher.marks.entry.markStatus.absent'.tr(),
      MarkStatus.excused => 'teacher.marks.entry.markStatus.excused'.tr(),
      MarkStatus.notApplicable =>
        'teacher.marks.entry.markStatus.notApplicable'.tr(),
    };
    final first = student.markFor(assessment.id);
    final retake = student.markFor(assessment.id, attempt: 2);
    if (first == null && retake == null) {
      return isMissing
          ? 'teacher.marks.entry.missing'.tr()
          : 'teacher.marks.student.notRecorded'.tr();
    }
    return [
      if (first != null) one(first),
      if (retake != null)
        '${'teacher.marks.entry.retake'.tr()}: ${one(retake)}',
    ].join('\n');
  }
}
