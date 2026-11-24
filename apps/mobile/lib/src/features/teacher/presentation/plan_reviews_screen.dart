import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/kit/kit.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_plans_providers.dart';
import '../application/coordinator_providers.dart';
import '../domain/academic_plans.dart';
import 'academic_plans_screen.dart';
import 'widgets/academic_plan_common.dart';
import 'widgets/mark_sheet_common.dart';

/// Opens [PlanReviewsScreen] from the Classes tab, beside the Coordinator entry. Shown only to a
/// teacher who coordinates a subject this year (000261): they review its sections' plans.
class PlanReviewsEntryTile extends ConsumerWidget {
  const PlanReviewsEntryTile({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final subjects = ref.watch(myCoordinatedSubjectsProvider).value;
    if (subjects == null || subjects.isEmpty) return const SizedBox.shrink();
    final waiting = ref.watch(planReviewQueueProvider).value?.plans.length;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space12),
      child: AppIconListCard(
        leading: const AppIconBadge(
          icon: Icons.fact_check_outlined,
          accent: AppAccent.violet,
          filled: true,
        ),
        color: AppAccent.violet.colorsOf(context).container,
        title: 'teacher.planReviews.open'.tr(),
        subtitle: waiting == null
            ? 'teacher.planReviews.openSubtitle'.tr()
            : 'teacher.planReviews.waiting'.tr(
                namedArgs: {'count': '$waiting'},
              ),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const PlanReviewsScreen()),
        ),
      ),
    );
  }
}

/// The lesson and term plans awaiting the coordinator's review, oldest first.
class PlanReviewsScreen extends ConsumerWidget {
  const PlanReviewsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final queue = ref.watch(planReviewQueueProvider);
    return Scaffold(
      appBar: AppBar(title: Text('teacher.planReviews.title'.tr())),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(planReviewQueueProvider),
        child: queue.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => MarksMessage(
            icon: Icons.error_outline,
            message: 'teacher.planReviews.error'.tr(),
            onRetry: () => ref.invalidate(planReviewQueueProvider),
          ),
          data: (queue) => queue.plans.isEmpty
              ? MarksMessage(
                  icon: Icons.task_alt_outlined,
                  message: 'teacher.planReviews.empty'.tr(),
                )
              : ListView.separated(
                  padding: const EdgeInsets.all(
                    AppSpacing.space16,
                  ).withBottomInset(context),
                  itemCount: queue.plans.length,
                  separatorBuilder: (_, _) =>
                      const SizedBox(height: AppSpacing.space8),
                  itemBuilder: (context, index) {
                    final plan = queue.plans[index];
                    return PlanSummaryTile(
                      plan: plan,
                      showClass: true,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => PlanReviewScreen(
                            kind: plan.kind,
                            planId: plan.header.id,
                          ),
                        ),
                      ),
                    );
                  },
                ),
        ),
      ),
    );
  }
}

/// One submitted plan, read-only, with approve and return (a comment is required to return it).
class PlanReviewScreen extends ConsumerStatefulWidget {
  const PlanReviewScreen({required this.kind, required this.planId, super.key});

  final PlanKind kind;
  final String planId;

  @override
  ConsumerState<PlanReviewScreen> createState() => _PlanReviewScreenState();
}

class _PlanReviewScreenState extends ConsumerState<PlanReviewScreen> {
  final _comment = TextEditingController();
  bool _busy = false;
  bool _commentMissing = false;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _decide({required bool approve}) async {
    final comment = _comment.text.trim();
    if (!approve && comment.isEmpty) {
      setState(() => _commentMissing = true);
      return;
    }
    setState(() {
      _busy = true;
      _commentMissing = false;
    });
    try {
      await ref
          .read(academicPlansClientProvider)
          .review(
            widget.kind,
            widget.planId,
            approve: approve,
            comment: comment.isEmpty ? null : comment,
          );
      ref.invalidate(planReviewQueueProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(
          SnackBar(
            content: Text(
              (approve
                      ? 'teacher.planReviews.approved'
                      : 'teacher.planReviews.returned')
                  .tr(),
            ),
          ),
        );
      Navigator.of(context).pop();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(planErrorMessage(error))));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = widget.kind == PlanKind.term
        ? ref
              .watch(termPlanProvider(widget.planId))
              .whenData((plan) => (plan.header, _TermBody(plan: plan)))
        : ref
              .watch(lessonPlanProvider(widget.planId))
              .whenData((plan) => (plan.header, _LessonBody(plan: plan)));
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.kind == PlanKind.term
              ? 'teacher.plans.termPlan'.tr()
              : 'teacher.plans.lessonPlan'.tr(),
        ),
      ),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.planReviews.error'.tr(),
        ),
        data: (data) {
          final (header, body) = data;
          return ListView(
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              Text(
                [
                  header.subjectName,
                  header.sectionLabel,
                  ?header.authorName,
                ].where((part) => part.isNotEmpty).join(' · '),
                style: Theme.of(context).textTheme.titleSmall,
              ),
              const SizedBox(height: AppSpacing.space8),
              Row(
                children: [
                  PlanStatusPill(status: header.status),
                  if (header.onTime == false) ...[
                    const SizedBox(width: AppSpacing.space8),
                    Text('teacher.plans.late'.tr()),
                  ],
                ],
              ),
              const SizedBox(height: AppSpacing.space12),
              ReviewCommentBanner(header: header),
              body,
              if (header.canReview) ...[
                const SizedBox(height: AppSpacing.space16),
                TextField(
                  controller: _comment,
                  maxLines: null,
                  minLines: 2,
                  maxLength: 2000,
                  decoration: InputDecoration(
                    labelText: 'teacher.planReviews.comment'.tr(),
                    errorText: _commentMissing
                        ? 'teacher.planReviews.commentRequired'.tr()
                        : null,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: AppSpacing.space8),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _busy ? null : () => _decide(approve: false),
                        child: Text('teacher.planReviews.return'.tr()),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space12),
                    Expanded(
                      child: FilledButton(
                        onPressed: _busy ? null : () => _decide(approve: true),
                        child: Text('teacher.planReviews.approve'.tr()),
                      ),
                    ),
                  ],
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _TermBody extends StatelessWidget {
  const _TermBody({required this.plan});

  final TermPlan plan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (plan.header.termName case final term?)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: Text(term, style: theme.textTheme.titleMedium),
          ),
        PlanTextBlock(labelKey: 'teacher.plans.notes', value: plan.notes),
        for (final week in plan.weeks)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.space12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  [
                    'teacher.plans.week'.tr(
                      namedArgs: {'n': '${week.weekNumber}'},
                    ),
                    ?week.unit,
                  ].join(' · '),
                  style: theme.textTheme.labelLarge,
                ),
                if (week.notes case final notes?) Text(notes),
                OutcomeList(outcomes: week.outcomes),
              ],
            ),
          ),
      ],
    );
  }
}

class _LessonBody extends StatelessWidget {
  const _LessonBody({required this.plan});

  final LessonPlan plan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(plan.title, style: theme.textTheme.titleMedium),
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.space12),
          child: Text(
            [
              formatPlanDate(context, plan.lessonDate),
              if (plan.period case final period?)
                'teacher.plans.periodN'.tr(namedArgs: {'n': '$period'}),
            ].join(' · '),
          ),
        ),
        PlanTextBlock(
          labelKey: 'teacher.plans.objectives',
          value: plan.objectives,
        ),
        if (plan.outcomes.isNotEmpty) ...[
          Text(
            'teacher.plans.outcomes'.tr(),
            style: theme.textTheme.labelLarge,
          ),
          OutcomeList(outcomes: plan.outcomes),
          const SizedBox(height: AppSpacing.space12),
        ],
        PlanTextBlock(
          labelKey: 'teacher.plans.activities',
          value: plan.activities,
        ),
        PlanTextBlock(
          labelKey: 'teacher.plans.resources',
          value: plan.resources,
        ),
        if (plan.materials.isNotEmpty) ...[
          Text(
            'teacher.plans.materials'.tr(),
            style: theme.textTheme.labelLarge,
          ),
          for (final material in plan.materials) Text(material.title),
          const SizedBox(height: AppSpacing.space12),
        ],
        PlanTextBlock(labelKey: 'teacher.plans.homework', value: plan.homework),
        PlanTextBlock(
          labelKey: 'teacher.plans.reflection',
          value: plan.reflection,
        ),
      ],
    );
  }
}
