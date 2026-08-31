import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/features/student/domain/upcoming_exams.dart';

Exam _exam({
  required String id,
  required String classId,
  required DateTime startsAt,
  Duration duration = const Duration(hours: 1),
  String status = 'scheduled',
}) {
  return Exam.fromJson({
    'id': id,
    'school_id': 'school-1',
    'class_id': classId,
    'created_by_user_id': 'user-1',
    'last_edited_by_user_id': 'user-1',
    'title': 'Exam $id',
    'description': null,
    'status': status,
    'starts_at': startsAt.toUtc().toIso8601String(),
    'ends_at': startsAt.add(duration).toUtc().toIso8601String(),
    'max_score': 100,
    'room_id': null,
    'weight': 1,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

void main() {
  final now = DateTime(2026, 9, 1, 12);

  test('groups upcoming exams by calendar day, days and exams both ascending', () {
    final agenda = assembleExamsAgenda(
      now: now,
      exams: [
        _exam(id: 'c', classId: 'class-1', startsAt: DateTime(2026, 9, 3, 9)),
        _exam(id: 'a', classId: 'class-1', startsAt: DateTime(2026, 9, 2, 13)),
        _exam(id: 'b', classId: 'class-2', startsAt: DateTime(2026, 9, 2, 9)),
      ],
    );

    expect(agenda.days.map((d) => d.date), [DateTime(2026, 9, 2), DateTime(2026, 9, 3)]);
    expect(agenda.days.first.exams.map((e) => e.id), ['b', 'a']);
    expect(agenda.days.last.exams.single.id, 'c');
  });

  test('drops cancelled and archived exams', () {
    final agenda = assembleExamsAgenda(
      now: now,
      exams: [
        _exam(id: 'live', classId: 'class-1', startsAt: DateTime(2026, 9, 5, 9)),
        _exam(
          id: 'gone',
          classId: 'class-1',
          startsAt: DateTime(2026, 9, 5, 11),
          status: 'cancelled',
        ),
        _exam(
          id: 'old',
          classId: 'class-1',
          startsAt: DateTime(2026, 9, 5, 13),
          status: 'archived',
        ),
      ],
    );

    expect(agenda.days.single.exams.map((e) => e.id), ['live']);
  });

  test('drops exams that already ended but keeps one in progress right now', () {
    final agenda = assembleExamsAgenda(
      now: now,
      exams: [
        _exam(
          id: 'finished',
          classId: 'class-1',
          startsAt: DateTime(2026, 9, 1, 8),
          duration: const Duration(hours: 1),
        ),
        _exam(
          id: 'ongoing',
          classId: 'class-1',
          startsAt: DateTime(2026, 9, 1, 11, 30),
          duration: const Duration(hours: 2),
        ),
      ],
    );

    expect(agenda.days.single.exams.map((e) => e.id), ['ongoing']);
  });

  test('an empty exam list assembles an empty agenda', () {
    final agenda = assembleExamsAgenda(now: now, exams: const []);

    expect(agenda.isEmpty, isTrue);
    expect(agenda.days, isEmpty);
  });
}
