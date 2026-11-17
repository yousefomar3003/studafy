import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// QA-084: release build settings that a unit test can't exercise (they run in fastlane, Gradle
/// and the Android activity), pinned here so they can't silently go away.
void main() {
  final fastfile = File('fastlane/Fastfile').readAsStringSync();
  final gradle = File('android/app/build.gradle.kts').readAsStringSync();
  final mainActivity = File(
    'android/app/src/main/kotlin/com/studafy/studafy_mobile/MainActivity.kt',
  ).readAsStringSync();

  String body(String def) {
    final start = fastfile.indexOf('def $def');
    expect(start, isNot(-1), reason: 'def $def');
    return fastfile.substring(start, fastfile.indexOf('\nend\n', start));
  }

  test('every store build is obfuscated with its symbols split out', () {
    for (final def in ['build_ios_ipa', 'build_android_aab', 'enforce_android_size_budget!']) {
      expect(body(def), contains('*obfuscation_flags'), reason: def);
    }
    expect(body('obfuscation_flags'), contains('--obfuscate'));
    expect(body('obfuscation_flags'), contains('--split-debug-info='));
  });

  test('the symbols are uploaded to Sentry after each store build', () {
    expect(body('build_ios_ipa'), contains('upload_dart_symbols!'));
    expect(body('build_android_aab'), contains('upload_dart_symbols!'));
    final upload = body('upload_dart_symbols!');
    expect(upload, contains('debug-files'));
    expect(upload, contains('SENTRY_AUTH_TOKEN'));
  });

  test('a release app bundle refuses to build without the upload key', () {
    expect(gradle, contains('gradle.taskGraph.whenReady'));
    expect(gradle, contains('throw GradleException('));
    expect(gradle, isNot(contains("local_auth's biometric prompt needs")));
  });

  test('Android handles the screen-protection channel with FLAG_SECURE', () {
    expect(mainActivity, contains('"studafy/screen_protection"'));
    expect(mainActivity, contains('WindowManager.LayoutParams.FLAG_SECURE'));
  });
}
