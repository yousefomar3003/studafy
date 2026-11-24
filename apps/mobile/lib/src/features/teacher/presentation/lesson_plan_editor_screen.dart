import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_plans_providers.dart';
import '../domain/academic_plans.dart';
import 'widgets/academic_plan_common.dart';
import 'widgets/mark_sheet_common.dart';

/// A daily lesson plan (000268): date and timetable period, title, objectives, outcomes,
/// activities, resources and the class's uploaded materials, homework, and the reflection written
/// after teaching it. A new plan or a draft / returned one is edited and saved or submitted; the
/// reflection can be written in any status.
class LessonPlanEditorScreen extends ConsumerWidget {
  const LessonPlanEditorScreen({
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
    if (id == null) {
      return _LessonPlanForm(
        sectionId: sectionId,
        subjectId: subjectId,
        plan: null,
      );
    }
    final plan = ref.watch(lessonPlanProvider(id));
    return plan.when(
      loading: () => Scaffold(
        appBar: AppBar(title: Text('teacher.plans.lessonPlan'.tr())),
        body: const Center(child: CircularProgressIndicator()),
      ),
      error: (_, _) => Scaffold(
        appBar: AppBar(title: Text('teacher.plans.lessonPlan'.tr())),
        body: MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.plans.error'.tr(),
          onRetry: () => ref.invalidate(lessonPlanProvider(id)),
        ),
      ),
      data: (plan) => _LessonPlanForm(
        key: ValueKey(plan.header.id),
        sectionId: sectionId,
        subjectId: subjectId,
        plan: plan,
      ),
    );
  }
}

class _LessonPlanForm extends ConsumerStatefulWidget {
  const _LessonPlanForm({
    required this.sectionId,
    required this.subjectId,
    required this.plan,
    super.key,
  });

  final String sectionId;
  final String subjectId;
  final LessonPlan? plan;

  @override
  ConsumerState<_LessonPlanForm> createState() => _LessonPlanFormState();
}

class _LessonPlanFormState extends ConsumerState<_LessonPlanForm> {
  late DateTime _date =
      widget.plan?.lessonDate ?? DateUtils.dateOnly(DateTime.now());
  late int? _period = widget.plan?.period;
  late final _title = TextEditingController(text: widget.plan?.title ?? '');
  late final _objectives = TextEditingController(
    text: widget.plan?.objectives ?? '',
  );
  late final _activities = TextEditingController(
    text: widget.plan?.activities ?? '',
  );
  late final _resources = TextEditingController(
    text: widget.plan?.resources ?? '',
  );
  late final _homework = TextEditingController(
    text: widget.plan?.homework ?? '',
  );
  late final _reflection = TextEditingController(
    text: widget.plan?.reflection ?? '',
  );
  late List<OutcomeRef> _outcomes = widget.plan?.outcomes ?? const [];
  late Set<String> _materialIds = {
    for (final material in widget.plan?.materials ?? const []) material.id,
  };
  bool _busy = false;

  bool get _editable => widget.plan == null || widget.plan!.header.canEdit;

  String get _wireDate =>
      '${_date.year.toString().padLeft(4, '0')}-'
      '${_date.month.toString().padLeft(2, '0')}-'
      '${_date.day.toString().padLeft(2, '0')}';

  @override
  void dispose() {
    for (final controller in [
      _title,
      _objectives,
      _activities,
      _resources,
      _homework,
      _reflection,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  String? _clean(TextEditingController controller) {
    final text = controller.text.trim();
    return text.isEmpty ? null : text;
  }

  void _refreshLists() => ref.invalidate(
    sectionPlansProvider((
      kind: PlanKind.lesson,
      sectionId: widget.sectionId,
      subjectId: widget.subjectId,
    )),
  );

  Future<LessonPlan> _save() async {
    final saved = await ref
        .read(academicPlansClientProvider)
        .saveLessonPlan(
          sectionId: widget.sectionId,
          subjectId: widget.subjectId,
          planId: widget.plan?.header.id,
          body: {
            'lesson_date': _wireDate,
            'period': _period,
            'title': _title.text.trim(),
            'objectives': _clean(_objectives),
            'activities': _clean(_activities),
            'resources': _clean(_resources),
            'homework': _clean(_homework),
            'outcome_ids': [for (final outcome in _outcomes) outcome.id],
            'material_ids': _materialIds.toList(),
          },
        );
    ref.invalidate(lessonPlanProvider(saved.header.id));
    _refreshLists();
    return saved;
  }

  Future<void> _run(
    Future<void> Function() action,
    String doneKey, {
    bool close = true,
  }) async {
    if (_editable && _title.text.trim().isEmpty) {
      _snack('teacher.plans.titleRequired'.tr());
      return;
    }
    setState(() => _busy = true);
    try {
      await action();
      if (!mounted) return;
      _snack(doneKey.tr());
      if (close) Navigator.of(context).pop();
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

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(_date.year - 1),
      lastDate: DateTime(_date.year + 1, 12, 31),
    );
    if (picked != null) {
      setState(() {
        _date = picked;
        _period = null;
      });
    }
  }

  Widget _field(
    TextEditingController controller,
    String labelKey, {
    int maxLength = 2000,
    bool enabled = true,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.space8),
    child: TextField(
      controller: controller,
      enabled: enabled,
      maxLines: null,
      minLines: 2,
      maxLength: maxLength,
      decoration: InputDecoration(
        labelText: labelKey.tr(),
        border: const OutlineInputBorder(),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final plan = widget.plan;
    final theme = Theme.of(context);
    final options = ref.watch(
      lessonPlanOptionsProvider((
        sectionId: widget.sectionId,
        subjectId: widget.subjectId,
        date: _wireDate,
      )),
    );
    final periods = options.value?.periods ?? const <int>[];
    final materials = [
      ...?options.value?.materials,
      // Linked materials the options no longer list stay visible.
      for (final material
          in plan?.materials ?? const <({String id, String title})>[])
        if (!(options.value?.materials ?? const []).any(
          (other) => other.id == material.id,
        ))
          material,
    ];
    return Scaffold(
      appBar: AppBar(
        title: Text('teacher.plans.lessonPlan'.tr()),
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
                          .delete(PlanKind.lesson, plan!.header.id);
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
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.event_outlined),
            title: Text(formatPlanDate(context, _date)),
            subtitle: Text('teacher.plans.date'.tr()),
            trailing: _editable
                ? const Icon(Icons.edit_calendar_outlined)
                : null,
            onTap: _editable ? _pickDate : null,
          ),
          DropdownButtonFormField<int?>(
            key: ValueKey('period-$_wireDate-${periods.join(',')}'),
            initialValue: _period,
            isExpanded: true,
            decoration: InputDecoration(
              labelText: 'teacher.plans.period'.tr(),
              helperText: periods.isEmpty
                  ? 'teacher.plans.noPeriods'.tr()
                  : null,
              border: const OutlineInputBorder(),
            ),
            items: [
              DropdownMenuItem<int?>(
                child: Text('teacher.plans.noPeriod'.tr()),
              ),
              for (final period in {...periods, ?_period})
                DropdownMenuItem<int?>(
                  value: period,
                  child: Text(
                    'teacher.plans.periodN'.tr(namedArgs: {'n': '$period'}),
                  ),
                ),
            ],
            onChanged: _editable
                ? (value) => setState(() => _period = value)
                : null,
          ),
          const SizedBox(height: AppSpacing.space12),
          TextField(
            controller: _title,
            enabled: _editable,
            maxLength: 200,
            decoration: InputDecoration(
              labelText: 'teacher.plans.lessonTitle'.tr(),
              border: const OutlineInputBorder(),
            ),
          ),
          _field(
            _objectives,
            'teacher.plans.objectives',
            maxLength: 4000,
            enabled: _editable,
          ),
          Text(
            'teacher.plans.outcomes'.tr(),
            style: theme.textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.space4),
          OutcomePicker(
            available: options.value?.outcomes ?? const [],
            selected: _outcomes,
            enabled: _editable,
            onChanged: (value) => setState(() => _outcomes = value),
          ),
          const SizedBox(height: AppSpacing.space12),
          _field(
            _activities,
            'teacher.plans.activities',
            maxLength: 4000,
            enabled: _editable,
          ),
          _field(_resources, 'teacher.plans.resources', enabled: _editable),
          Text(
            'teacher.plans.materials'.tr(),
            style: theme.textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.space4),
          if (materials.isEmpty)
            Text(
              'teacher.plans.noMaterials'.tr(),
              style: theme.textTheme.bodySmall,
            )
          else
            Wrap(
              spacing: AppSpacing.space8,
              runSpacing: AppSpacing.space4,
              children: [
                for (final material in materials)
                  FilterChip(
                    label: Text(material.title),
                    selected: _materialIds.contains(material.id),
                    onSelected: _editable
                        ? (on) => setState(() {
                            _materialIds = {..._materialIds};
                            on
                                ? _materialIds.add(material.id)
                                : _materialIds.remove(material.id);
                          })
                        : null,
                  ),
              ],
            ),
          const SizedBox(height: AppSpacing.space12),
          _field(_homework, 'teacher.plans.homework', enabled: _editable),
          if (_editable) ...[
            const SizedBox(height: AppSpacing.space12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                            await _save();
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
                            final saved = await _save();
                            await ref
                                .read(academicPlansClientProvider)
                                .submit(PlanKind.lesson, saved.header.id);
                            ref.invalidate(lessonPlanProvider(saved.header.id));
                            _refreshLists();
                          }, 'teacher.plans.submitted'),
                    child: Text('teacher.plans.submit'.tr()),
                  ),
                ),
              ],
            ),
          ],
          if (plan != null && plan.canReflect) ...[
            const SizedBox(height: AppSpacing.space24),
            Text(
              'teacher.plans.reflectionHelp'.tr(),
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.space8),
            _field(_reflection, 'teacher.plans.reflection'),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                onPressed: _busy
                    ? null
                    : () => _run(
                        () async {
                          await ref
                              .read(academicPlansClientProvider)
                              .saveReflection(
                                plan.header.id,
                                _clean(_reflection),
                              );
                          ref.invalidate(lessonPlanProvider(plan.header.id));
                        },
                        'teacher.plans.reflectionSaved',
                        close: false,
                      ),
                child: Text('teacher.plans.saveReflection'.tr()),
              ),
            ),
          ] else if (plan != null)
            PlanTextBlock(
              labelKey: 'teacher.plans.reflection',
              value: plan.reflection,
            ),
        ],
      ),
    );
  }
}
