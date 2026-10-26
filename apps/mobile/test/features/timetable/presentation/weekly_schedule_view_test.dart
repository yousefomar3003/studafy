// `intl` (re-exported by easy_localization) declares its own `TextDirection`; these tests want
// Flutter's, for `Directionality`.
import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/offline/staleness_banner.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/timetable_screen.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_timetable_screen.dart';
import 'package:studafy_mobile/src/features/timetable/application/weekly_schedule_providers.dart';
import 'package:studafy_mobile/src/features/timetable/domain/weekly_schedule.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/weekly_schedule_view.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/widgets/lesson_card.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/widgets/schedule_section.dart';
import 'package:studafy_mobile/src/features/timetable/presentation/widgets/timetable_placeholders.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

/// SCI101-A meets Monday and Wednesday period 1; MATH101-A meets Monday period 2.
final _slots = [
  scheduleSlot(weekday: 1, period: 2, classId: 'math', roomId: 'room-2'),
  scheduleSlot(weekday: 1, period: 1, classId: 'sci'),
  scheduleSlot(weekday: 3, period: 1, classId: 'sci'),
];

/// The same week with grade sections: Science is Grade 10 Section C, Algebra Section D.
final _sectionedSlots = [
  scheduleSlot(
    weekday: 1,
    period: 2,
    classId: 'math',
    roomId: 'room-2',
    sectionId: 'sec-d',
    sectionName: 'D',
    gradeLevelName: 'Grade 10',
  ),
  for (final weekday in [1, 3])
    scheduleSlot(
      weekday: weekday,
      period: 1,
      classId: 'sci',
      sectionId: 'sec-c',
      sectionName: 'C',
      gradeLevelName: 'Grade 10',
    ),
];

/// A section label as rendered: each name in a first-strong isolate (see `schedule_section.dart`).
String _sectionLabel(String grade, String section, {String word = 'Section'}) =>
    '\u2068$grade\u2069 · $word \u2068$section\u2069';

/// Builds the schedule the way the providers do: the student's own section as the header, every
/// section as the teacher's filter choices.
AsyncValue<WeeklyScheduleStatus> _ready({
  List<TimetableSlot>? slots,
  bool stale = false,
  List<int> schoolDays = const [7, 1, 2, 3, 4],
  String? sectionFilter,
}) {
  final all = slots ?? _slots;
  final sections = scheduleSections(all);
  final filter = resolveSectionFilter(sections, sectionFilter);
  final schedule = buildWeeklySchedule(
    schoolDays: schoolDays,
    slots: slotsForSection(all, filter),
    section: predominantSection(all),
    sections: sections,
    sectionFilter: filter,
  );
  return AsyncData(
    WeeklyScheduleReady(stale ? cachedValue(schedule) : liveValue(schedule)),
  );
}

class _Harness {
  int versionBuilds = 0;
}

Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required AsyncValue<WeeklyScheduleStatus> status,
  ScheduleAudience audience = ScheduleAudience.student,
  DateTime? now,
  _Harness? harness,
}) async {
  final container = ProviderContainer(
    overrides: [
      if (audience == ScheduleAudience.student)
        studentWeeklyScheduleProvider.overrideWith((ref) => status)
      else
        teacherWeeklyScheduleProvider.overrideWith((ref) => status),
      scheduleClockProvider.overrideWithValue(() => now ?? scheduleMonday),
      scheduleClassLabelProvider.overrideWith(
        (ref, classId) async => switch (classId) {
          'sci' => (code: 'SCI101-A', courseName: 'Integrated Science'),
          _ => (code: 'MATH101-A', courseName: 'Algebra Foundations'),
        },
      ),
      timetableTeacherNameProvider.overrideWith(
        (ref, teacherId) => 'Layla Nasser',
      ),
      // The refresh path re-reads these; keep it off the network.
      approvedTimetableVersionProvider.overrideWith((ref) async {
        harness?.versionBuilds++;
        return null;
      }),
    ],
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: wrapWithLocalization(
        Builder(
          builder: (context) {
            return MaterialApp(
              theme: AppTheme.light,
              debugShowCheckedModeBanner: false,
              locale: context.locale,
              supportedLocales: context.supportedLocales,
              localizationsDelegates: context.localizationDelegates,
              home: Scaffold(
                body: audience == ScheduleAudience.student
                    ? const TimetableScreen()
                    : const TeacherTimetableScreen(),
              ),
            );
          },
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

/// ar.json is over the 50 KB threshold above which `rootBundle.loadString` decodes on a
/// background isolate, which never completes inside the test's fake-async zone — so the switch
/// runs in real async (same pattern as `locale_persistence_test.dart`).
Future<void> _switchToArabic(WidgetTester tester) async {
  final context = tester.element(find.byType(WeeklyScheduleView));
  await tester.runAsync(() => context.setLocale(const Locale('ar')));
  await tester.pumpAndSettle();
}

Finder _chip(String label) => find.descendant(
  of: find.byType(SingleChildScrollView),
  matching: find.text(label),
);

void main() {
  setUpAll(ensureDateFormattingInitialized);

  group('weekly schedule — English (LTR)', () {
    testWidgets(
      'chips follow the school week and today is preselected; no dates anywhere',
      (tester) async {
        await _pump(tester, status: _ready());

        for (final day in ['Sun', 'Mon', 'Tue', 'Wed', 'Thu']) {
          expect(_chip(day), findsOneWidget);
        }
        expect(_chip('Fri'), findsNothing);
        // Chip order is the school's order: Sunday first.
        expect(
          tester.getTopLeft(_chip('Sun')).dx,
          lessThan(tester.getTopLeft(_chip('Mon')).dx),
        );

        // Monday is today → its lessons, by period.
        final cards = tester.widgetList<LessonCard>(find.byType(LessonCard));
        expect(cards.map((card) => card.slot.period), [1, 2]);
        expect(find.text('Integrated Science'), findsOneWidget);
        expect(find.text('Algebra Foundations'), findsOneWidget);
        // Lessons carry no room, even when the slot still has a room id.
        expect(find.textContaining('Room'), findsNothing);
        expect(find.text('Layla Nasser'), findsNWidgets(2));
        expect(find.text('3 lessons a week'), findsOneWidget);

        // A fixed weekly schedule, not a calendar.
        expect(
          find.textContaining(RegExp(r'\b(Jan|Feb|Aug|Sep|Oct|20\d\d)\b')),
          findsNothing,
        );
        expect(find.textContaining('This week'), findsNothing);
      },
    );

    testWidgets('a teacher sees the class/section instead of a teacher name', (
      tester,
    ) async {
      await _pump(tester, status: _ready(), audience: ScheduleAudience.teacher);

      expect(find.text('SCI101-A'), findsOneWidget);
      expect(find.text('MATH101-A'), findsOneWidget);
      expect(find.text('Layla Nasser'), findsNothing);
    });

    testWidgets('a student\'s timetable is headed by their grade section', (
      tester,
    ) async {
      await _pump(tester, status: _ready(slots: _sectionedSlots));

      expect(find.text(_sectionLabel('Grade 10', 'C')), findsOneWidget);
      expect(
        find.bySemanticsLabel(
          'Grade and section: ${_sectionLabel('Grade 10', 'C')}',
        ),
        findsOneWidget,
      );
      // The header names the section; the student's cards don't repeat it, nor offer a filter.
      expect(find.text(_sectionLabel('Grade 10', 'D')), findsNothing);
      expect(find.byType(ChoiceChip), findsNothing);
    });

    testWidgets('no section header when the lessons carry no section', (
      tester,
    ) async {
      await _pump(tester, status: _ready());

      expect(find.byType(ScheduleSectionHeader), findsNothing);
    });

    testWidgets('a teacher\'s lessons are each labelled with their section', (
      tester,
    ) async {
      await _pump(
        tester,
        status: _ready(slots: _sectionedSlots),
        audience: ScheduleAudience.teacher,
      );

      expect(find.byType(ScheduleSectionHeader), findsNothing);
      final cards = find.byType(LessonCard);
      expect(
        find.descendant(
          of: cards,
          matching: find.text(_sectionLabel('Grade 10', 'C')),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: cards,
          matching: find.text(_sectionLabel('Grade 10', 'D')),
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'a teacher of several sections can filter the week by section',
      (tester) async {
        final container = await _pump(
          tester,
          status: _ready(slots: _sectionedSlots),
          audience: ScheduleAudience.teacher,
        );
        container.listen(teacherScheduleSectionFilterProvider, (_, _) {});

        final chips = tester.widgetList<ChoiceChip>(find.byType(ChoiceChip));
        expect(chips, hasLength(3));
        expect(chips.first.selected, isTrue);
        final all = find.widgetWithText(ChoiceChip, 'All');
        final sectionD = find.widgetWithText(
          ChoiceChip,
          _sectionLabel('Grade 10', 'D'),
        );
        expect(all, findsOneWidget);
        expect(sectionD, findsOneWidget);

        await tester.tap(sectionD);
        await tester.pumpAndSettle();
        expect(container.read(teacherScheduleSectionFilterProvider), 'sec-d');

        await tester.tap(all);
        await tester.pumpAndSettle();
        expect(container.read(teacherScheduleSectionFilterProvider), isNull);
      },
    );

    testWidgets('a filtered schedule marks its section chip selected', (
      tester,
    ) async {
      await _pump(
        tester,
        status: _ready(slots: _sectionedSlots, sectionFilter: 'sec-d'),
        audience: ScheduleAudience.teacher,
      );

      final selected = tester
          .widgetList<ChoiceChip>(find.byType(ChoiceChip))
          .where((chip) => chip.selected);
      expect(
        (selected.single.label as Text).data,
        _sectionLabel('Grade 10', 'D'),
      );
      expect(find.byType(LessonCard), findsOneWidget);
      expect(find.text('Algebra Foundations'), findsOneWidget);
    });

    testWidgets('no section filter for a teacher of a single section', (
      tester,
    ) async {
      await _pump(
        tester,
        status: _ready(
          slots: _sectionedSlots.where((s) => s.classId == 'sci').toList(),
        ),
        audience: ScheduleAudience.teacher,
      );

      expect(find.byType(ChoiceChip), findsNothing);
      expect(find.text(_sectionLabel('Grade 10', 'C')), findsOneWidget);
    });

    testWidgets(
      'tapping a chip shows that day; a free day shows a friendly empty state',
      (tester) async {
        await _pump(tester, status: _ready());

        await tester.tap(_chip('Wed'));
        await tester.pumpAndSettle();
        expect(find.byType(LessonCard), findsOneWidget);
        expect(find.text('Integrated Science'), findsOneWidget);

        await tester.tap(_chip('Tue'));
        await tester.pumpAndSettle();
        expect(find.byType(LessonCard), findsNothing);
        expect(find.text('No classes on Tuesday.'), findsOneWidget);
      },
    );

    testWidgets('swiping left moves to the next school day', (tester) async {
      await _pump(tester, status: _ready());

      await tester.fling(find.byType(PageView), const Offset(-300, 0), 1000);
      await tester.pumpAndSettle();

      expect(find.text('No classes on Tuesday.'), findsOneWidget);
    });

    testWidgets('opens on the first school day when today is not one', (
      tester,
    ) async {
      // 2026-08-28 is a Friday.
      await _pump(tester, status: _ready(), now: DateTime(2026, 8, 28));

      expect(find.text('No classes on Sunday.'), findsOneWidget);
    });

    testWidgets(
      'a schedule with no lessons at all shows the empty-schedule message',
      (tester) async {
        await _pump(tester, status: _ready(slots: const []));

        expect(
          find.text('There are no classes on your weekly schedule yet.'),
          findsOneWidget,
        );
        expect(find.byType(WeeklyScheduleView), findsNothing);
      },
    );

    testWidgets('shows the skeleton while loading', (tester) async {
      await _pump(tester, status: const AsyncLoading());
      expect(find.byType(TimetableSkeleton), findsOneWidget);
    });

    testWidgets('shows the unavailable message without an approved timetable', (
      tester,
    ) async {
      await _pump(tester, status: const AsyncData(WeeklyScheduleUnavailable()));
      expect(find.text("Your timetable isn't available yet."), findsOneWidget);
    });

    testWidgets('a cached schedule shows the staleness banner', (tester) async {
      await _pump(tester, status: _ready(stale: true));
      expect(find.byType(StalenessBanner), findsOneWidget);
    });

    testWidgets('re-selecting the Timetable tab re-syncs the schedule', (
      tester,
    ) async {
      final harness = _Harness();
      final container = await _pump(tester, status: _ready(), harness: harness);
      final before = harness.versionBuilds;

      container
          .read(selectedShellTabProvider.notifier)
          .select('shell.tabs.home');
      await tester.pumpAndSettle();
      expect(harness.versionBuilds, before);

      container
          .read(selectedShellTabProvider.notifier)
          .select('shell.tabs.timetable');
      await tester.pumpAndSettle();
      expect(harness.versionBuilds, greaterThan(before));
    });
  });

  group('weekly schedule — Arabic (RTL)', () {
    testWidgets('renders right-to-left with Arabic day names and strings', (
      tester,
    ) async {
      await _pump(tester, status: _ready());
      await _switchToArabic(tester);

      final direction = Directionality.of(
        tester.element(find.byType(WeeklyScheduleView)),
      );
      expect(direction, TextDirection.rtl);

      final sunday = DateFormat.E('ar').format(DateTime(2024, 1, 7));
      final monday = DateFormat.E('ar').format(DateTime(2024, 1, 1));
      expect(_chip(sunday), findsOneWidget);
      expect(_chip(monday), findsOneWidget);
      // RTL: the first school day (Sunday) sits at the right.
      expect(
        tester.getTopLeft(_chip(sunday)).dx,
        greaterThan(tester.getTopLeft(_chip(monday)).dx),
      );

      expect(find.text('الجدول الأسبوعي'), findsOneWidget);
      expect(find.textContaining('قاعة'), findsNothing);
      expect(find.byType(LessonCard), findsNWidgets(2));
    });

    testWidgets('the section header and filter read in Arabic', (tester) async {
      await _pump(tester, status: _ready(slots: _sectionedSlots));
      await _switchToArabic(tester);

      expect(
        find.text(_sectionLabel('Grade 10', 'C', word: 'الشعبة')),
        findsOneWidget,
      );
      // RTL: the header's icon leads from the right.
      final header = find.byType(ScheduleSectionHeader);
      expect(
        tester
            .getTopRight(
              find.descendant(of: header, matching: find.byType(Icon)),
            )
            .dx,
        greaterThan(
          tester
              .getTopRight(
                find.descendant(of: header, matching: find.byType(Text)),
              )
              .dx,
        ),
      );
    });

    testWidgets('a teacher\'s section chips are in Arabic', (tester) async {
      await _pump(
        tester,
        status: _ready(slots: _sectionedSlots),
        audience: ScheduleAudience.teacher,
      );
      await _switchToArabic(tester);

      expect(find.widgetWithText(ChoiceChip, 'الكل'), findsOneWidget);
      expect(
        find.widgetWithText(
          ChoiceChip,
          _sectionLabel('Grade 10', 'D', word: 'الشعبة'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('swiping right moves to the next school day', (tester) async {
      await _pump(tester, status: _ready());
      await _switchToArabic(tester);

      await tester.fling(find.byType(PageView), const Offset(300, 0), 1000);
      await tester.pumpAndSettle();

      final tuesday = DateFormat.EEEE('ar').format(DateTime(2024, 1, 2));
      expect(find.text('لا توجد حصص يوم $tuesday.'), findsOneWidget);
    });
  });
}
