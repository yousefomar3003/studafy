import '../../../core/api/generated/models/class.dart';
import '../../../core/api/generated/models/course.dart';

/// A class the signed-in teacher leads, enriched with its course and current roster size for the
/// classes list. The roster itself is loaded separately, per class, on the detail screen.
class TeacherClass {
  const TeacherClass({
    required this.classInfo,
    required this.course,
    required this.activeEnrollmentCount,
  });

  final Class classInfo;
  final Course course;
  final int activeEnrollmentCount;

  String get id => classInfo.id;

  String get code => classInfo.code;
}
