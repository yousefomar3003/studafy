import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/kit/kit.dart';
import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../domain/recent_grades.dart';
import 'released_marks_widgets.dart';

/// How each [GradeKind] looks wherever grades show — the home's "Recent grades", the Grades
/// screen's tabs, a parent's Grades tab — so an exam mark and an assignment grade never read alike.
extension GradeKindVisuals on GradeKind {
  IconData get icon => switch (this) {
    GradeKind.exam => Icons.fact_check_outlined,
    GradeKind.assignment => Icons.assignment_turned_in_outlined,
  };

  AppAccent get accent => switch (this) {
    GradeKind.exam => AppAccent.indigo,
    GradeKind.assignment => AppAccent.emerald,
  };

  /// One item: "Exam" / "Assignment".
  String get label => switch (this) {
    GradeKind.exam => 'grades.kind.exam',
    GradeKind.assignment => 'grades.kind.assignment',
  }.tr();

  /// The whole section: "Exams" / "Assignments".
  String get sectionLabel => switch (this) {
    GradeKind.exam => 'grades.sections.exams',
    GradeKind.assignment => 'grades.sections.assignments',
  }.tr();
}

/// A small chip naming a mark's kind ("Exam", "Assignment") in that kind's colour, with its icon.
class GradeKindChip extends StatelessWidget {
  const GradeKindChip({required this.kind, super.key});

  final GradeKind kind;

  @override
  Widget build(BuildContext context) {
    final colors = kind.accent.colorsOf(context);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: DecoratedBox(
        decoration: BoxDecoration(color: colors.container, borderRadius: AppRadius.fullRadius),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            AppSpacing.space8 - 2,
            2,
            AppSpacing.space8,
            2,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(kind.icon, size: 12, color: colors.onContainer),
              const SizedBox(width: AppSpacing.space4),
              Text(
                kind.label,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: colors.onContainer,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A tab label led by its kind's icon ("Exams", "Assignments"), for the Grades screen's tab bar.
class GradeKindTab extends StatelessWidget {
  const GradeKindTab({required this.kind, this.label, super.key});

  final GradeKind kind;

  /// The tab's text; the kind's [GradeKindVisuals.sectionLabel] when null.
  final String? label;

  @override
  Widget build(BuildContext context) {
    return Tab(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(kind.icon, size: 18),
          const SizedBox(width: AppSpacing.space8),
          Flexible(child: Text(label ?? kind.sectionLabel, overflow: TextOverflow.ellipsis)),
        ],
      ),
    );
  }
}

/// One "Recent grades" row: led by its kind's badge, the exam or assignment name over its subject,
/// the mark as a tinted pill, and the kind chip underneath.
class RecentGradeTile extends StatelessWidget {
  const RecentGradeTile({required this.item, this.onTap, super.key});

  final RecentGrade item;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final kind = item.kind;
    final chip = GradeKindChip(kind: kind);
    return switch (item) {
      RecentExamMark(:final entry) => ReleasedMarkEntryTile(
        entry: entry,
        icon: kind.icon,
        accent: kind.accent,
        footer: chip,
        onTap: onTap,
      ),
      RecentAssignmentGrade(:final grade) => AssignmentGradeTile(
        label: grade.label,
        subtitle: grade.course.name,
        score: grade.score,
        maxScore: grade.maxScore,
        percentage: grade.percentage,
        onTap: onTap,
      ),
    };
  }
}

/// A published assignment grade as a "Recent grades" row: the assignment kind's badge, [label]
/// over [subtitle], "18/20" as a pill tinted by [percentage], and the "Assignment" chip.
class AssignmentGradeTile extends StatelessWidget {
  const AssignmentGradeTile({
    required this.label,
    required this.subtitle,
    required this.score,
    required this.maxScore,
    this.percentage,
    this.onTap,
    super.key,
  });

  final String label;
  final String subtitle;
  final num? score;
  final num maxScore;

  /// For the pill's tint; worked out from [score] and [maxScore] when not given.
  final num? percentage;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    const kind = GradeKind.assignment;
    final score = this.score;
    final percent = percentage ?? (score == null || maxScore <= 0 ? null : score / maxScore * 100);
    return AppIconListTile(
      icon: kind.icon,
      accent: kind.accent,
      title: label,
      subtitle: subtitle,
      trailing: AppStatusPill(
        label: score == null ? '—' : '$score/$maxScore',
        tone: score == null ? AppTone.neutral : AppTone.forPercentage(percent),
      ),
      footer: const GradeKindChip(kind: kind),
      onTap: onTap,
    );
  }
}

/// The newest [maxItems] of [items] as [RecentGradeTile]s; [onTap] decides where each opens (none
/// when it returns null).
class RecentGradesList extends StatelessWidget {
  const RecentGradesList({required this.items, this.maxItems = 4, this.onTap, super.key});

  final List<RecentGrade> items;
  final int maxItems;
  final VoidCallback? Function(RecentGrade item)? onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final item in items.take(maxItems))
          RecentGradeTile(item: item, onTap: onTap?.call(item)),
      ],
    );
  }
}
