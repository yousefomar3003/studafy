import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/offline/staleness_banner.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/grade_providers.dart';
import '../domain/grade_report.dart';
import 'widgets/grade_term_selector.dart';
import 'widgets/grade_trend_card.dart';
import 'widgets/grades_placeholders.dart';
import 'widgets/grades_publish_banner.dart';
import 'widgets/subject_grades_card.dart';
import 'widgets/term_grade_summary_card.dart';

/// The student's published grades for one term: the term picker, a term-average trend
/// sparkline, the term/cumulative summary, and a card per subject with its category breakdown.
///
/// Reached two ways: pushed with no [courseId] (e.g. from the "New grades" home card), or via
/// the `GRADE_POSTED` push deep link `/courses/{courseId}/grades`. On the deep-link path it
/// resets the term selection to the active term and then lets [deepLinkGradeTermProvider]
/// correct it to whichever term actually holds that course's freshly published grade — so the
/// student lands on the right term (acceptance criterion) — and highlights that subject.
class GradesScreen extends ConsumerStatefulWidget {
  const GradesScreen({this.courseId, super.key});

  /// The course a push deep link pointed at, or null for a plain in-app open. Non-null also
  /// means "arrived from the grade-posted notification", which is what shows the publish
  /// banner.
  final String? courseId;

  @override
  ConsumerState<GradesScreen> createState() => _GradesScreenState();
}

class _GradesScreenState extends ConsumerState<GradesScreen> {
  bool _bannerDismissed = false;
  bool _scrolledToHighlight = false;
  final _highlightKey = GlobalKey();

  bool get _fromPush => widget.courseId != null;

  @override
  void initState() {
    super.initState();
    if (_fromPush) {
      // Land on the active term first; deepLinkGradeTermProvider overrides it below once the
      // term holding this course resolves. Deferred past the first frame so it doesn't mutate
      // a provider mid-build.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(selectedGradeTermProvider.notifier).reset();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_fromPush) {
      ref.listen(deepLinkGradeTermProvider(widget.courseId!), (previous, next) {
        if (next != null && next != ref.read(selectedGradeTermProvider)) {
          ref.read(selectedGradeTermProvider.notifier).select(next);
        }
      });
    }

    final status = ref.watch(gradeReportProvider);

    return Scaffold(
      appBar: AppBar(title: Text('grades.title'.tr())),
      body: Column(
        children: [
          const GradeTermSelector(),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                ref
                  ..invalidate(academicYearTermsProvider)
                  ..invalidate(gradeSnapshotProvider);
              },
              child: status.when(
                loading: () => const GradesSkeleton(),
                error: (error, stackTrace) => const GradesMessage(
                  messageKey: 'grades.error',
                  icon: Icons.error_outline,
                ),
                data: (report) => switch (report) {
                  GradeReportUnavailable() => const GradesMessage(
                    messageKey: 'grades.unavailable',
                    icon: Icons.info_outline,
                  ),
                  GradeReportReady(value: final cached) => _Report(
                    report: cached.data,
                    isStale: cached.isStale,
                    fetchedAt: cached.fetchedAt,
                    highlightCourseId: widget.courseId,
                    highlightKey: _highlightKey,
                    showBanner: _fromPush && !_bannerDismissed,
                    onDismissBanner: () => setState(() => _bannerDismissed = true),
                    onReportBuilt: _scrollToHighlightOnce,
                  ),
                },
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _scrollToHighlightOnce() {
    if (_scrolledToHighlight || !_fromPush) return;
    _scrolledToHighlight = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = _highlightKey.currentContext;
      if (context != null) {
        Scrollable.ensureVisible(
          context,
          duration: const Duration(milliseconds: 300),
          alignment: 0.1,
        );
      }
    });
  }
}

class _Report extends StatelessWidget {
  const _Report({
    required this.report,
    required this.isStale,
    required this.fetchedAt,
    required this.highlightCourseId,
    required this.highlightKey,
    required this.showBanner,
    required this.onDismissBanner,
    required this.onReportBuilt,
  });

  final GradeReport report;
  final bool isStale;
  final DateTime fetchedAt;
  final String? highlightCourseId;
  final Key highlightKey;
  final bool showBanner;
  final VoidCallback onDismissBanner;
  final VoidCallback onReportBuilt;

  @override
  Widget build(BuildContext context) {
    final hasHighlight = report.subjects.any((s) => s.courseId == highlightCourseId);
    if (hasHighlight) onReportBuilt();

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        if (showBanner) ...[
          GradesPublishBanner(onDismiss: onDismissBanner),
          const SizedBox(height: AppSpacing.space16),
        ],
        if (isStale) ...[
          StalenessBanner(fetchedAt: fetchedAt),
          const SizedBox(height: AppSpacing.space16),
        ],
        GradeTrendCard(selectedTermId: report.term.id),
        const SizedBox(height: AppSpacing.space16),
        TermGradeSummaryCard(
          termSummary: report.termSummary,
          cumulativeSummary: report.cumulativeSummary,
        ),
        const SizedBox(height: AppSpacing.space16),
        if (report.isEmpty)
          const _EmptyTerm()
        else
          for (final subject in report.subjects) ...[
            SubjectGradesCard(
              key: subject.courseId == highlightCourseId ? highlightKey : null,
              subject: subject,
              highlighted: subject.courseId == highlightCourseId,
            ),
            const SizedBox(height: AppSpacing.space16),
          ],
      ],
    );
  }
}

class _EmptyTerm extends StatelessWidget {
  const _EmptyTerm();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.check_circle_outline, size: 20, color: colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space8),
          Expanded(
            child: Text(
              'grades.emptyTerm'.tr(),
              style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}
