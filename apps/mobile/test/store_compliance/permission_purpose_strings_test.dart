import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Permission purpose strings (ST-310) — see `docs/permission_purpose_strings.md`.
///
/// App Store Connect rejects an upload whose binary links a privacy-sensitive API without the
/// matching `Info.plist` string (ITMS-90683), even when the app never calls it. App Review
/// rejects a string that doesn't say what the access is for (5.1.1). These checks keep the
/// declared set equal to what the build links, and keep each string specific.
void main() {
  final infoPlist = _read('ios/Runner/Info.plist');
  final androidManifest = _read('android/app/src/main/AndroidManifest.xml');

  test('iOS declares exactly the purpose strings the linked plugins require', () {
    // NSCameraUsageDescription: image_picker's camera capture, the only one the app shows.
    // NSPhotoLibraryUsageDescription: image_picker_ios links PHPhotoLibrary, and file_picker's
    // media picker is compiled in under Swift Package Manager.
    // NSAppleMusicUsageDescription: file_picker's audio picker, compiled in under SPM.
    expect(_usageDescriptions(infoPlist).keys.toSet(), {
      'NSCameraUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSAppleMusicUsageDescription',
    });
  });

  test('every iOS purpose string names the class-material upload it serves', () {
    for (final MapEntry(:key, :value) in _usageDescriptions(infoPlist).entries) {
      expect(value, contains('class'), reason: key);
      expect(value, contains('course material'), reason: key);
    }
  });

  test('Android declares no runtime permission the app does not need', () {
    // POST_NOTIFICATIONS arrives from firebase_messaging's manifest at merge time. Camera capture
    // goes through the system camera app and file uploads through the system file picker, so
    // neither needs a permission of its own.
    for (final permission in [
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_AUDIO',
      'android.permission.RECORD_AUDIO',
    ]) {
      expect(
        RegExp('<uses-permission\\s+android:name="${RegExp.escape(permission)}"')
            .hasMatch(androidManifest),
        isFalse,
        reason: permission,
      );
    }
  });
}

String _read(String path) => File(path).readAsStringSync();

/// `NS…UsageDescription` keys in [plist] and their strings.
Map<String, String> _usageDescriptions(String plist) => {
  for (final match in RegExp(
    r'<key>(NS\w+UsageDescription)</key>\s*<string>([^<]*)</string>',
  ).allMatches(plist))
    match.group(1)!: match.group(2)!,
};
