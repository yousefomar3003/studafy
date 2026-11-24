import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/remedial_plans_providers.dart';
import '../domain/remedial_plan.dart';
import 'widgets/remedial_plan_widgets.dart';

/// Opens a remedial plan for a student of a section's subject, or changes one: reason, targets,
/// actions, review dates, sharing with the family and (when editing) the status, which only moves
/// forward. Pops with the saved [RemedialPlan].
class RemedialPlanFormScreen extends ConsumerStatefulWidget {
  const RemedialPlanFormScreen.create({
    required SectionRemedialPlans this.section,
    this.studentId,
    this.termId,
    super.key,
  }) : plan = null;

  const RemedialPlanFormScreen.edit({
    required RemedialPlan this.plan,
    super.key,
  }) : section = null,
       studentId = null,
       termId = null;

  /// Creating: the section's subject, its students and terms.
  final SectionRemedialPlans? section;

  /// Creating: the student to start with (a suggestion), if any.
  final String? studentId;

  /// Creating: the period to start with (null: the whole year).
  final String? termId;

  /// Editing: the plan.
  final RemedialPlan? plan;

  @override
  ConsumerState<RemedialPlanFormScreen> createState() =>
      _RemedialPlanFormScreenState();
}

class _RemedialPlanFormScreenState
    extends ConsumerState<RemedialPlanFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _reasonNote;
  late final TextEditingController _targets;
  late final TextEditingController _actions;
  final _statusNote = TextEditingController();
  String? _studentId;
  String? _termId;
  late RemedialPlanReason _reason;
  late RemedialPlanStatus _status;
  late List<DateTime> _reviewDates;
  late bool _shared;
  bool _saving = false;

  bool get _editing => widget.plan != null;

  @override
  void initState() {
    super.initState();
    final plan = widget.plan;
    final section = widget.section;
    _studentId = widget.studentId;
    _termId = widget.termId;
    final suggested =
        section?.suggestions.any((s) => s.studentId == _studentId) ?? false;
    _reason =
        plan?.summary.reason ??
        (suggested
            ? RemedialPlanReason.belowPass
            : RemedialPlanReason.teacherConcern);
    if (_reason == RemedialPlanReason.unknown) {
      _reason = RemedialPlanReason.teacherConcern;
    }
    _status = plan?.summary.status ?? RemedialPlanStatus.open;
    _reasonNote = TextEditingController(text: plan?.reasonNote ?? '');
    _targets = TextEditingController(text: plan?.targets ?? '');
    _actions = TextEditingController(text: plan?.actions ?? '');
    _reviewDates = [for (final review in plan?.reviews ?? []) review.reviewOn];
    _shared = plan?.summary.sharedWithFamily ?? false;
  }

  @override
  void dispose() {
    _reasonNote.dispose();
    _targets.dispose();
    _actions.dispose();
    _statusNote.dispose();
    super.dispose();
  }

  bool get _sharingAvailable =>
      (widget.section?.familySharingEnabled ??
          widget.plan?.familySharingEnabled ??
          false) ||
      _shared;

  Future<void> _addReviewDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: now.add(const Duration(days: 14)),
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
    );
    if (picked == null) return;
    final day = DateTime(picked.year, picked.month, picked.day);
    setState(() {
      if (!_reviewDates.contains(day)) _reviewDates = [..._reviewDates, day];
      _reviewDates.sort();
    });
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _saving = true);
    final client = ref.read(remedialPlansClientProvider);
    try {
      final plan = widget.plan;
      final saved = plan == null
          ? await client.create(
              sectionId: widget.section!.sectionId,
              subjectId: widget.section!.subjectId,
              studentId: _studentId!,
              termId: _termId,
              reason: _reason,
              reasonNote: _reasonNote.text,
              targets: _targets.text,
              actions: _actions.text,
              reviewDates: _reviewDates,
              sharedWithFamily: _shared,
            )
          : await client.update(
              plan.id,
              reason: _reason,
              reasonNote: _reasonNote.text,
              targets: _targets.text,
              actions: _actions.text,
              reviewDates: _reviewDates,
              status: _status == plan.summary.status ? null : _status,
              statusNote: _statusNote.text,
              sharedWithFamily: _shared,
            );
      if (mounted) Navigator.of(context).pop(saved);
    } catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(remedialErrorMessage(error))));
    }
  }

  String? _required(String? value) =>
      (value?.trim().isEmpty ?? true) ? 'remedial.form.required'.tr() : null;

  @override
  Widget build(BuildContext context) {
    final section = widget.section;
    final plan = widget.plan;
    final statuses = plan == null
        ? const <RemedialPlanStatus>[]
        : [plan.summary.status, ...plan.summary.status.next];
    return Scaffold(
      appBar: AppBar(
        title: Text(
          _editing ? 'remedial.form.editTitle'.tr() : 'remedial.newPlan'.tr(),
        ),
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('remedial.form.save'.tr()),
          ),
        ],
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(
            AppSpacing.space16,
          ).withBottomInset(context),
          children: [
            if (section != null) ...[
              DropdownButtonFormField<String>(
                initialValue: _studentId,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: 'remedial.form.student'.tr(),
                  border: const OutlineInputBorder(),
                ),
                items: [
                  for (final student in section.students)
                    DropdownMenuItem(
                      value: student.studentId,
                      child: Text(student.name),
                    ),
                ],
                validator: (value) =>
                    value == null ? 'remedial.form.required'.tr() : null,
                onChanged: (value) => setState(() => _studentId = value),
              ),
              const SizedBox(height: AppSpacing.space12),
              DropdownButtonFormField<String?>(
                initialValue: _termId,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: 'remedial.period'.tr(),
                  border: const OutlineInputBorder(),
                ),
                items: [
                  DropdownMenuItem<String?>(
                    child: Text('remedial.wholeYear'.tr()),
                  ),
                  for (final term in section.terms)
                    DropdownMenuItem<String?>(
                      value: term.termId,
                      child: Text(term.name),
                    ),
                ],
                onChanged: (value) => setState(() => _termId = value),
              ),
              const SizedBox(height: AppSpacing.space12),
            ],
            if (plan != null) ...[
              DropdownButtonFormField<RemedialPlanStatus>(
                initialValue: _status,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: 'remedial.form.status'.tr(),
                  border: const OutlineInputBorder(),
                ),
                items: [
                  for (final status in statuses)
                    DropdownMenuItem(
                      value: status,
                      child: Text(remedialStatusLabel(status)),
                    ),
                ],
                onChanged: (value) =>
                    setState(() => _status = value ?? _status),
              ),
              if (_status != plan.summary.status) ...[
                const SizedBox(height: AppSpacing.space12),
                TextFormField(
                  controller: _statusNote,
                  maxLength: RemedialLimits.note,
                  decoration: InputDecoration(
                    labelText: 'remedial.form.statusNote'.tr(),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.space12),
            ],
            DropdownButtonFormField<RemedialPlanReason>(
              initialValue: _reason,
              isExpanded: true,
              decoration: InputDecoration(
                labelText: 'remedial.fields.reason'.tr(),
                border: const OutlineInputBorder(),
              ),
              items: [
                for (final reason in const [
                  RemedialPlanReason.belowPass,
                  RemedialPlanReason.teacherConcern,
                ])
                  DropdownMenuItem(
                    value: reason,
                    child: Text(remedialReasonLabel(reason)),
                  ),
              ],
              onChanged: (value) => setState(() => _reason = value ?? _reason),
            ),
            const SizedBox(height: AppSpacing.space12),
            TextFormField(
              controller: _reasonNote,
              maxLength: RemedialLimits.reasonNote,
              decoration: InputDecoration(
                labelText: 'remedial.form.reasonNote'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            TextFormField(
              controller: _targets,
              minLines: 2,
              maxLines: 5,
              maxLength: RemedialLimits.targets,
              validator: _required,
              decoration: InputDecoration(
                labelText: 'remedial.fields.targets'.tr(),
                helperText: 'remedial.form.targetsHelp'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            TextFormField(
              controller: _actions,
              minLines: 2,
              maxLines: 6,
              maxLength: RemedialLimits.actions,
              validator: _required,
              decoration: InputDecoration(
                labelText: 'remedial.fields.actions'.tr(),
                helperText: 'remedial.form.actionsHelp'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'remedial.fields.reviews'.tr(),
              style: Theme.of(context).textTheme.titleSmall,
            ),
            const SizedBox(height: AppSpacing.space8),
            Wrap(
              spacing: AppSpacing.space8,
              runSpacing: AppSpacing.space4,
              children: [
                for (final date in _reviewDates)
                  InputChip(
                    label: Text(remedialDate(context, date)),
                    onDeleted: () => setState(
                      () => _reviewDates = [
                        for (final other in _reviewDates)
                          if (other != date) other,
                      ],
                    ),
                  ),
                if (_reviewDates.length < RemedialLimits.reviewDates)
                  ActionChip(
                    avatar: const Icon(Icons.add, size: 18),
                    label: Text('remedial.form.addReviewDate'.tr()),
                    onPressed: _addReviewDate,
                  ),
              ],
            ),
            if (_sharingAvailable) ...[
              const SizedBox(height: AppSpacing.space12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('remedial.form.share'.tr()),
                subtitle: Text('remedial.form.shareHelp'.tr()),
                value: _shared,
                onChanged: (value) => setState(() => _shared = value),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
