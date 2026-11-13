import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../design/layout/bottom_inset_padding.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../custom_lists/application/custom_lists_providers.dart';
import '../../custom_lists/presentation/student_custom_lists_screen.dart';
import '../../messaging/application/messaging_providers.dart';
import '../../messaging/domain/messaging.dart';
import '../../messaging/presentation/chat_screen.dart';
import '../../parent/presentation/widgets/child_detail_placeholders.dart';
import '../../shell/application/shell_providers.dart';
import '../application/student_overview_providers.dart';
import '../domain/student_overview.dart';

/// The teacher's page for one student of one class they teach: the student's marks and result in
/// this subject (in the grade's result format), attendance in this class this term, homework
/// handed in and missing, the report-card comments, the parents (with a chat button) and the
/// school's record fields visible to teachers. Sensitive record fields never reach this screen —
/// the API leaves them out. The school's custom lists about the student stay one tap away.
class TeacherStudentScreen extends ConsumerWidget {
  const TeacherStudentScreen({
    required this.classId,
    required this.studentId,
    required this.studentName,
    super.key,
  });

  final String classId;
  final String studentId;

  /// Shown in the app bar while the page loads.
  final String studentName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final key = (classId: classId, studentId: studentId);
    final overview = ref.watch(studentOverviewProvider(key));

    Future<void> onRefresh() async {
      ref.invalidate(studentOverviewProvider(key));
      ref.invalidate(teacherMessagingContactsProvider);
      try {
        await ref.read(studentOverviewProvider(key).future);
      } on Object {
        // Surfaced by the page itself.
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(overview.value?.fullName ?? studentName)),
      body: RefreshIndicator(
        onRefresh: onRefresh,
        child: overview.when(
          skipLoadingOnRefresh: true,
          loading: () => const ChildDetailSkeleton(),
          error: (_, _) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            children: const [
              ChildDetailMessage(
                messageKey: 'teacher.student.error',
                icon: Icons.error_outline,
              ),
            ],
          ),
          data: (data) => ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(
              AppSpacing.space16,
            ).withBottomInset(context),
            children: [
              _Header(overview: data),
              const SizedBox(height: AppSpacing.space16),
              _MarksCard(overview: data),
              _AttendanceCard(attendance: data.attendance),
              _HomeworkCard(homework: data.homework),
              _CommentsCard(comments: data.comments),
              _ParentsCard(studentId: data.studentId),
              if (data.records.isNotEmpty) _RecordsCard(records: data.records),
              if (canUseCustomLists(ref.watch(sessionRolesProvider)))
                _Section(
                  titleKey: 'teacher.student.lists.title',
                  icon: Icons.list_alt_outlined,
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('teacher.student.lists.open'.tr()),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => StudentCustomListsScreen(
                          studentId: data.studentId,
                          studentName: data.fullName,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A number without a trailing ".0", at most two decimals, in the reader's locale.
String _fmt(BuildContext context, num value) =>
    NumberFormat('#,##0.##', context.locale.toString()).format(value);

class _Header extends StatelessWidget {
  const _Header({required this.overview});

  final StudentOverview overview;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final classLine = [
      overview.classCode,
      overview.subjectName,
      ?overview.sectionName,
      overview.termName,
    ].where((part) => part.isNotEmpty).join(' · ');
    return Row(
      children: [
        CircleAvatar(
          radius: 24,
          backgroundColor: theme.colorScheme.secondaryContainer,
          foregroundColor: theme.colorScheme.onSecondaryContainer,
          child: Text(
            overview.fullName.isEmpty
                ? '#'
                : overview.fullName.characters.first.toUpperCase(),
            style: theme.textTheme.titleMedium,
          ),
        ),
        const SizedBox(width: AppSpacing.space12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(overview.fullName, style: theme.textTheme.titleMedium),
              if (overview.admissionNumber.isNotEmpty)
                Text(
                  'teacher.student.admissionNumber'.tr(
                    namedArgs: {'number': overview.admissionNumber},
                  ),
                  style: muted,
                ),
              if (classLine.isNotEmpty) Text(classLine, style: muted),
            ],
          ),
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.titleKey,
    required this.icon,
    required this.child,
  });

  final String titleKey;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.space12),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: theme.colorScheme.primary),
                const SizedBox(width: AppSpacing.space8),
                Expanded(
                  child: Text(titleKey.tr(), style: theme.textTheme.titleSmall),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            child,
          ],
        ),
      ),
    );
  }
}

class _Muted extends StatelessWidget {
  const _Muted(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      text,
      style: theme.textTheme.bodyMedium?.copyWith(
        color: theme.colorScheme.onSurfaceVariant,
      ),
    );
  }
}

class _MarksCard extends StatelessWidget {
  const _MarksCard({required this.overview});

  final StudentOverview overview;

  @override
  Widget build(BuildContext context) {
    final marks = overview.marks;
    return _Section(
      titleKey: 'teacher.student.marks.title',
      icon: Icons.grade_outlined,
      child: marks == null
          ? _Muted(
              'teacher.student.marks.unavailable.${overview.marksUnavailable ?? 'not_configured'}'
                  .tr(),
            )
          : _MarksBody(marks: marks),
    );
  }
}

class _MarksBody extends StatelessWidget {
  const _MarksBody({required this.marks});

  final StudentMarks marks;

  String? _result(BuildContext context) {
    final value = marks.displayValue;
    if (marks.descriptive) return marks.gradeLabel;
    if (value == null) return null;
    return switch (marks.resultFormat) {
      'out_of' => 'teacher.student.marks.outOf'.tr(
        namedArgs: {
          'value': _fmt(context, value),
          'max': _fmt(context, marks.resultScaleMax),
        },
      ),
      'gpa' => 'teacher.student.marks.gpa'.tr(
        namedArgs: {
          'value': _fmt(context, value),
          'max': _fmt(context, marks.resultScaleMax),
        },
      ),
      _ => 'teacher.student.marks.percent'.tr(
        namedArgs: {'value': _fmt(context, value)},
      ),
    };
  }

  String _assessmentValue(BuildContext context, StudentAssessmentMark mark) {
    if (mark.status != 'graded') {
      return 'teacher.student.marks.status.${mark.status}'.tr();
    }
    if (mark.descriptorLabel != null) return mark.descriptorLabel!;
    final score = mark.score;
    if (score == null) return 'teacher.student.marks.status.pending'.tr();
    return '${_fmt(context, score)} / ${_fmt(context, mark.maxMarks)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (marks.exempt) return _Muted('teacher.student.marks.exempt'.tr());
    final result = _result(context);
    final passed = marks.passed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: AppSpacing.space8,
          runSpacing: AppSpacing.space8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              result ?? 'teacher.student.marks.noResult'.tr(),
              style: result == null
                  ? theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    )
                  : theme.textTheme.headlineSmall,
            ),
            if (!marks.descriptive && marks.gradeLabel != null)
              Chip(label: Text(marks.gradeLabel!)),
            if (!marks.complete && result != null)
              Chip(label: Text('teacher.student.marks.provisional'.tr())),
            if (passed != null)
              Chip(
                label: Text(
                  passed
                      ? 'teacher.student.marks.passed'.tr()
                      : 'teacher.student.marks.failed'.tr(),
                ),
              ),
          ],
        ),
        if (!marks.descriptive && marks.termPercentage != null) ...[
          const SizedBox(height: AppSpacing.space4),
          _Muted(
            'teacher.student.marks.thisTerm'.tr(
              namedArgs: {'value': _fmt(context, marks.termPercentage!)},
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.space8),
        if (marks.assessments.isEmpty)
          _Muted('teacher.student.marks.noAssessments'.tr())
        else
          for (final mark in marks.assessments)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.space4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(mark.name, style: theme.textTheme.bodyMedium),
                  ),
                  const SizedBox(width: AppSpacing.space8),
                  Text(
                    _assessmentValue(context, mark),
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
            ),
      ],
    );
  }
}

class _Count extends StatelessWidget {
  const _Count({required this.labelKey, required this.value});

  final String labelKey;
  final int value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Text('$value', style: theme.textTheme.titleLarge),
        Text(
          labelKey.tr(),
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _AttendanceCard extends StatelessWidget {
  const _AttendanceCard({required this.attendance});

  final StudentAttendance attendance;

  @override
  Widget build(BuildContext context) {
    final dates = DateFormat.yMMMd(context.locale.toString());
    return _Section(
      titleKey: 'teacher.student.attendance.title',
      icon: Icons.fact_check_outlined,
      child: attendance.sessions == 0
          ? _Muted('teacher.student.attendance.none'.tr())
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _Count(
                      labelKey: 'teacher.student.attendance.present',
                      value: attendance.present + attendance.remote,
                    ),
                    _Count(
                      labelKey: 'teacher.student.attendance.absent',
                      value: attendance.absent,
                    ),
                    _Count(
                      labelKey: 'teacher.student.attendance.late',
                      value: attendance.late,
                    ),
                    _Count(
                      labelKey: 'teacher.student.attendance.excused',
                      value: attendance.excused,
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.space8),
                _Muted(
                  'teacher.student.attendance.sessions'.tr(
                    namedArgs: {'count': '${attendance.sessions}'},
                  ),
                ),
                for (final entry in attendance.recent)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.space4),
                    child: Text(
                      [
                        if (entry.date != null) dates.format(entry.date!),
                        entry.late
                            ? (entry.minutesLate == null
                                  ? 'teacher.student.attendance.late'.tr()
                                  : 'teacher.student.attendance.lateMinutes'.tr(
                                      namedArgs: {
                                        'minutes': '${entry.minutesLate}',
                                      },
                                    ))
                            : 'teacher.student.attendance.absent'.tr(),
                      ].join(' — '),
                    ),
                  ),
              ],
            ),
    );
  }
}

class _HomeworkCard extends StatelessWidget {
  const _HomeworkCard({required this.homework});

  final StudentHomework homework;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final dates = DateFormat.yMMMd(context.locale.toString());
    return _Section(
      titleKey: 'teacher.student.homework.title',
      icon: Icons.assignment_outlined,
      child: homework.total == 0
          ? _Muted('teacher.student.homework.none'.tr())
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _Count(
                      labelKey: 'teacher.student.homework.handedIn',
                      value: homework.handedIn,
                    ),
                    _Count(
                      labelKey: 'teacher.student.homework.missing',
                      value: homework.missing,
                    ),
                    _Count(
                      labelKey: 'teacher.student.homework.upcoming',
                      value: homework.upcoming,
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.space8),
                for (final item in homework.items)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    title: Text(item.title),
                    subtitle: item.dueAt == null
                        ? null
                        : Text(
                            'teacher.student.homework.due'.tr(
                              namedArgs: {
                                'date': dates.format(item.dueAt!.toLocal()),
                              },
                            ),
                          ),
                    trailing: Text(
                      item.score != null
                          ? '${_fmt(context, item.score!)} / ${_fmt(context, item.maxScore)}'
                          : 'teacher.student.homework.status.${item.status}'
                                .tr(),
                      style: item.status == 'missing'
                          ? theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.error,
                            )
                          : theme.textTheme.bodyMedium,
                    ),
                  ),
              ],
            ),
    );
  }
}

class _CommentsCard extends StatelessWidget {
  const _CommentsCard({required this.comments});

  final StudentComments comments;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Widget entry(String labelKey, String text) => Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            labelKey.tr(),
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Text(text),
        ],
      ),
    );
    return _Section(
      titleKey: 'teacher.student.comments.title',
      icon: Icons.rate_review_outlined,
      child: comments.isEmpty
          ? _Muted('teacher.student.comments.none'.tr())
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (comments.termSubjectComment != null)
                  entry(
                    'teacher.student.comments.term',
                    comments.termSubjectComment!,
                  ),
                if (comments.annualSubjectComment != null)
                  entry(
                    'teacher.student.comments.annual',
                    comments.annualSubjectComment!,
                  ),
                if (comments.termTeacherComment != null)
                  entry(
                    'teacher.student.comments.classTeacher',
                    comments.termTeacherComment!,
                  ),
              ],
            ),
    );
  }
}

/// The student's parents the teacher can message, from the same list the "New message" screen
/// uses (`GET /api/messaging/teacher-contacts`), so who may be messaged is decided in one place.
class _ParentsCard extends ConsumerStatefulWidget {
  const _ParentsCard({required this.studentId});

  final String studentId;

  @override
  ConsumerState<_ParentsCard> createState() => _ParentsCardState();
}

class _ParentsCardState extends ConsumerState<_ParentsCard> {
  /// The parent whose conversation is being opened, to show progress and ignore further taps.
  String? _opening;

  Future<void> _chat(TeacherMessagingParent parent) async {
    if (_opening != null) return;
    setState(() => _opening = parent.parentId);
    final client = ref.read(messagingClientProvider);
    try {
      final existing = parent.conversationId;
      final conversation = existing != null
          ? await client.getConversation(existing)
          : await client.startTeacherConversation(
              studentId: widget.studentId,
              parentId: parent.parentId,
            );
      if (!mounted) return;
      setState(() => _opening = null);
      await openChat(
        context,
        ref,
        conversation: conversation,
        viewer: MessagingViewer.teacher,
      );
      ref.invalidate(teacherMessagingContactsProvider);
    } on Object {
      if (!mounted) return;
      setState(() => _opening = null);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('messaging.contacts.startError'.tr())),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final contacts = ref.watch(teacherMessagingContactsProvider);
    final parents = contacts.value
        ?.where((student) => student.id == widget.studentId)
        .expand((student) => student.parents)
        .toList();
    return _Section(
      titleKey: 'teacher.student.parents.title',
      icon: Icons.family_restroom_outlined,
      child: switch (contacts) {
        AsyncValue(hasValue: true) when parents!.isEmpty => _Muted(
          'teacher.student.parents.none'.tr(),
        ),
        AsyncValue(hasValue: true) => Column(
          children: [
            for (final parent in parents!)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(
                  child: Text(
                    parent.name.isEmpty
                        ? '#'
                        : parent.name.characters.first.toUpperCase(),
                  ),
                ),
                title: Text(parent.name),
                subtitle: Text(parent.relationshipKey.tr()),
                trailing: _opening == parent.parentId
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : IconButton(
                        tooltip: 'teacher.student.parents.message'.tr(),
                        icon: const Icon(Icons.chat_bubble_outline),
                        onPressed: _opening == null
                            ? () => _chat(parent)
                            : null,
                      ),
                onTap: _opening == null ? () => _chat(parent) : null,
              ),
          ],
        ),
        AsyncValue(hasError: true) => _Muted(
          'teacher.student.parents.error'.tr(),
        ),
        _ => const LinearProgressIndicator(),
      },
    );
  }
}

class _RecordsCard extends StatelessWidget {
  const _RecordsCard({required this.records});

  final List<StudentRecordField> records;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final arabic = context.locale.languageCode == 'ar';
    return _Section(
      titleKey: 'teacher.student.records.title',
      icon: Icons.info_outline,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final record in records)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.space8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    record.label(arabic),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  Text(record.value(arabic)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
