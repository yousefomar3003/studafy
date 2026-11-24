import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/academic_plans_providers.dart';
import '../application/predicted_grades_providers.dart';
import '../domain/academic_plans.dart';
import 'lesson_plan_editor_screen.dart';
import 'term_plan_editor_screen.dart';
import 'widgets/academic_plan_common.dart';
import 'widgets/mark_sheet_common.dart';

/// The class's term and lesson plans (000267): the teacher writes them here, submits them for
/// review, and sees what the coordinator or leadership approved or returned.
///
/// Pushed from [TeacherClassDetailScreen]. The class resolves to its grade section and subject
/// first; a class without a section has no plans.
class AcademicPlansScreen extends ConsumerWidget {
  const AcademicPlansScreen({
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
      appBar: AppBar(title: Text('teacher.plans.title'.tr())),
      body: body,
    );
    return target.when(
      loading: () => shell(const Center(child: CircularProgressIndicator())),
      error: (_, _) => shell(
        MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.plans.error'.tr(),
          onRetry: () => ref.invalidate(classGradingTargetProvider(classId)),
        ),
      ),
      data: (target) => target == null
          ? shell(
              MarksMessage(
                icon: Icons.info_outline,
                message: 'teacher.plans.noSection'.tr(),
              ),
            )
          : _PlansTabs(
              sectionId: target.sectionId,
              subjectId: target.subjectId,
              classCode: classCode,
            ),
    );
  }
}

class _PlansTabs extends StatelessWidget {
  const _PlansTabs({
    required this.sectionId,
    required this.subjectId,
    required this.classCode,
  });

  final String sectionId;
  final String subjectId;
  final String classCode;

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Builder(
        builder: (context) => Scaffold(
          appBar: AppBar(
            title: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('teacher.plans.title'.tr()),
                Text(classCode, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
            bottom: TabBar(
              tabs: [
                Tab(text: 'teacher.plans.lessonPlans'.tr()),
                Tab(text: 'teacher.plans.termPlans'.tr()),
              ],
            ),
          ),
          floatingActionButton: FloatingActionButton.extended(
            icon: const Icon(Icons.add),
            label: Text('teacher.plans.new'.tr()),
            onPressed: () {
              final lesson = DefaultTabController.of(context).index == 0;
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => lesson
                      ? LessonPlanEditorScreen(
                          sectionId: sectionId,
                          subjectId: subjectId,
                        )
                      : TermPlanEditorScreen(
                          sectionId: sectionId,
                          subjectId: subjectId,
                        ),
                ),
              );
            },
          ),
          body: TabBarView(
            children: [
              _PlanList(
                kind: PlanKind.lesson,
                sectionId: sectionId,
                subjectId: subjectId,
              ),
              _PlanList(
                kind: PlanKind.term,
                sectionId: sectionId,
                subjectId: subjectId,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlanList extends ConsumerWidget {
  const _PlanList({
    required this.kind,
    required this.sectionId,
    required this.subjectId,
  });

  final PlanKind kind;
  final String sectionId;
  final String subjectId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = (kind: kind, sectionId: sectionId, subjectId: subjectId);
    final plans = ref.watch(sectionPlansProvider(key));
    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(sectionPlansProvider(key)),
      child: plans.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => MarksMessage(
          icon: Icons.error_outline,
          message: 'teacher.plans.error'.tr(),
          onRetry: () => ref.invalidate(sectionPlansProvider(key)),
        ),
        data: (list) => list.isEmpty
            ? MarksMessage(
                icon: Icons.event_note_outlined,
                message: kind == PlanKind.lesson
                    ? 'teacher.plans.emptyLessons'.tr()
                    : 'teacher.plans.emptyTerms'.tr(),
              )
            : ListView.separated(
                padding: const EdgeInsets.all(
                  AppSpacing.space16,
                ).withBottomInset(context),
                itemCount: list.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AppSpacing.space8),
                itemBuilder: (context, index) => PlanSummaryTile(
                  plan: list[index],
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => kind == PlanKind.lesson
                          ? LessonPlanEditorScreen(
                              sectionId: sectionId,
                              subjectId: subjectId,
                              planId: list[index].header.id,
                            )
                          : TermPlanEditorScreen(
                              sectionId: sectionId,
                              subjectId: subjectId,
                              planId: list[index].header.id,
                            ),
                    ),
                  ),
                ),
              ),
      ),
    );
  }
}

/// One plan in a list: its title (lesson) or term, when, status and timeliness.
class PlanSummaryTile extends StatelessWidget {
  const PlanSummaryTile({
    required this.plan,
    required this.onTap,
    this.showClass = false,
    super.key,
  });

  final PlanSummary plan;
  final VoidCallback onTap;

  /// In the review queue: name the subject and section too.
  final bool showClass;

  @override
  Widget build(BuildContext context) {
    final header = plan.header;
    final title = plan.kind == PlanKind.lesson
        ? plan.title ?? ''
        : 'teacher.plans.termPlanTitle'.tr(
            namedArgs: {'term': header.termName ?? ''},
          );
    final when = [
      if (plan.lessonDate case final date?) formatPlanDate(context, date),
      if (plan.period case final period?)
        'teacher.plans.periodN'.tr(namedArgs: {'n': '$period'}),
      if (showClass) '${header.subjectName} · ${header.sectionLabel}',
      if (showClass && header.authorName != null) header.authorName!,
    ].join(' · ');
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        title: Text(title),
        subtitle: when.isEmpty ? null : Text(when),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            PlanStatusPill(status: header.status),
            if (header.onTime == false)
              Text(
                'teacher.plans.late'.tr(),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        onTap: onTap,
      ),
    );
  }
}
