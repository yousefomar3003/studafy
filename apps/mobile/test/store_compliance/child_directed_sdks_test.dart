import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Child-directed SDK compliance (ST-307) — see `docs/sdk_compliance_inventory.md`.
///
/// Google Play's Families policy forbids transmitting the advertising ID (and other hardware
/// identifiers) from children or unknown-age users, and every SDK in a child-directed app must be
/// fit for one. These checks keep the audited inventory and the configuration it relies on from
/// drifting. The on-device half — the real merged manifest and a zeroed AAID — is
/// `android/app/src/androidTest/.../ChildDirectedComplianceTest.kt`.
void main() {
  final lockfile = _read('pubspec.lock');
  final androidManifest = _read('android/app/src/main/AndroidManifest.xml');
  final infoPlist = _read('ios/Runner/Info.plist');

  test('every direct dependency is audited in the SDK inventory, and nothing else is', () {
    final audited = _auditedPackages(_read('docs/sdk_compliance_inventory.md'));
    final resolved = _resolvedPackages(lockfile, dependency: 'direct main');

    expect(audited, isNotEmpty, reason: 'the inventory table could not be parsed');
    expect(
      resolved.difference(audited),
      isEmpty,
      reason: 'new dependency: audit it for child-directed use, then add it to the inventory',
    );
    expect(
      audited.difference(resolved),
      isEmpty,
      reason: 'removed dependency: drop its row from the inventory',
    );
  });

  test('no ads, analytics, attribution or identity SDK is resolved, even transitively', () {
    // Each of these either reads the AAID/IDFA, profiles users across apps, or would gate sign-in
    // behind a third-party SDK. Allowing one needs a new audit, not an edit to this list.
    final forbidden = RegExp(
      r'^(google_mobile_ads|firebase_analytics|firebase_in_app_messaging|firebase_dynamic_links|'
      r'advertising_id|app_tracking_transparency|google_sign_in.*|sign_in_with_apple|'
      r'flutter_facebook_auth|facebook_.*|appsflyer_sdk|adjust_sdk|branch_sdk|'
      r'amplitude_flutter|mixpanel_flutter|segment_analytics|posthog_flutter|onesignal_flutter|'
      r'unity_ads_plugin|applovin_max|ironsource_mediation)$',
    );

    final violations = _resolvedPackages(lockfile).where(forbidden.hasMatch).toList();

    expect(violations, isEmpty);
  });

  test('the Android manifest strips the advertising ID permission', () {
    expect(
      androidManifest,
      matches(
        RegExp(
          r'<uses-permission\s+android:name="com\.google\.android\.gms\.permission\.AD_ID"\s+'
          r'tools:node="remove"\s*/>',
        ),
      ),
    );
  });

  test('FCM creates no token before sign-in', () {
    expect(
      androidManifest,
      matches(
        RegExp(r'android:name="firebase_messaging_auto_init_enabled"\s+android:value="false"'),
      ),
    );
    expect(infoPlist, matches(RegExp(r'<key>FirebaseMessagingAutoInitEnabled</key>\s*<false/>')));
  });

  test('iOS declares no tracking usage, so no ATT prompt and no IDFA', () {
    expect(infoPlist, isNot(contains('NSUserTrackingUsageDescription')));
  });
}

/// Reads [path] with `\n` line endings, so the multi-line patterns hold on a Windows checkout.
String _read(String path) => File(path).readAsStringSync().replaceAll('\r\n', '\n');

/// Package names in the inventory's "Direct dependencies" table.
Set<String> _auditedPackages(String inventory) {
  final section = RegExp(
    r'^## Direct dependencies$(.*?)^## ',
    multiLine: true,
    dotAll: true,
  ).firstMatch(inventory)?.group(1);
  if (section == null) return {};
  return RegExp(
    r'^\| `([a-z0-9_]+)` \|',
    multiLine: true,
  ).allMatches(section).map((match) => match.group(1)!).toSet();
}

/// Package names in `pubspec.lock`, optionally only those of one dependency kind.
Set<String> _resolvedPackages(String lockfile, {String? dependency}) {
  return RegExp(r'^  ([a-z0-9_]+):\n    dependency: "?([a-z ]+)"?$', multiLine: true)
      .allMatches(lockfile)
      .where((match) => dependency == null || match.group(2) == dependency)
      .map((match) => match.group(1)!)
      .toSet();
}
