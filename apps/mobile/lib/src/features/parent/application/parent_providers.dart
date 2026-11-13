import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/api/generated/models/child_comparison_item.dart';
import '../../../core/api/generated/models/child_comparison_report.dart';
// Aliased: the generated model class is named `Notification`, which collides with the Flutter
// widget of the same name wherever a consumer also imports `flutter/material.dart`.
import '../../../core/api/generated/models/notification.dart' as api_models;
import '../../../core/api/generated/models/notification_preferences.dart';
import '../../../core/api/generated/models/update_notification_preferences_request.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../core/offline/offline_providers.dart';
// `currentTermProvider` resolves the school's active year + term — school-scoped context, not
// student-specific. It still lives in the student feature (its first consumer); this is now its
// third (student, teacher, parent), which is the cue to promote it to a shared location such as
// `core/academics/`. Imported directly rather than duplicated, the same call the teacher feature
// already makes.
import '../../student/application/current_term_provider.dart';
import '../data/family_finance_client.dart';
import '../data/parent_selected_child_store.dart';
import '../domain/family_finance.dart';
import '../domain/parent_alert.dart';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// The signed-in parent's user id (the token's `sub` claim). Null only when the session holds
/// no token. Mirrors `askAiStudentIdProvider`: `authSessionProvider` hands back a long-lived
/// mutable object, so watch `authStatusProvider` to rebuild when login/logout flips it.
final parentUserIdProvider = Provider<String?>((ref) {
  ref.watch(authStatusProvider);
  return ref.watch(authSessionProvider).userId;
});

// ---------------------------------------------------------------------------
// Linked children + per-child summary
// ---------------------------------------------------------------------------

/// The child-comparison report for the current term: identity, grade snapshot and trend, and
/// term attendance metrics for **every child linked to this parent** through
/// `app.parent_child_links`.
///
/// "Only linked children appear" is the endpoint's own guarantee — `reports/service.ts` builds
/// the child set from the caller's link rows — so nothing is re-checked here.
final childComparisonProvider = FutureProvider<ChildComparisonReport>((ref) async {
  final term = await ref.watch(currentTermProvider.future);
  return ref
      .watch(apiClientProvider)
      .childComparisonReports
      .getChildrenComparison(termId: term.id);
});

/// Just the linked children, in the order the report returns them (by name, server-side).
final linkedChildrenProvider = Provider<AsyncValue<List<ChildComparisonItem>>>((ref) {
  return ref.watch(childComparisonProvider).whenData((report) => report.children);
});

// ---------------------------------------------------------------------------
// Switcher selection — persisted per device
// ---------------------------------------------------------------------------

final parentSelectedChildStoreProvider = Provider<ParentSelectedChildStore>((ref) {
  return ParentSelectedChildStore(ref.watch(offlineDatabaseProvider));
});

/// The child id the parent last picked on this device, or null if they never have. Read once;
/// [SelectedChildController.select] rewrites the store and invalidates this so it stays current.
final persistedSelectedChildIdProvider = FutureProvider<String?>((ref) {
  return ref.watch(parentSelectedChildStoreProvider).load();
});

/// This session's explicit pick, layered over [persistedSelectedChildIdProvider]. Null means
/// "no pick yet this session — follow the persisted one, then the default".
class SelectedChildController extends Notifier<String?> {
  @override
  String? build() => null;

  Future<void> select(String studentId) async {
    state = studentId;
    await ref.read(parentSelectedChildStoreProvider).save(studentId);
    ref.invalidate(persistedSelectedChildIdProvider);
  }
}

final selectedChildControllerProvider =
    NotifierProvider<SelectedChildController, String?>(SelectedChildController.new);

/// The child whose summary the home screen shows: this session's pick, else the last pick
/// persisted on this device, else the first linked child. Falls back to the first child whenever
/// the remembered id is not in the current linked set (unlinked since, or a different account),
/// so a stale preference never leaves the screen blank. Null only when there are no linked
/// children at all.
final selectedChildProvider = Provider<AsyncValue<ChildComparisonItem?>>((ref) {
  final session = ref.watch(selectedChildControllerProvider);
  final persisted = ref.watch(persistedSelectedChildIdProvider).value;

  return ref.watch(linkedChildrenProvider).whenData((children) {
    if (children.isEmpty) return null;
    final wantedId = session ?? persisted;
    for (final child in children) {
      if (child.studentId == wantedId) return child;
    }
    return children.first;
  });
});

// ---------------------------------------------------------------------------
// Fees — the family financial view
// ---------------------------------------------------------------------------

/// The parent's household id, from `GET /api/families` (scoped server-side to households the
/// caller belongs to). Null when the parent is not attached to a household yet — the fees card
/// reads that as "no billing information", not an error. The first family wins if there is
/// somehow more than one; a parent belongs to exactly one in practice.
final parentFamilyIdProvider = FutureProvider<String?>((ref) async {
  final page = await ref.watch(apiClientProvider).families.listFamilies(limit: 1);
  return page.families.isEmpty ? null : page.families.first.id;
});

/// [FamilyFinanceClient] on its own [Dio], wired exactly like `createApiClient` and
/// `askAiClientProvider` — same base URL, same bearer injection, same [ErrorMappingInterceptor].
final familyFinanceClientProvider = Provider<FamilyFinanceClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return FamilyFinanceClient(dio);
});

/// The household's full finance detail — invoices, fee-schedule installments, receipts, and
/// balances, per child and in total. Null when there is no household. Its own provider so an
/// ERPNext-backed finance outage (the endpoint can 503) surfaces in the fees card and the Finance
/// tab alone, and never blanks attendance or grades.
final familyFinanceProvider = FutureProvider<FamilyFinanceView?>((ref) async {
  final familyId = await ref.watch(parentFamilyIdProvider.future);
  if (familyId == null) return null;
  return ref.watch(familyFinanceClientProvider).fetch(familyId);
});

// ---------------------------------------------------------------------------
// Combined notifications feed
// ---------------------------------------------------------------------------

/// Every notification the API addresses to this parent — which already spans all their children
/// plus account-level notices — newest first, capped at the first page. The card shows the most
/// recent few.
final parentNotificationsProvider = FutureProvider<List<api_models.Notification>>((ref) async {
  final page = await ref.watch(apiClientProvider).notifications.listNotifications(limit: 20);
  return page.notifications.toList()
    ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
});

// ---------------------------------------------------------------------------
// Communication screen — the fuller, split-by-kind history behind [parentNotificationsProvider]
// ---------------------------------------------------------------------------

/// The largest page the inbox endpoint allows, newest first. A separate fetch from
/// [parentNotificationsProvider] — same endpoint, different page size — rather than one shared
/// provider both screens read: the home card wants a handful mixed together, the communication
/// screen wants as much of each kind as the API will return in one page, and the two have no
/// reason to invalidate together.
final parentCommunicationFeedProvider = FutureProvider<List<api_models.Notification>>((ref) async {
  final page = await ref.watch(apiClientProvider).notifications.listNotifications(limit: 100);
  return page.notifications.toList()
    ..sort((a, b) => b.createdAt.compareTo(a.createdAt));
});

/// Just the `ATTENDANCE_ALERT` rows of [parentCommunicationFeedProvider], for the alerts tab.
final attendanceAlertsFeedProvider = Provider<AsyncValue<List<api_models.Notification>>>((ref) {
  return ref.watch(parentCommunicationFeedProvider).whenData(
        (feed) => [
          for (final notification in feed)
            if (categoryOf(notification) == ParentAlertCategory.attendance) notification,
        ],
      );
});

/// Just the `ANNOUNCEMENT` / `ADMIN_ANNOUNCEMENT` rows of [parentCommunicationFeedProvider], for
/// the messages tab.
final schoolMessagesFeedProvider = Provider<AsyncValue<List<api_models.Notification>>>((ref) {
  return ref.watch(parentCommunicationFeedProvider).whenData(
        (feed) => [
          for (final notification in feed)
            if (categoryOf(notification) == ParentAlertCategory.message) notification,
        ],
      );
});

// ---------------------------------------------------------------------------
// Attendance-alert threshold — a parent's personal override on top of the school's own rules
// ---------------------------------------------------------------------------

/// The signed-in parent's full notification-preference matrix, including
/// [NotificationPreferences.attendanceAlertThreshold] — their personal absence-count override.
final notificationPreferencesProvider = FutureProvider<NotificationPreferences>((ref) {
  return ref.watch(apiClientProvider).notifications.getNotificationPreferences();
});

/// Sets or clears [notificationPreferencesProvider]'s attendance-alert threshold override, and
/// re-fetches it on success so the sheet that triggered the edit sees the round-tripped value
/// rather than an optimistic guess.
class AttendanceAlertThresholdController extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  Future<void> setThreshold(int? days) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref
          .read(apiClientProvider)
          .notifications
          .updateNotificationPreferences(
            body: UpdateNotificationPreferencesRequest(attendanceAlertThreshold: days),
          );
      ref.invalidate(notificationPreferencesProvider);
    });
  }
}

final attendanceAlertThresholdControllerProvider =
    AsyncNotifierProvider<AttendanceAlertThresholdController, void>(
  AttendanceAlertThresholdController.new,
);
