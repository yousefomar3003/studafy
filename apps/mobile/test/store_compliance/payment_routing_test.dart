import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Store-compliant payment routing, client half (ST-304) — see `docs/store_payment_routing.md`.
///
/// Digital goods (the per-student AI add-on, the school's own Studafy plan) are sold on the web
/// only, and both stores forbid a native app from linking or steering to a purchase outside their
/// own in-app purchase. School fees are a real-world service, which both stores exempt, so the
/// invoice "Pay on website" link is the one payment hand-off this app may make. These checks run
/// against the source, not a widget tree, so a purchase route can't come back through a screen no
/// widget test happens to render. The server half — every purchase route refuses a mobile session —
/// is `apps/api/src/modules/subscriptions/__tests__/store-payment-channel.test.ts`.
void main() {
  final handWritten = Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((file) => file.path.endsWith('.dart'))
      .where((file) => !_normalize(file.path).startsWith('lib/src/core/api/generated/'))
      .toList();

  test('sanity: the scan sees the app source', () {
    expect(handWritten.length, greaterThan(50));
  });

  test('no hand-written code reaches a digital-goods purchase route', () {
    // Web pages that sell a digital subscription, and the API routes behind them.
    final purchasePaths = RegExp(r'''['"/](account/ai|billing|pricing)\b|/api/subscriptions''');
    // Generated `SubscriptionsClient` methods that start, manage or cancel a paid plan.
    final purchaseCalls = RegExp(
      r'\.(createCheckoutSession|createAiCheckoutSession|createSchoolCheckoutSession|'
      r'createBillingPortalSession|cancelSubscription|reverseSubscriptionCancellation|'
      r'listSubscriptionPlans)\s*\(',
    );

    final violations = [
      for (final file in handWritten)
        for (final (index, line) in file.readAsLinesSync().indexed)
          if (!line.trimLeft().startsWith('//') &&
              (purchasePaths.hasMatch(line) || purchaseCalls.hasMatch(line)))
            '${_normalize(file.path)}:${index + 1}: ${line.trim()}',
    ];

    expect(violations, isEmpty, reason: violations.join('\n'));
  });

  test('every outbound browser launch is a reviewed, non-purchase hand-off', () {
    // A new entry here needs a store-policy look first: a link to anything sold as a digital good
    // is a rejection, whatever the button says.
    const allowed = {
      'lib/src/core/auth/oauth_browser.dart': 'sign-in',
      'lib/src/features/auth/presentation/login_screen.dart': 'privacy policy',
      'lib/src/core/update/forced_update_screen.dart': 'store listing',
      'lib/src/features/ai/presentation/widgets/ai_consent_disclosure.dart':
          "AI provider's privacy policy — informational, nothing sold",
      'lib/src/features/parent/presentation/widgets/finance_invoice_tile.dart':
          'school fees — a real-world service, exempt from in-app purchase',
      'lib/src/features/shell/presentation/profile_tab_screen.dart':
          'account deletion, privacy policy',
      'lib/src/features/student/presentation/material_viewer_screen.dart': 'file download',
      'lib/src/features/student/presentation/widgets/attachment_download_tile.dart':
          'file download',
    };
    final launch = RegExp(r'\blaunchUrl(String)?\s*\(');

    final unreviewed = [
      for (final file in handWritten)
        if (file
            .readAsLinesSync()
            .any((line) => !line.trimLeft().startsWith('///') && launch.hasMatch(line)))
          _normalize(file.path),
    ].where((path) => !allowed.containsKey(path)).toList();

    expect(unreviewed, isEmpty, reason: 'Unreviewed launchUrl call sites:\n${unreviewed.join('\n')}');
  });

  test('no in-app purchase or in-app browser dependency', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    for (final package in [
      'in_app_purchase',
      'purchases_flutter',
      'flutter_inapp_purchase',
      'webview_flutter',
      'flutter_inappwebview',
    ]) {
      expect(RegExp('^\\s+$package:', multiLine: true).hasMatch(pubspec), isFalse, reason: package);
    }
    for (final file in handWritten) {
      final source = file.readAsStringSync();
      expect(source.contains('LaunchMode.inAppWebView'), isFalse, reason: file.path);
      // Sign-in alone opens in SFSafariViewController on iOS (App Review 4.0 rejects a hand-off
      // to Safari for login). Every other launch, payments included, leaves the app.
      if (_normalize(file.path) != 'lib/src/core/auth/oauth_browser.dart') {
        expect(source.contains('LaunchMode.inAppBrowserView'), isFalse, reason: file.path);
      }
    }
  });

  test('AI copy carries no price or purchase steering', () {
    for (final locale in ['en', 'ar']) {
      final translations =
          jsonDecode(File('assets/translations/$locale.json').readAsStringSync()) as Map;
      final aiCopy = _strings(translations['ai']).join('\n');
      expect(RegExp(r'[$€£]|\bUSD\b|\bJOD\b|\bSAR\b|د\.ا|ر\.س').hasMatch(aiCopy), isFalse,
          reason: '$locale: currency in AI copy');
      if (locale == 'en') {
        final steering = RegExp(
          r'\b(subscribe|buy|purchase|upgrade|checkout|billed|pricing|per month|website)\b',
          caseSensitive: false,
        );
        expect(steering.allMatches(aiCopy).map((m) => m.group(0)).toList(), isEmpty);
      }
    }
  });
}

String _normalize(String path) => path.replaceAll(r'\', '/');

Iterable<String> _strings(Object? node) sync* {
  if (node is String) {
    yield node;
  } else if (node is Map) {
    for (final value in node.values) {
      yield* _strings(value);
    }
  }
}
