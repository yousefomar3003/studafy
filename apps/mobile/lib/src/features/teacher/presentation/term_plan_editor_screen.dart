import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_plans_providers.dart';
import '../domain/academic_plans.dart';
import 'widgets/academic_plan_common.dart';
import 'widgets/mark_sheet_common.dart';

/// A term plan (000267): the term, overall notes, and its weeks (unit, notes, outcomes). A new
/// plan or a draft / returned one is edited and saved or submitted; anything else reads only.
class TermPlanEditorScreen extends ConsumerWidget {
  const TermPlanEditorScreen({
    required this.sectionId,
    required this.subjectId,
    this.planId,
    super.key,
  });

  final String sectionId;
  final String subjectId;

  /// Null: a new plan.
  final String? planId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = planId;
    final sheet = ref.watch(
      outcomeAchievementsProvider((
        sectionId: sectionId,
        subjectId: subjectId,
        termId: null,
      )),
    );
    final options = ref.watch(
      lessonPlanOptionsProvider((
        sectionId: sectionId,
        subjectId: subjectId,
        date: null,
      )),
    );
    final plan = id == null ? null : ref.watch(termPlanProvider(id));
    final loading =
        sheet.isLoading || options.isLoading || (plan?.isLoading ?? false);
    final failed =
        sheet.hasError || options.hasError || (plan?.hasError ?? false);
    if (loading || failed) {
      return Scaffold(
        appBar: AppBar(title: Text('teacher.plans.termPlan'.tr())),
        body: failed
            ? MarksMessage(
                icon: Icons.error_outline,
                message: 'teacher.plans.error'.tr(),
                onRetry: () {
                  ref.invalidate(outcomeAchievementsProvider);
                  ref.invalidate(lessonPlanOptionsProvider);
                  if (id != null) ref.invalidate(termPlanProvider(id));
                },
              )
            : const Center(child: CircularProgressIndicator()),
      );
    }
    return _TermPlanForm(
      sectionId: sectionId,
      subjectId: subjectId,
      plan: plan?.value,
      terms: sheet.value?.terms ?? const [],
      outcomes: options.value?.outcomes ?? const [],
    );
  }
}

class _WeekDraft {
  _WeekDraft(
    this.weekNumber, {
    String? unit,
    String? notes,
    this.outcomes = const [],
  }) : unit = TextEditingController(text: unit ?? ''),
       notes = TextEditingController(text: notes ?? '');

  int weekNumber;
  final TextEditingController unit;
  final TextEditingController notes;
  List<OutcomeRef> outcomes;

  TermPlanWeek toWeek() => TermPlanWeek(
    weekNumber: weekNumber,
    unit: unit.text.trim().isEmpty ? null : unit.text.trim(),
    notes: notes.text.trim().isEmpty ? null : notes.text.trim(),
    outcomes: outcomes,
  );

  void dispose() {
    unit.dispose();
    notes.dispose();
  }
}

class _TermPlanForm extends ConsumerStatefulWidget {
  const _TermPlanForm({
    required this.sectionId,
    required this.subjectId,
    required this.plan,
    required this.terms,
    required this.outcomes,
  });

  final String sectionId;
  final String subjectId;
  final TermPlan? plan;
  final List<({String termId, String name})> terms;
  final List<OutcomeRef> outcomes;

  @override
  ConsumerState<_TermPlanForm> createState() => _TermPlanFormState();
}

class _TermPlanFormState extends ConsumerState<_TermPlanForm> {
  late String? _termId = widget.plan?.header.termId;
  late final TextEditingController _notes = TextEditingController(
    text: widget.plan?.notes ?? '',
  );
  late final List<_WeekDraft> _weeks = [
    for (final week in widget.plan?.weeks ?? const <TermPlanWeek>[])
      _WeekDraft(
        week.weekNumber,
        unit: week.unit,
        notes: week.notes,
        outcomes: week.outcomes,
      ),
  ];
  bool _busy = false;

  bool get _editable => widget.plan == null || widget.plan!.header.canEdit;

  @override
  void dispose() {
    _notes.dispose();
    for (final week in _weeks) {
      week.dispose();
    }
    super.dispose();
  }

  void _refreshLists() => ref.invalidate(
    sectionPlansProvider((
      kind: PlanKind.term,
      sectionId: widget.sectionId,
      subjectId: widget.subjectId,
    )),
  );

  Future<TermPlan> _save(String termId) async {
    final saved = await ref
        .read(academicPlansClientProvider)
        .saveTermPlan(
          sectionId: widget.sectionId,
          subjectId: widget.subjectId,
          planId: widget.plan?.header.id,
          termId: termId,
          notes: _notes.text.trim().isEmpty ? null : _notes.text.trim(),
          weeks: [for (final week in _weeks) week.toWeek()],
        );
    ref.invalidate(termPlanProvider(saved.header.id));
    _refreshLists();
    return saved;
  }

  Future<void> _run(Future<void> Function() action, String doneKey) async {
    if (widget.plan == null && _termId == null) {
      _snack('teacher.plans.pickTerm'.tr());
      return;
    }
    setState(() => _busy = true);
    try {
      await action();
      if (!mounted) return;
      _snack(doneKey.tr());
      Navigator.of(context).pop();
    } catch (error) {
      _snack(planErrorMessage(error));
    } finally {
      if (mounted) setState(() => _busy = false);
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
    final plan = widget.plan;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('teacher.plans.termPlan'.tr()),
        actions: [
          if (plan?.header.canDelete ?? false)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'teacher.plans.delete'.tr(),
              onPressed: _busy
                  ? null
                  : () => _run(() async {
                      await ref
                          .read(academicPlansClientProvider)
                          .delete(PlanKind.term, plan!.header.id);
                      _refreshLists();
                    }, 'teacher.plans.deleted'),
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(
          AppSpacing.space16,
        ).withBottomInset(context),
        children: [
          if (plan != null) ...[
            Row(
              children: [
                PlanStatusPill(status: plan.header.status),
                if (plan.header.onTime == false) ...[
                  const SizedBox(width: AppSpacing.space8),
                  Text('teacher.plans.late'.tr()),
                ],
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            ReviewCommentBanner(header: plan.header),
          ],
          DropdownButtonFormField<String>(
            initialValue: _termId,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: 'teacher.plans.term'.tr(),
              border: const OutlineInputBorder(),
            ),
            items: [
              for (final term in widget.terms)
                DropdownMenuItem(value: term.termId, child: Text(term.name)),
              // A plan's term the list does not have (an older server) still shows.
              if (_termId case final termId?
                  when !widget.terms.any((term) => term.termId == termId))
                DropdownMenuItem(
                  value: termId,
                  child: Text(plan?.header.termName ?? ''),
                ),
            ],
            // The term is fixed once the plan exists.
            onChanged: plan == null
                ? (value) => setState(() => _termId = value)
                : null,
          ),
          const SizedBox(height: AppSpacing.space12),
          TextField(
            controller: _notes,
            enabled: _editable,
            maxLines: null,
            minLines: 2,
            maxLength: 5000,
            decoration: InputDecoration(
              labelText: 'teacher.plans.notes'.tr(),
              border: const OutlineInputBorder(),
            ),
          ),
          for (final week in _weeks) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    'teacher.plans.week'.tr(
                      namedArgs: {'n': '${week.weekNumber}'},
                    ),
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                if (_editable)
                  IconButton(
                    icon: const Icon(Icons.close),
                    tooltip: 'teacher.plans.removeWeek'.tr(
                      namedArgs: {'n': '${week.weekNumber}'},
                    ),
                    onPressed: () => setState(() {
                      _weeks.remove(week);
                      week.dispose();
                    }),
                  ),
              ],
            ),
            TextField(
              controller: week.unit,
              enabled: _editable,
              maxLength: 200,
              decoration: InputDecoration(
                labelText: 'teacher.plans.unit'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AppSpacing.space8),
            TextField(
              controller: week.notes,
              enabled: _editable,
              maxLines: null,
              maxLength: 2000,
              decoration: InputDecoration(
                labelText: 'teacher.plans.weekNotes'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            Text(
              'teacher.plans.outcomes'.tr(),
              style: theme.textTheme.labelLarge,
            ),
            const SizedBox(height: AppSpacing.space4),
            OutcomePicker(
              available: widget.outcomes,
              selected: week.outcomes,
              enabled: _editable,
              onChanged: (value) => setState(() => week.outcomes = value),
            ),
            const SizedBox(height: AppSpacing.space16),
          ],
          if (_editable && _weeks.length < 60)
            OutlinedButton.icon(
              icon: const Icon(Icons.add),
              label: Text('teacher.plans.addWeek'.tr()),
              onPressed: () => setState(() {
                final next = _weeks.isEmpty
                    ? 1
                    : _weeks
                              .map((week) => week.weekNumber)
                              .reduce((a, b) => a > b ? a : b) +
                          1;
                _weeks.add(_WeekDraft(next));
              }),
            ),
          if (_editable) ...[
            const SizedBox(height: AppSpacing.space24),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                            await _save(_termId!);
                          }, 'teacher.plans.saved'),
                    child: Text('teacher.plans.saveDraft'.tr()),
                  ),
                ),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: FilledButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                            final saved = await _save(_termId!);
                            await ref
                                .read(academicPlansClientProvider)
                                .submit(PlanKind.term, saved.header.id);
                            ref.invalidate(termPlanProvider(saved.header.id));
                            _refreshLists();
                          }, 'teacher.plans.submitted'),
                    child: Text('teacher.plans.submit'.tr()),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
