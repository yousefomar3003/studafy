import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/announcement.dart';
import '../../../core/api/generated/models/discipline_incident.dart';
import '../../../design/kit/kit.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../custom_lists/presentation/linked_custom_lists_section.dart';
import '../application/teacher_providers.dart';
import 'class_announcement_composer_screen.dart';
import 'grade_entry_screen.dart';
import 'incident_report_screen.dart';
import 'predicted_grades_screen.dart';
import 'teacher_content_screen.dart';
import 'widgets/roster_entry_tile.dart';

/// A class the signed-in teacher leads: its course, roster size, and the enrolled students.
///
/// Reached by pushing a route from the classes list or from a today's-session row, so it owns
/// its own [Scaffold]/[AppBar] (unlike the shell-tab screens). [classCode] is passed straight
/// through for the title so the header renders before the roster request resolves.
class TeacherClassDetailScreen extends ConsumerWidget {
  const TeacherClassDetailScreen({
    required this.classId,
    required this.classCode,
    super.key,
  });

  final String classId;
  final String classCode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Resolve roster names for this class (see classRosterNamesProvider).
    ref.watch(classRosterNamesProvider(classId));
    final roster = ref.watch(classRosterProvider(classId));
    final courseName = ref.watch(classCourseNameProvider(classId));

    return Scaffold(
      appBar: AppBar(
        title: Text(classCode),
        actions: [
          IconButton(
            icon: const Icon(Icons.library_books_outlined),
            tooltip: 'teacher.content.open'.tr(),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => TeacherContentScreen(
                  classId: classId,
                  classCode: classCode,
                ),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.grading_outlined),
            tooltip: 'teacher.grades.open'.tr(),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) =>
                    GradeEntryScreen(classId: classId, classCode: classCode),
              ),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.campaign_outlined),
            tooltip: 'teacher.communication.announce.title'.tr(),
            onPressed: () => _composeAnnouncement(context),
          ),
          IconButton(
            icon: const Icon(Icons.flag_outlined),
            tooltip: 'teacher.communication.incident.title'.tr(),
            onPressed: () => _reportIncident(context),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => ref.invalidate(classRosterProvider(classId)),
        child: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.all(AppSpacing.space16),
              sliver: SliverList.list(
                children: [
                  courseName.maybeWhen(
                    data: (name) => _ClassHero(
                      classId: classId,
                      courseName: name,
                      rosterSize: roster.value?.length,
                    ),
                    orElse: () => const SizedBox.shrink(),
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  _PredictedGradesTile(classId: classId, classCode: classCode),
                  const SizedBox(height: AppSpacing.space8),
                  // The class's rows in the school's custom lists (a bus group, a homeroom); takes
                  // no space when there are none.
                  LinkedCustomListsSection(
                    subjectKind: 'class',
                    subjectId: classId,
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  AppSectionHeader(
                    title: 'teacher.class.rosterTitle'.tr(),
                    icon: Icons.groups_outlined,
                    accent: AppAccent.slate,
                    badgeSize: 32,
                  ),
                  const SizedBox(height: AppSpacing.space8),
                ],
              ),
            ),
            roster.when(
              loading: () => const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: Padding(
                    padding: EdgeInsets.only(top: AppSpacing.space32),
                    child: CircularProgressIndicator(),
                  ),
                ),
              ),
              error: (error, stackTrace) => const SliverToBoxAdapter(
                child: _Message(
                  icon: Icons.error_outline,
                  messageKey: 'teacher.class.rosterError',
                ),
              ),
              data: (enrollments) {
                if (enrollments.isEmpty) {
                  return const SliverToBoxAdapter(
                    child: _Message(
                      icon: Icons.group_off_outlined,
                      messageKey: 'teacher.class.rosterEmpty',
                    ),
                  );
                }
                // Builder (lazily built) so a full class only materialises the rows the
                // viewport sees — a 60-student roster otherwise builds every tile on each
                // rebuild of this screen (tab switch, any provider invalidation).
                return SliverPadding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space16,
                  ),
                  sliver: SliverList.builder(
                    itemCount: enrollments.length,
                    itemBuilder: (context, index) =>
                        RosterEntryTile(enrollment: enrollments[index]),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _composeAnnouncement(BuildContext context) async {
    final announcement = await Navigator.of(context).push<Announcement>(
      MaterialPageRoute(
        builder: (_) => ClassAnnouncementComposerScreen(
          classId: classId,
          classCode: classCode,
        ),
      ),
    );
    if (announcement == null || !context.mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text(
            'teacher.communication.announce.sent'.tr(
              namedArgs: {'count': '${announcement.recipientCount}'},
            ),
          ),
        ),
      );
  }

  Future<void> _reportIncident(BuildContext context) async {
    final incident = await Navigator.of(context).push<DisciplineIncident>(
      MaterialPageRoute(
        builder: (_) =>
            IncidentReportScreen(classId: classId, classCode: classCode),
      ),
    );
    if (incident == null || !context.mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(content: Text('teacher.communication.incident.sent'.tr())),
      );
  }
}

/// The class's subject-coloured hero: its subject icon, course name and, once the roster has
/// loaded, its size. (The class code is already the app bar title.)
class _ClassHero extends StatelessWidget {
  const _ClassHero({
    required this.classId,
    required this.courseName,
    required this.rosterSize,
  });

  final String classId;
  final String courseName;
  final int? rosterSize;

  @override
  Widget build(BuildContext context) {
    final visual = SubjectVisuals.of(courseName, fallbackKey: classId);
    return AppHeroCard(
      accent: visual.accent,
      icon: visual.icon,
      title: courseName,
      subtitle: rosterSize == null
          ? null
          : 'teacher.classes.roster'.tr(
              namedArgs: {'count': '$rosterSize'},
            ),
    );
  }
}

/// Opens [PredictedGradesScreen] for the class's section and subject. Always offered: the screen
/// itself explains when the class has no section or the school has not switched predicted grades
/// on, so this row costs no request until it is tapped.
class _PredictedGradesTile extends StatelessWidget {
  const _PredictedGradesTile({required this.classId, required this.classCode});

  final String classId;
  final String classCode;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: const Icon(Icons.insights_outlined),
        title: Text('teacher.predicted.entry'.tr()),
        subtitle: Text('teacher.predicted.entrySubtitle'.tr()),
        trailing: const Icon(Icons.chevron_right),
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                PredictedGradesScreen(classId: classId, classCode: classCode),
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space8),
      child: AppEmptyState(
        icon: icon,
        message: messageKey.tr(),
        accent: icon == Icons.error_outline
            ? AppTone.danger.accent
            : AppAccent.slate,
      ),
    );
  }
}
