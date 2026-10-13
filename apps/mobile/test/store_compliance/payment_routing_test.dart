import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Store-compliant payment routing, client half (ST-304) — see `docs/store_payment_routing.md`.
///
/// The per-student AI add-on is sold in this app only through the App Store / Google Play's own
/// billing (`lib/src/features/ai/store/`); the school's Studafy plan is sold to schools on the web
/// and is not in the app at all. Both stores forbid a native app from linking or steering to a
/// purchase outside their billing. School fees are a real-world service, which both stores exempt,
/// so the invoice "Pay on website" link is the one payment hand-off this app may make. These checks
/// run against the source, not a widget tree, so a purchase route can't come back through a screen
/// no widget test happens to render. The server half — web checkout refuses a mobile session, and
/// store purchases are accepted only from one — is
/// `apps/api/src/modules/subscriptions/__tests__/store-payment-channel.test.ts` and
/// `store-routes.test.ts`.
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

  test('only the store module makes an in-app purchase', () {
    // The two generated in-app purchase methods, and the purchase plugin itself, belong to
    // lib/src/features/ai/store/ alone — the one place a purchase is made, verified and finished.
    final storeCalls = RegExp(r'\.(getAiStoreConfig|registerAiStorePurchase)\s*\(');
    final plugin = RegExp('package:in_app_purchase');
    final outside = [
      for (final file in handWritten)
        if (!_normalize(file.path).startsWith('lib/src/features/ai/store/') &&
            file.readAsLinesSync().any(
              (line) => storeCalls.hasMatch(line) || plugin.hasMatch(line),
            ))
          _normalize(file.path),
    ];

    expect(outside, isEmpty, reason: outside.join('\n'));
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
      'lib/src/features/ai/store/ai_store_offer_card.dart':
          'privacy policy and terms of use, required beside a store subscription (Apple 3.1.2)',
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

  test("in-app purchase only through the stores' own billing, and no in-app browser", () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    // The official plugin talks to StoreKit / Play Billing directly. Third-party purchase SDKs
    // (with their own servers, paywalls and web checkouts) are not used.
    expect(RegExp(r'^\s+in_app_purchase:', multiLine: true).hasMatch(pubspec), isTrue);
    for (final package in [
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

  test('the in-app purchase copy names no price and no way to pay outside the store', () {
    for (final locale in ['en', 'ar']) {
      final translations =
          jsonDecode(File('assets/translations/$locale.json').readAsStringSync()) as Map;
      final storeCopy = _strings(translations['aiStore']).join('\n');
      expect(storeCopy, isNotEmpty, reason: locale);
      // The price shown is always the store's own localized one, substituted for {price}.
      expect((translations['aiStore'] as Map)['price'], contains('{price}'));
      expect(
        RegExp(r'[$€£]|\bUSD\b|\bJOD\b|\bSAR\b|د\.ا|ر\.س').hasMatch(storeCopy),
        isFalse,
        reason: '$locale: a currency in the purchase copy',
      );
      if (locale == 'en') {
        final elsewhere = RegExp(
          r'\b(website|web|online|studafy\.com|cheaper|discount)\b',
          caseSensitive: false,
        );
        expect(elsewhere.allMatches(storeCopy).map((m) => m.group(0)).toList(), isEmpty);
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
