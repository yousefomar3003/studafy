import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/api/generated/models/announcement.dart';
import '../../../core/api/generated/models/attendance_report_metrics.dart';
import '../../../core/api/generated/models/group_by.dart';
import '../../../core/api/generated/models/status15.dart';
import '../../../core/api/generated/models/status16.dart';
import '../../../core/api/generated/models/status17.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../shell/application/shell_providers.dart';
import '../../student/application/current_term_provider.dart';
import '../data/finance_payments_client.dart';
import '../domain/finance_payment.dart';
import '../domain/viewer_role.dart';

/// Which summary the current session's viewer shell shows. See [resolveViewerRole].
final viewerRoleProvider = Provider<ViewerRole>((ref) {
  return resolveViewerRole(ref.watch(sessionRolesProvider));
});

// ---------------------------------------------------------------------------
// Admin/Principal summary — all generated clients, all read-only
// ---------------------------------------------------------------------------

/// School-wide attendance totals for the current term.
///
/// Scoped by `term_id`, not `start_date`/`end_date`: the generated client serialises a `DateTime`
/// query param as a full timestamp via `toIso8601String()`, which the API's date-only filter
/// rejects with 400 — the same landmine `attendance_taking_providers.dart` documents for
/// `session_date`. `term_id` sidesteps it entirely and gives a steadier leadership signal than a
/// single day, which is often empty before school hours.
final viewerAttendanceOverviewProvider = FutureProvider<AttendanceReportMetrics>((ref) async {
  final term = await ref.watch(currentTermProvider.future);
  final summary = await ref
      .watch(apiClientProvider)
      .attendanceReports
      .getAttendanceReportSummary(termId: term.id, groupBy: GroupBy.valueClass);
  return summary.totals;
});

/// Non-terminal incident statuses — what "open" means here, mirroring
/// `OPEN_DISCIPLINE_STATUSES` in `apps/web/src/features/principal/queries.ts`. `resolved` and
/// `closed` are done; everything else still needs attention.
const _openDisciplineStatuses = [Status16.reported, Status16.underReview, Status16.escalated];

/// Count of open discipline incidents, school-wide. One `limit: 1` request per status just to
/// read each page's `total` and sum them — cheaper than the web tile's approach of fetching the
/// preview items too, since this card only shows the count.
final viewerOpenDisciplineCountProvider = FutureProvider<int>((ref) async {
  final client = ref.watch(apiClientProvider).discipline;
  final pages = await Future.wait([
    for (final status in _openDisciplineStatuses)
      client.listDisciplineIncidents(status: status, limit: 1, offset: 0),
  ]);
  return pages.fold<int>(0, (sum, page) => sum + page.total);
});

/// Count of teacher evaluations still in draft — not yet submitted or shared.
final viewerDraftEvaluationsCountProvider = FutureProvider<int>((ref) async {
  final list = await ref
      .watch(apiClientProvider)
      .evaluations
      .listEvaluations(status: Status17.draft, limit: 1, offset: 0);
  return list.total;
});

/// The most recently published announcements. Scheduled-but-not-yet-published ones are excluded,
/// same as the web tile: a glance here is about what already went out.
final viewerRecentAnnouncementsProvider = FutureProvider<List<Announcement>>((ref) async {
  final list = await ref
      .watch(apiClientProvider)
      .announcements
      .listAnnouncements(status: Status15.published, limit: 5);
  return list.items;
});

// ---------------------------------------------------------------------------
// Finance summary
// ---------------------------------------------------------------------------

/// [FinancePaymentsClient] on its own [Dio], wired exactly like `createApiClient` and
/// `familyFinanceClientProvider`: same base URL, same bearer injection, same
/// [ErrorMappingInterceptor].
final financePaymentsClientProvider = Provider<FinancePaymentsClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return FinancePaymentsClient(dio);
});

/// The school's most recently recorded payments.
final viewerRecentPaymentsProvider = FutureProvider<List<FinancePayment>>((ref) {
  return ref.watch(financePaymentsClientProvider).listRecent();
});
