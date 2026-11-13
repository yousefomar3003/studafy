import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'school_closed_error.dart';

/// Whether the login screen should say "This app is no longer available for your school."
///
/// Set when the session is ended because the school was closed (by its admin from the Profile
/// tab, or discovered on any API call, refresh or sign-in attempt), and cleared by the next
/// successful sign-in. Kept in a provider rather than a snackbar so the message stays on the
/// login screen for as long as it is true.
class SchoolClosedNoticeNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void show() => state = true;

  void clear() => state = false;
}

final schoolClosedNoticeProvider =
    NotifierProvider<SchoolClosedNoticeNotifier, bool>(
      SchoolClosedNoticeNotifier.new,
    );
