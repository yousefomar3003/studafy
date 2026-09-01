import 'package:easy_localization/easy_localization.dart';

/// A short, localized "how long ago" label for [timestamp]: "just now", "5m ago", "3h ago",
/// "2d ago". Anything still in the future reads as "just now".
///
/// Shared by the offline staleness banner and the teacher home feed so both phrase recency the
/// same way, off the same `offline.*` translation keys. Pass [now] in tests for a fixed clock.
String relativeTimeLabel(DateTime timestamp, {DateTime? now}) {
  final age = (now ?? DateTime.now()).difference(timestamp);
  if (age.inMinutes < 1) return 'offline.justNow'.tr();
  if (age.inMinutes < 60) {
    return 'offline.minutesAgo'.tr(namedArgs: {'count': '${age.inMinutes}'});
  }
  if (age.inHours < 24) {
    return 'offline.hoursAgo'.tr(namedArgs: {'count': '${age.inHours}'});
  }
  return 'offline.daysAgo'.tr(namedArgs: {'count': '${age.inDays}'});
}
