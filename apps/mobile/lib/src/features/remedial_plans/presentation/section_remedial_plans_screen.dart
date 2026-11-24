import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../teacher/application/predicted_grades_providers.dart';
import '../../teacher/presentation/widgets/mark_sheet_common.dart';
import '../application/remedial_plans_providers.dart';
import '../domain/remedial_plan.dart';
import 'remedial_plan_detail_screen.dart';
import 'remedial_plan_form_screen.dart';
import 'widgets/remedial_plan_widgets.dart';

/// The subject teacher's remedial plans (000268) for a class: the class resolves to its grade
/// section and subject first (a class without a section has none), then
/// [SectionRemedialPlansScreen]. Pushed from `TeacherClassDetailScreen`.
class TeacherRemedialPlansScreen extends ConsumerWidget {
  const TeacherRemedialPlansScreen({
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
      appBar: AppBar(title: Text('remedial.title'.tr())),
      body: body,
    );
    return target.when(
      loading: () => shell(const Center(child: CircularProgressIndicator())),
      error: (_, _) => shell(
        MarksMessage(
          icon: Icons.error_outline,
          message: 'remedial.error'.tr(),
          onRetry: () => ref.invalidate(classGradingTargetProvider(classId)),
        ),
      ),
      data: (target) => target == null
          ? shell(
              MarksMessage(
                icon: Icons.info_outline,
                message: 'remedial.noSection'.tr(),
              ),
            )
          : SectionRemedialPlansScreen(
              sectionId: target.sectionId,
              subjectId: target.subjectId,
              title: classCode,
            ),
    );
  }
}

/// A section's subject: the students below the pass line on their current marks for a period, and
/// every plan this year. The subject's teacher (or leadership) opens plans from here; the subject's
/// coordinator, who arrives from the Coordinator area, reads them and follows them up.
class SectionRemedialPlansScreen extends ConsumerStatefulWidget {
  const SectionRemedialPlansScreen({
    required this.sectionId,
    required this.subjectId,
    required this.title,
    super.key,
  });

  final String sectionId;
  final String subjectId;

  /// Shown under the title until the section has loaded.
  final String title;

  @override
  ConsumerState<SectionRemedialPlansScreen> createState() =>
      _SectionRemedialPlansScreenState();
}

class _SectionRemedialPlansScreenState
    extends ConsumerState<SectionRemedialPlansScreen> {
  /// Null: the whole year.
  String? _termId;

  SectionRemedialKey get _key => (
    sectionId: widget.sectionId,
    subjectId: widget.subjectId,
    termId: _termId,
  );

  Future<void> _openPlan(String planId) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => RemedialPlanDetailScreen(planId: planId),
      ),
    );
    if (mounted) ref.invalidate(sectionRemedialPlansProvider(_key));
  }

  Future<void> _create(SectionRemedialPlans data, {String? studentId}) async {
    final plan = await Navigator.of(context).push<RemedialPlan>(
      MaterialPageRoute(
        builder: (_) => RemedialPlanFormScreen.create(
          section: data,
          studentId: studentId,
          termId: _termId,
        ),
      ),
    );
    if (!mounted) return;
    ref.invalidate(sectionRemedialPlansProvider(_key));
    if (plan != null) await _openPlan(plan.id);
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(sectionRemedialPlansProvider(_key));
    final data = async.value;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('remedial.title'.tr()),
            Text(
              data == null
                  ? widget.title
                  : [
                      data.subjectName,
                      data.sectionLabel,
                    ].where((part) => part.isNotEmpty).join(' · '),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
      floatingActionButton: data != null && data.canCreate
          ? FloatingActionButton.extended(
              onPressed: () => _create(data),
              icon: const Icon(Icons.add),
              label: Text('remedial.newPlan'.tr()),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(sectionRemedialPlansProvider(_key).future),
        child: async.when(
          skipLoadingOnReload: true,
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => MarksMessage(
            icon: Icons.error_outline,
            message: 'remedial.error'.tr(),
            onRetry: () => ref.invalidate(sectionRemedialPlansProvider(_key)),
          ),
          data: _body,
        ),
      ),
    );
  }

  Widget _body(SectionRemedialPlans data) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodyMedium?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final pass = data.passPercentage;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space16,
        AppSpacing.space64 + AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        Text(
          data.canCreate ? 'remedial.help'.tr() : 'remedial.followUpHelp'.tr(),
          style: muted,
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
            DropdownMenuItem<String?>(child: Text('remedial.wholeYear'.tr())),
            for (final term in data.terms)
              DropdownMenuItem<String?>(
                value: term.termId,
                child: Text(term.name),
              ),
          ],
          onChanged: (termId) => setState(() => _termId = termId),
        ),
        const SizedBox(height: AppSpacing.space16),
        Text('remedial.suggestions'.tr(), style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space4),
        Text(
          pass == null
              ? 'remedial.noPassLine'.tr()
              : 'remedial.suggestionsHelp'.tr(
                  namedArgs: {'pass': remedialPercent(pass)},
                ),
          style: muted,
        ),
        const SizedBox(height: AppSpacing.space8),
        if (pass != null && data.suggestions.isEmpty)
          Text('remedial.noSuggestions'.tr()),
        for (final suggestion in data.suggestions)
          Card(
            margin: const EdgeInsets.only(bottom: AppSpacing.space8),
            child: ListTile(
              title: Text(suggestion.name),
              subtitle: Text(
                (suggestion.provisional
                        ? 'remedial.currentProvisional'
                        : 'remedial.current')
                    .tr(
                      namedArgs: {
                        'percentage': remedialPercent(suggestion.percentage),
                      },
                    ),
              ),
              trailing: suggestion.activePlanId != null
                  ? TextButton(
                      onPressed: () => _openPlan(suggestion.activePlanId!),
                      child: Text('remedial.viewPlan'.tr()),
                    )
                  : data.canCreate
                  ? TextButton(
                      onPressed: () =>
                          _create(data, studentId: suggestion.studentId),
                      child: Text('remedial.openPlan'.tr()),
                    )
                  : null,
            ),
          ),
        const SizedBox(height: AppSpacing.space16),
        Text('remedial.plans'.tr(), style: theme.textTheme.titleMedium),
        const SizedBox(height: AppSpacing.space8),
        if (data.plans.isEmpty) Text('remedial.noPlans'.tr()),
        for (final plan in data.plans)
          RemedialPlanCard(plan: plan, onTap: () => _openPlan(plan.id)),
      ],
    );
  }
}
