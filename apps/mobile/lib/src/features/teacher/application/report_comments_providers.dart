import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../data/report_comments_client.dart';
import '../domain/report_comments.dart';

final reportCommentsClientProvider = Provider<ReportCommentsClient>((ref) {
  return ReportCommentsClient(authenticatedDio(ref));
});

/// A section, one of its subjects, and a period (null term = the annual report).
typedef ReportCommentsKey = ({
  String sectionId,
  String subjectId,
  String? termId,
});

final reportCommentsProvider = FutureProvider.autoDispose
    .family<SubjectReportComments, ReportCommentsKey>((ref, key) {
      return ref
          .watch(reportCommentsClientProvider)
          .fetch(key.sectionId, key.subjectId, termId: key.termId);
    });
