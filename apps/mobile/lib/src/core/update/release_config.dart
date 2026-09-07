import 'app_version.dart';

/// The two store platforms Studafy ships to. Kept local to this module — it is only ever the
/// key into a [ReleaseConfig], never a general platform abstraction.
enum MobilePlatform { ios, android }

/// One platform's slice of `GET /api/mobile/config`.
class PlatformRelease {
  const PlatformRelease({required this.minimumSupported, required this.latest});

  /// The oldest build the backend still supports. A running build strictly below this must block
  /// itself behind the forced-update screen.
  final AppVersion minimumSupported;

  /// The newest build published to this platform's store. Advisory only — drives an optional,
  /// dismissible "update available" nudge, never a block.
  final AppVersion latest;
}

/// The whole `GET /api/mobile/config` document: both platforms, so one response caches for every
/// caller and the client picks the key that applies to it.
class ReleaseConfig {
  const ReleaseConfig({required this.ios, required this.android});

  factory ReleaseConfig.fromJson(Map<String, dynamic> json) {
    PlatformRelease platform(String key) {
      final node = (json[key] as Map).cast<String, dynamic>();
      return PlatformRelease(
        minimumSupported: AppVersion.parse(node['minimum_supported_version'] as String),
        latest: AppVersion.parse(node['latest_version'] as String),
      );
    }

    return ReleaseConfig(ios: platform('ios'), android: platform('android'));
  }

  final PlatformRelease ios;
  final PlatformRelease android;

  PlatformRelease forPlatform(MobilePlatform platform) =>
      platform == MobilePlatform.ios ? ios : android;
}
