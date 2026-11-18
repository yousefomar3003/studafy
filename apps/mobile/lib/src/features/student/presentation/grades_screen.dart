import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/offline/staleness_banner.dart';
import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/grade_providers.dart';
import '../domain/grade_report.dart';
import '../domain/recent_grades.dart';
import '../domain/work_and_grades.dart';
import 'academic_results_screen.dart';
import 'widgets/grade_term_selector.dart';
import 'widgets/grade_trend_card.dart';
import 'widgets/grades_placeholders.dart';
import 'widgets/grades_publish_banner.dart';
import 'widgets/recent_grades_widgets.dart';
import 'widgets/released_marks_widgets.dart';
import 'widgets/subject_grades_card.dart';
import 'widgets/term_grade_summary_card.dart';
import '../../../design/widgets/protected_screen.dart';

export '../domain/work_and_grades.dart' show GradesTab;

/// The student's grades, in two tabs that keep the two kinds of mark apart, each labelled with
/// its kind's icon ([GradeKindVisuals], the same badges the home's "Recent grades" uses):
///
/// - **Exams** — every mark school leadership has approved (a whole term's mark sheet, or one
///   exam on its own such as the first monthly exam), by term and subject. The default tab, so an
///   approved exam is the first thing a student sees here, not hidden behind an icon.
/// - **Assignments** — the published coursework grades for one term: the term picker, a
///   term-average trend sparkline, the term/cumulative summary, and a card per subject with its
///   category breakdown.
///
/// The student app shows the same view ([GradesView]) as the "Grades" section of its "Work &
/// grades" tab, which is where the home's "Recent grades" goes. This standalone screen is the
/// `GRADE_POSTED` push deep link `/courses/{courseId}/grades`, which always opens Assignments,
/// and the fallback for a "Recent grades" shown outside the student shell. On the deep-link path
/// it resets the term selection to the active term and then lets [deepLinkGradeTermProvider]
/// correct it to whichever term actually holds that course's freshly published grade — so the
/// student lands on the right term (acceptance criterion) — and highlights that subject.
class GradesScreen extends StatelessWidget {
  const GradesScreen({this.courseId, this.initialTab = GradesTab.exams, super.key});

  /// The course a push deep link pointed at, or null for a plain in-app open. Non-null also
  /// means "arrived from the grade-posted notification", which is what shows the publish
  /// banner.
  final String? courseId;

  /// The tab to open on; a [courseId] deep link always opens [GradesTab.assignments].
  final GradesTab initialTab;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('grades.title'.tr()),
        actions: const [AcademicResultsButton()],
      ),
      body: GradesView(
        courseId: courseId,
        tab: courseId != null ? GradesTab.assignments : initialTab,
      ),
    );
  }
}

/// Opens the official (finalized) results, certificates and report cards — distinct from the
/// approved marks and published running grades the grades view shows.
class AcademicResultsButton extends StatelessWidget {
  const AcademicResultsButton({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const Icon(Icons.workspace_premium_outlined),
      tooltip: 'academicResults.entry'.tr(),
      onPressed: () => Navigator.of(
        context,
      ).push(MaterialPageRoute<void>(builder: (_) => const AcademicResultsScreen())),
    );
  }
}

/// The grades themselves, under their "Exams" / "Assignments" tab bar: the body of
/// [GradesScreen] and the "Grades" section of the student's "Work & grades" tab.
///
/// [tab] is the tab to show; changing it switches tabs (animated), and [onTabChanged] reports
/// the student's own switches, so a parent can hold the selection.
class GradesView extends ConsumerStatefulWidget {
  const GradesView({
    this.courseId,
    this.tab = GradesTab.exams,
    this.onTabChanged,
    this.inWorkTab = false,
    super.key,
  });

  /// See [GradesScreen.courseId].
  final String? courseId;
  final GradesTab tab;
  final ValueChanged<GradesTab>? onTabChanged;

  /// Shown as a section of the "Work & grades" tab rather than on its own screen: the coursework
  /// tab reads "Assignment grades", the tab's other section being the assignments themselves.
  final bool inWorkTab;

  @override
  ConsumerState<GradesView> createState() => _GradesViewState();
}

class _GradesViewState extends ConsumerState<GradesView> with SingleTickerProviderStateMixin {
  bool _bannerDismissed = false;
  bool _scrolledToHighlight = false;
  final _highlightKey = GlobalKey();
  late final TabController _tabController = TabController(
    length: GradesTab.values.length,
    initialIndex: widget.tab.index,
    vsync: this,
  )..addListener(_reportTab);

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
  void didUpdateWidget(GradesView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.tab != oldWidget.tab && _tabController.index != widget.tab.index) {
      _tabController.animateTo(widget.tab.index);
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  void _reportTab() {
    if (_tabController.indexIsChanging) return;
    final tab = GradesTab.values[_tabController.index];
    if (tab != widget.tab) widget.onTabChanged?.call(tab);
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

    final tabBar = TabBar(
      controller: _tabController,
      // Room for "Assignment grades" beside its icon on a phone-width screen.
      labelPadding: widget.inWorkTab
          ? const EdgeInsets.symmetric(horizontal: AppSpacing.space8)
          : null,
      tabs: [
        const GradeKindTab(key: ValueKey('grades-tab-exams'), kind: GradeKind.exam),
        GradeKindTab(
          key: const ValueKey('grades-tab-assignments'),
          kind: GradeKind.assignment,
          label: widget.inWorkTab ? 'grades.sections.assignmentGrades'.tr() : null,
        ),
      ],
    );

    final screen = Column(
      children: [
        tabBar,
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              const ReleasedMarksView(),
              Column(
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
            ],
          ),
        ),
      ],
    );
    // Grades and transcripts: no screenshots, hidden in the app switcher (QA-084).
    return ProtectedScreen(child: screen);
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

    // Eager children rather than a sliver builder, deliberately:
    // 1. `report.subjects` is bounded by a school term (typically 5-10 courses), so a full build
    //    is cheap and the list is not a jank risk on its own.
    // 2. The grade-posted push deep-link scrolls to one highlighted card via
    //    `Scrollable.ensureVisible` on [_highlightKey] — that needs every card materialised even
    //    when it is off-screen, which a lazily-built sliver cannot guarantee.
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.space16).withBottomInset(context),
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
