import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// What the app shows before its first route, decided once at bootstrap.
enum LaunchIntro {
  /// Straight into the app. The default, so widget tests that pump the app are unaffected.
  none,

  /// The brand splash, then the app.
  splash,

  /// The brand splash, then the first-run guide, then the app.
  splashThenGuide,
}

/// Overridden in `bootstrapApp` with [resolveLaunchIntro]'s answer.
final launchIntroProvider = Provider<LaunchIntro>((ref) => LaunchIntro.none);

/// Plain SharedPreferences flag (not a secret): the first-run guide was finished or skipped.
/// SharedPreferences is wiped with the app, so a reinstall shows the guide again.
const _keyGuideSeen = 'launch.guide_seen';

/// The guide is for someone new to the app: an install that has not seen it and has no session
/// (an existing member updating the app is never walked through it).
Future<LaunchIntro> resolveLaunchIntro({required bool isAuthenticated}) async {
  final prefs = await SharedPreferences.getInstance();
  final seen = isAuthenticated || (prefs.getBool(_keyGuideSeen) ?? false);
  return seen ? LaunchIntro.splash : LaunchIntro.splashThenGuide;
}

Future<void> markLaunchGuideSeen() async {
  final prefs = await SharedPreferences.getInstance();
  await prefs.setBool(_keyGuideSeen, true);
}
