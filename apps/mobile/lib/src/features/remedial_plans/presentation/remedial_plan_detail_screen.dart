import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../teacher/presentation/widgets/mark_sheet_common.dart';
import '../application/remedial_plans_providers.dart';
import '../domain/remedial_plan.dart';
import 'remedial_plan_form_screen.dart';
import 'widgets/remedial_plan_widgets.dart';

/// One remedial plan: why it was opened, its targets and actions, review dates and the timeline of
/// progress and follow-up notes.
///
/// Its teacher (or leadership) edits it and moves its status forward; its teacher, the subject's
/// coordinator and leadership add notes (staff only when marked so). The student and parents, who
/// only ever receive shared plans, read it: the API never sends them staff-only notes.
class RemedialPlanDetailScreen extends ConsumerWidget {
  const RemedialPlanDetailScreen({required this.planId, super.key});

  final String planId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(remedialPlanProvider(planId));
    final plan = async.value;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(plan?.summary.subjectName ?? 'remedial.planTitle'.tr()),
            if (plan != null && plan.summary.studentName.isNotEmpty)
              Text(
                plan.summary.studentName,
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        actions: [
          if (plan != null && plan.canEdit)
            IconButton(
              icon: const Icon(Icons.edit_outlined),
              tooltip: 'remedial.edit'.tr(),
              onPressed: () async {
                final saved = await Navigator.of(context).push<RemedialPlan>(
                  MaterialPageRoute(
                    builder: (_) => RemedialPlanFormScreen.edit(plan: plan),
                  ),
                );
                if (saved != null) ref.invalidate(remedialPlanProvider(planId));
              },
            ),
        ],
      ),
      floatingActionButton: plan != null && plan.canAddNote
          ? FloatingActionButton.extended(
              onPressed: () => _addNote(context, ref, plan),
              icon: const Icon(Icons.add_comment_outlined),
              label: Text('remedial.addNote'.tr()),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(remedialPlanProvider(planId).future),
        child: async.when(
          skipLoadingOnReload: true,
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => MarksMessage(
            icon: Icons.error_outline,
            message: 'remedial.planError'.tr(),
            onRetry: () => ref.invalidate(remedialPlanProvider(planId)),
          ),
          data: (plan) => _PlanBody(plan: plan),
        ),
      ),
    );
  }

  Future<void> _addNote(
    BuildContext context,
    WidgetRef ref,
    RemedialPlan plan,
  ) async {
    final added = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _NoteSheet(plan: plan),
    );
    if (added == true) ref.invalidate(remedialPlanProvider(planId));
  }
}

class _PlanBody extends StatelessWidget {
  const _PlanBody({required this.plan});

  final RemedialPlan plan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final summary = plan.summary;
    final family = plan.access == RemedialPlanAccess.family;
    final start = plan.startPercentage;
    final pass = plan.passPercentage;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space64 + AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Wrap(
          spacing: AppSpacing.space8,
          runSpacing: AppSpacing.space4,
          children: [
            RemedialStatusPill(status: summary.status),
            if (summary.overdue)
              AppStatusPill(
                label: 'remedial.overdue'.tr(),
                tone: AppTone.danger,
              ),
            if (!family)
              AppStatusPill(
                label: summary.sharedWithFamily
                    ? 'remedial.shared'.tr()
                    : 'remedial.staffOnly'.tr(),
                icon: summary.sharedWithFamily
                    ? Icons.family_restroom_outlined
                    : Icons.lock_outline,
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.space8),
        Text(
          [
            summary.sectionLabel,
            remedialPeriodLabel(summary.termName),
          ].where((part) => part.isNotEmpty).join(' · '),
          style: muted,
        ),
        const SizedBox(height: AppSpacing.space16),
        _Field(
          label: 'remedial.fields.reason'.tr(),
          value: [
            remedialReasonLabel(summary.reason),
            ?plan.reasonNote,
          ].join('\n'),
        ),
        if (start != null)
          _Field(
            label: 'remedial.fields.startPercentage'.tr(),
            value: pass == null
                ? remedialPercent(start)
                : 'remedial.startWithPass'.tr(
                    namedArgs: {
                      'percentage': remedialPercent(start),
                      'pass': remedialPercent(pass),
                    },
                  ),
          ),
        _Field(label: 'remedial.fields.targets'.tr(), value: plan.targets),
        _Field(label: 'remedial.fields.actions'.tr(), value: plan.actions),
        Text('remedial.fields.reviews'.tr(), style: theme.textTheme.titleSmall),
        const SizedBox(height: AppSpacing.space4),
        if (plan.reviews.isEmpty) Text('remedial.noReviews'.tr(), style: muted),
        for (final review in plan.reviews)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space4),
            child: Row(
              children: [
                Icon(
                  review.done
                      ? Icons.check_circle_outline
                      : review.overdue
                      ? Icons.error_outline
                      : Icons.event_outlined,
                  size: 18,
                  color: review.overdue && !review.done
                      ? theme.colorScheme.error
                      : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.space8),
                Expanded(child: Text(remedialDate(context, review.reviewOn))),
                if (review.done)
                  AppStatusPill(
                    label: 'remedial.reviewDone'.tr(),
                    tone: AppTone.success,
                  )
                else if (review.overdue)
                  AppStatusPill(
                    label: 'remedial.overdue'.tr(),
                    tone: AppTone.danger,
                  ),
              ],
            ),
          ),
        const SizedBox(height: AppSpacing.space16),
        Text(
          'remedial.fields.timeline'.tr(),
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space4),
        if (plan.notes.isEmpty) Text('remedial.noNotes'.tr(), style: muted),
        for (final note in plan.notes.reversed) _NoteTile(note: note),
      ],
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.space4),
          Text(value, style: theme.textTheme.bodyMedium),
        ],
      ),
    );
  }
}

/// One timeline entry, newest first: who wrote it (and as what), when, and a status change.
class _NoteTile extends StatelessWidget {
  const _NoteTile({required this.note});

  final RemedialNote note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final created = note.createdAt?.toLocal();
    final byline = [
      ?note.authorName,
      'remedial.author.${note.authorAccess.name}'.tr(),
      if (created != null)
        DateFormat.yMMMd(context.locale.toString()).add_jm().format(created),
    ].where((part) => part.isNotEmpty).join(' · ');
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    byline,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
                if (note.internal)
                  AppStatusPill(
                    label: 'remedial.staffOnly'.tr(),
                    icon: Icons.lock_outline,
                  ),
              ],
            ),
            if (note.isStatusChange && note.newStatus != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Row(
                children: [
                  Text('remedial.statusChanged'.tr()),
                  const SizedBox(width: AppSpacing.space8),
                  RemedialStatusPill(status: note.newStatus!),
                ],
              ),
            ],
            if (note.body != null) ...[
              const SizedBox(height: AppSpacing.space4),
              Text(note.body!),
            ],
          ],
        ),
      ),
    );
  }
}

/// A progress or follow-up note. Adding one on or after a review date completes that review.
class _NoteSheet extends ConsumerStatefulWidget {
  const _NoteSheet({required this.plan});

  final RemedialPlan plan;

  @override
  ConsumerState<_NoteSheet> createState() => _NoteSheetState();
}

class _NoteSheetState extends ConsumerState<_NoteSheet> {
  final _body = TextEditingController();
  bool _internal = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _body.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_body.text.trim().isEmpty) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref
          .read(remedialPlansClientProvider)
          .addNote(widget.plan.id, body: _body.text, internal: _internal);
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = remedialErrorMessage(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'remedial.addNote'.tr(),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space12),
          TextField(
            controller: _body,
            minLines: 3,
            maxLines: 6,
            maxLength: RemedialLimits.note,
            autofocus: true,
            decoration: InputDecoration(
              labelText: 'remedial.noteLabel'.tr(),
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('remedial.internalLabel'.tr()),
            subtitle: Text('remedial.internalHelp'.tr()),
            value: _internal,
            onChanged: (value) => setState(() => _internal = value),
          ),
          if (_error != null)
            Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          const SizedBox(height: AppSpacing.space8),
          FilledButton(
            onPressed: _saving || _body.text.trim().isEmpty ? null : _save,
            child: _saving
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('remedial.saveNote'.tr()),
          ),
        ],
      ),
    );
  }
}
