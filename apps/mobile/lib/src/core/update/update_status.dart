import 'app_version.dart';
import 'release_config.dart';

/// The outcome of comparing the running build against its platform's [PlatformRelease].
///
/// Only [updateRequired] blocks the app (see `forcedUpdateGuard`). [updateAvailable] is a hook
/// for a future dismissible nudge; nothing acts on it yet.
enum UpdateStatus { upToDate, updateAvailable, updateRequired }

/// - below `minimumSupported`            → [UpdateStatus.updateRequired]
/// - at/above the floor, below `latest`  → [UpdateStatus.updateAvailable]
/// - at/above `latest`                   → [UpdateStatus.upToDate]
///
/// An unset floor is served as `0.0.0`, so a real build is never below it and this never forces
/// an update until an operator sets `MOBILE_MIN_SUPPORTED_VERSION_*` on the API.
UpdateStatus evaluateUpdateStatus({
  required AppVersion current,
  required PlatformRelease release,
}) {
  if (current < release.minimumSupported) return UpdateStatus.updateRequired;
  if (current < release.latest) return UpdateStatus.updateAvailable;
  return UpdateStatus.upToDate;
}
