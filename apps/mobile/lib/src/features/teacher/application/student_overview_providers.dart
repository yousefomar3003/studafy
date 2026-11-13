import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/student_overview_client.dart';
import '../domain/student_overview.dart';

final studentOverviewClientProvider = Provider<StudentOverviewClient>((ref) {
  return StudentOverviewClient(authenticatedDio(ref));
});

/// A class the teacher teaches and one student enrolled in it.
typedef StudentOverviewKey = ({String classId, String studentId});

/// The teacher's student page for one class. Not offline-cached: it is read on demand, and the
/// school's record fields in it should not linger on the device.
final studentOverviewProvider = FutureProvider.autoDispose
    .family<StudentOverview, StudentOverviewKey>((ref, key) {
      return ref
          .watch(studentOverviewClientProvider)
          .fetch(key.classId, key.studentId);
    });
