import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/layout/bottom_inset_padding.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/released_marks_providers.dart';
import '../../application/student_context_providers.dart';
import '../../domain/released_marks.dart';
import 'academic_result_widgets.dart';

/// The kit pieces every view of a student's approved exam marks shares: the full list
/// ([ReleasedMarksView], the student's "Exam marks" tab and the notification's screen), the
/// summary card ([ReleasedMarksSummaryCard], a parent's Grades tab and the student's home) and
/// the one-assessment row ([ReleasedMarkTile]).

/// How long a released mark counts as "new" on the student's home.
const releasedMarksRecentWindow = Duration(days: 14);

/// The printed mark of [attempt]: "17.5 / 20", a descriptor, or absent / excused / N/A.
String releasedMarkValue(
  ReleasedAssessment assessment,
  ReleasedMarkAttempt attempt,
) {
  final score = attempt.score;
  return switch (attempt.status) {
    ReleasedMarkStatus.graded when attempt.descriptorLabel != null =>
      attempt.descriptorLabel!,
    ReleasedMarkStatus.graded when score != null =>
      '${formatResultNumber(score)} / '
          '${formatResultNumber(assessment.maxMarks)}',
    ReleasedMarkStatus.graded => '—',
    ReleasedMarkStatus.absent => 'releasedMarks.status.absent'.tr(),
    ReleasedMarkStatus.excused => 'releasedMarks.status.excused'.tr(),
    ReleasedMarkStatus.notApplicable =>
      'releasedMarks.status.notApplicable'.tr(),
  };
}

AppTone _toneOf(ReleasedAssessment assessment, ReleasedMarkAttempt attempt) {
  final score = attempt.score;
  if (attempt.status != ReleasedMarkStatus.graded ||
      attempt.descriptorLabel != null ||
      score == null ||
      assessment.maxMarks <= 0) {
    return AppTone.neutral;
  }
  return AppTone.forPercentage(score / assessment.maxMarks * 100);
}

/// Whether [attempt] prints as "score / max" rather than words.
bool _isScore(ReleasedMarkAttempt attempt) =>
    attempt.status == ReleasedMarkStatus.graded &&
    attempt.descriptorLabel == null &&
    attempt.score != null;

/// Lays a "17.5 / 20" mark out left to right in Arabic too, where the bidi algorithm would
/// otherwise print it as "20 / 17.5". Words (absent, a descriptor) keep the ambient direction.
class _ScoreDirection extends StatelessWidget {
  const _ScoreDirection({required this.attempt, required this.child});

  final ReleasedMarkAttempt attempt;
  final Widget child;

  @override
  Widget build(BuildContext context) => _isScore(attempt)
      ? Directionality(textDirection: TextDirection.ltr, child: child)
      : child;
}

String _date(BuildContext context, DateTime date) =>
    DateFormat.yMMMd(context.locale.toString()).format(date.toLocal());

/// One released assessment: its name (with a retake marked as such), a muted line under it, and
/// the mark as a pill tinted by how well it went (the number is always printed). [subtitle]
/// defaults to when the mark was released.
class ReleasedMarkTile extends StatelessWidget {
  const ReleasedMarkTile({
    required this.assessment,
    required this.attempt,
    this.subtitle,
    this.icon,
    this.accent = AppAccent.blue,
    this.onTap,
    super.key,
  });

  final ReleasedAssessment assessment;
  final ReleasedMarkAttempt attempt;
  final String? subtitle;

  /// A leading badge (the subject's icon in a summary list); none inside a subject's own card.
  final IconData? icon;
  final AppAccent accent;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final releasedAt = assessment.releasedAt;
    return AppIconListTile(
      icon: icon,
      accent: accent,
      title: attempt.attempt > 1
          ? 'releasedMarks.retake'.tr(namedArgs: {'name': assessment.name})
          : assessment.name,
      subtitle:
          subtitle ??
          (releasedAt == null
              ? null
              : 'releasedMarks.releasedOn'.tr(
                  namedArgs: {'date': _date(context, releasedAt)},
                )),
      trailing: _ScoreDirection(
        attempt: attempt,
        child: AppStatusPill(
          label: releasedMarkValue(assessment, attempt),
          tone: _toneOf(assessment, attempt),
        ),
      ),
      onTap: onTap,
    );
  }
}

/// A student's approved marks in full: the latest one in a hero at the top, then each period
/// (term, then the full year) with a card per subject listing every released assessment by
/// category. Pull to refresh. [studentId] null = the signed-in student.
///
/// Only what school leadership approved ever arrives (the whole term's sheet, or one assessment
/// on its own); a subject with only some of its term released says more is still to come, and
/// nothing here is a term total.
class ReleasedMarksView extends ConsumerWidget {
  const ReleasedMarksView({this.studentId, super.key});

  final String? studentId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = studentId ?? ref.watch(currentStudentIdProvider);
    if (id == null) {
      return studentId == null &&
              ref.watch(currentStudentSelfProvider).isLoading
          ? const Center(child: CircularProgressIndicator())
          : _Message(
              icon: Icons.info_outline,
              message: 'releasedMarks.unavailable'.tr(),
            );
    }

    final marks = ref.watch(studentReleasedMarksProvider(id));
    return RefreshIndicator(
      onRefresh: () async {
        ref.invalidate(studentReleasedMarksProvider(id));
        await ref.read(studentReleasedMarksProvider(id).future);
      },
      child: marks.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _Message(
          icon: Icons.error_outline,
          message: 'releasedMarks.error'.tr(),
          onRetry: () => ref.invalidate(studentReleasedMarksProvider(id)),
        ),
        data: (periods) {
          final entries = releasedMarkEntries(periods);
          if (entries.isEmpty) {
            return _Message(
              icon: Icons.fact_check_outlined,
              title: 'releasedMarks.emptyTitle'.tr(),
              message: 'releasedMarks.empty'.tr(),
            );
          }
          return _MarksList(periods: periods, latest: entries.first);
        },
      ),
    );
  }
}

class _MarksList extends StatelessWidget {
  const _MarksList({required this.periods, required this.latest});

  final List<ReleasedMarkPeriod> periods;
  final ReleasedMarkEntry latest;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final showYears = periods.map((p) => p.academicYearId).toSet().length > 1;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(
        AppSpacing.space16,
      ).withBottomInset(context),
      children: [
        _LatestMarkHero(entry: latest),
        for (final (index, period) in periods.indexed) ...[
          const SizedBox(height: AppSpacing.space24),
          if (showYears &&
              (index == 0 ||
                  periods[index - 1].academicYearId != period.academicYearId))
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space4),
              child: Text(
                period.academicYearName,
                style: theme.textTheme.labelLarge?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          AppSectionHeader(
            title: _periodName(period),
            icon: period.isAnnual
                ? Icons.event_available_outlined
                : Icons.date_range_outlined,
            accent: AppAccent.indigo,
            badgeSize: 32,
          ),
          const SizedBox(height: AppSpacing.space12),
          for (final subject in period.subjects) ...[
            _SubjectMarksCard(subject: subject),
            const SizedBox(height: AppSpacing.space12),
          ],
        ],
      ],
    );
  }
}

String _periodName(ReleasedMarkPeriod period) =>
    period.termName ?? 'releasedMarks.annual'.tr();

/// The most recently released mark, as the screen's headline.
class _LatestMarkHero extends StatelessWidget {
  const _LatestMarkHero({required this.entry});

  final ReleasedMarkEntry entry;

  @override
  Widget build(BuildContext context) {
    final attempt = entry.assessment.latestAttempt!;
    return AppHeroCard(
      key: const ValueKey('released-marks-latest'),
      icon: Icons.fact_check_outlined,
      accent: AppAccent.indigo,
      eyebrow: 'releasedMarks.latest'.tr(),
      title: entry.assessment.name,
      subtitle: 'releasedMarks.subjectInPeriod'.tr(
        namedArgs: {
          'subject': entry.subject.name,
          'period': _periodName(entry.period),
        },
      ),
      trailing: Text(
        releasedMarkValue(entry.assessment, attempt),
        textDirection: _isScore(attempt) ? TextDirection.ltr : null,
        style: Theme.of(context).textTheme.titleLarge?.copyWith(
          color: AppHeroCard.foreground,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _SubjectMarksCard extends StatelessWidget {
  const _SubjectMarksCard({required this.subject});

  final ReleasedMarkSubject subject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final visual = SubjectVisuals.of(subject.name, fallbackKey: subject.id);
    final approvedAt = subject.approvedAt;

    return AppSectionCard(
      title: subject.name,
      icon: visual.icon,
      accent: visual.accent,
      subtitle: subject.periodApproved && approvedAt != null
          ? 'releasedMarks.approvedOn'.tr(
              namedArgs: {'date': _date(context, approvedAt)},
            )
          : null,
      trailing: subject.periodApproved
          ? null
          : AppStatusPill(
              key: ValueKey('released-marks-partial-${subject.id}'),
              label: 'releasedMarks.moreToCome'.tr(),
              tone: AppTone.info,
              icon: Icons.schedule,
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (index, category) in subject.categories.indexed) ...[
            if (index > 0) const Divider(height: AppSpacing.space16),
            Text(
              category.name,
              style: theme.textTheme.labelLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            for (final assessment in category.assessments)
              for (final attempt in assessment.attempts)
                ReleasedMarkTile(assessment: assessment, attempt: attempt),
          ],
          if (!subject.periodApproved) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              'releasedMarks.partial'.tr(),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A card listing a student's newest released marks, each with its subject, linking to the full
/// list. [onSeeAll] opens it (the student's Grades tab, or the marks screen for a parent's child).
///
/// With [recentOnly] it lists only marks released within [releasedMarksRecentWindow] and
/// disappears entirely when there are none, or while it loads or fails: the student home's
/// "New exam marks" card, which should never take space for nothing. Otherwise it always shows,
/// with an empty or error state of its own (a parent's Grades tab).
class ReleasedMarksSummaryCard extends ConsumerWidget {
  const ReleasedMarksSummaryCard({
    required this.studentId,
    required this.onSeeAll,
    this.titleKey = 'releasedMarks.title',
    this.maxItems = 4,
    this.recentOnly = false,
    this.now,
    this.margin = EdgeInsets.zero,
    super.key,
  });

  final String studentId;
  final VoidCallback onSeeAll;
  final String titleKey;
  final int maxItems;
  final bool recentOnly;

  /// The clock for [recentOnly] (tests); defaults to the current time.
  final DateTime? now;

  /// Space around the card when it shows (none when a [recentOnly] card hides itself).
  final EdgeInsetsGeometry margin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final marks = ref.watch(studentReleasedMarksProvider(studentId));

    Widget card(Widget child, {Widget? trailing}) => Padding(
      padding: margin,
      child: AppSectionCard(
        key: ValueKey('released-marks-summary-$studentId'),
        title: titleKey.tr(),
        icon: Icons.fact_check_outlined,
        accent: AppAccent.indigo,
        trailing: trailing,
        child: child,
      ),
    );

    return marks.when(
      skipLoadingOnRefresh: true,
      loading: () => recentOnly
          ? const SizedBox.shrink()
          : card(
              const Padding(
                padding: EdgeInsets.all(AppSpacing.space8),
                child: Center(child: CircularProgressIndicator()),
              ),
            ),
      error: (_, _) => recentOnly
          ? const SizedBox.shrink()
          : card(
              AppEmptyState(
                compact: true,
                icon: Icons.error_outline,
                accent: AppTone.danger.accent,
                message: 'releasedMarks.error'.tr(),
                action: TextButton(
                  onPressed: () =>
                      ref.invalidate(studentReleasedMarksProvider(studentId)),
                  child: Text('releasedMarks.retry'.tr()),
                ),
              ),
            ),
      data: (periods) {
        var entries = releasedMarkEntries(periods);
        if (recentOnly) {
          final since = (now ?? DateTime.now()).subtract(
            releasedMarksRecentWindow,
          );
          entries = [
            for (final entry in entries)
              if (entry.assessment.releasedAt?.isAfter(since) ?? false) entry,
          ];
          if (entries.isEmpty) return const SizedBox.shrink();
        }
        if (entries.isEmpty) {
          return card(
            AppEmptyState(
              compact: true,
              icon: Icons.fact_check_outlined,
              message: 'releasedMarks.empty'.tr(),
            ),
          );
        }
        final shown = entries.take(maxItems).toList();
        final partial = shown.any((entry) => !entry.subject.periodApproved);
        return card(
          trailing: AppStatusPill(
            label: '${entries.length}',
            tone: AppTone.brand,
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final entry in shown)
                _SummaryRow(entry: entry, onTap: onSeeAll),
              if (partial) ...[
                const SizedBox(height: AppSpacing.space4),
                Text(
                  'releasedMarks.moreToComeNote'.tr(),
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: TextButton(
                  onPressed: onSeeAll,
                  child: Text('releasedMarks.seeAll'.tr()),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.entry, required this.onTap});

  final ReleasedMarkEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final visual = SubjectVisuals.of(
      entry.subject.name,
      fallbackKey: entry.subject.id,
    );
    return ReleasedMarkTile(
      assessment: entry.assessment,
      attempt: entry.assessment.latestAttempt!,
      icon: visual.icon,
      accent: visual.accent,
      subtitle: 'releasedMarks.subjectInPeriod'.tr(
        namedArgs: {
          'subject': entry.subject.name,
          'period': _periodName(entry.period),
        },
      ),
      onTap: onTap,
    );
  }
}

/// A full-page message (loading aside) that keeps pull-to-refresh working.
class _Message extends StatelessWidget {
  const _Message({
    required this.icon,
    required this.message,
    this.title,
    this.onRetry,
  });

  final IconData icon;
  final String message;
  final String? title;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(
        AppSpacing.space24,
      ).withBottomInset(context),
      children: [
        const SizedBox(height: AppSpacing.space32),
        AppEmptyState(
          icon: icon,
          title: title,
          message: message,
          accent: AppEmptyState.accentForIcon(icon),
          action: onRetry == null
              ? null
              : OutlinedButton(
                  onPressed: onRetry,
                  child: Text('releasedMarks.retry'.tr()),
                ),
        ),
      ],
    );
  }
}
