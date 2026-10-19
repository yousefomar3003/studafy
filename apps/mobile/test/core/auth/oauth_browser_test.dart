import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/oauth_browser.dart';
import 'package:url_launcher_platform_interface/link.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

void main() {
  final authorizationUrl = Uri.parse('https://login.example.com/authorize');
  late _FakeAppLinks appLinks;
  late _RecordingUrlLauncher launcher;

  setUp(() {
    appLinks = _FakeAppLinks();
    launcher = _RecordingUrlLauncher();
    UrlLauncherPlatform.instance = launcher;
  });

  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    appLinks.close();
  });

  test(
    'returns the code from a callback that arrives after the browser opened',
    () async {
      final browser = OAuthBrowser(appLinks: appLinks);
      // A timer, not a microtask: the redirect lands well after `launchUrl` has returned, which is
      // when an early-cancelled listener would already have missed it.
      launcher.onLaunch = () => Timer(Duration.zero, () {
        appLinks.emit(Uri.parse('studafy://auth/callback?code=abc&state=xyz'));
      });

      final callback = await browser
          .authorize(authorizationUrl)
          .timeout(const Duration(seconds: 2));

      expect(callback.code, 'abc');
      expect(callback.state, 'xyz');
    },
  );

  test(
    'cancel ends a sign-in whose browser was closed without a callback',
    () async {
      final browser = OAuthBrowser(appLinks: appLinks);
      launcher.onLaunch = () => Timer(Duration.zero, browser.cancel);

      await expectLater(
        browser.authorize(authorizationUrl),
        throwsA(
          isA<OAuthCancelledException>().having(
            (e) => e.reason,
            'reason',
            'cancelled',
          ),
        ),
      );
    },
  );

  test(
    'iOS signs in through an auth session that captures the callback itself',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final sessions = <(Uri, String)>[];
      final browser = OAuthBrowser(
        appLinks: appLinks,
        webAuthSession: (url, scheme) async {
          sessions.add((url, scheme));
          return 'studafy://auth/callback?code=abc&state=xyz';
        },
      );

      final callback = await browser.authorize(authorizationUrl);

      expect(callback.code, 'abc');
      expect(callback.state, 'xyz');
      expect(sessions, [(authorizationUrl, 'studafy')]);
      expect(launcher.modes, isEmpty);
    },
  );

  test('iOS reports a closed sign-in sheet as cancelled', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final browser = OAuthBrowser(
      appLinks: appLinks,
      webAuthSession: (_, _) async => throw PlatformException(code: 'CANCELED'),
    );

    await expectLater(
      browser.authorize(authorizationUrl),
      throwsA(
        isA<OAuthCancelledException>().having(
          (e) => e.reason,
          'reason',
          'cancelled',
        ),
      ),
    );
  });

  test('iOS surfaces an IdP error from the callback', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final browser = OAuthBrowser(
      appLinks: appLinks,
      webAuthSession: (_, _) async =>
          'studafy://auth/callback?error=access_denied',
    );

    await expectLater(
      browser.authorize(authorizationUrl),
      throwsA(
        isA<OAuthCancelledException>().having(
          (e) => e.reason,
          'reason',
          'access_denied',
        ),
      ),
    );
  });

  test(
    'cancel ends an iOS sign-in that is still waiting on the session',
    () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      final browser = OAuthBrowser(
        appLinks: appLinks,
        webAuthSession: (_, _) => Completer<String>().future,
      );

      final pending = browser.authorize(authorizationUrl);
      browser.cancel();

      await expectLater(pending, throwsA(isA<OAuthCancelledException>()));
    },
  );

  test('Android hands sign-in to the browser app', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    final browser = OAuthBrowser(appLinks: appLinks);
    launcher.onLaunch = () => Timer(Duration.zero, browser.cancel);

    await expectLater(
      browser.authorize(authorizationUrl),
      throwsA(isA<OAuthCancelledException>()),
    );

    expect(launcher.modes, [PreferredLaunchMode.externalApplication]);
    expect(launcher.closeCount, 0);
  });
}

class _FakeAppLinks implements AppLinks {
  final _links = StreamController<Uri>.broadcast();

  @override
  Stream<Uri> get uriLinkStream => _links.stream;

  void emit(Uri uri) => _links.add(uri);

  void close() => _links.close();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _RecordingUrlLauncher extends UrlLauncherPlatform {
  final modes = <PreferredLaunchMode>[];
  int closeCount = 0;
  void Function()? onLaunch;

  @override
  LinkDelegate? get linkDelegate => null;

  @override
  Future<bool> canLaunch(String url) async => true;

  @override
  Future<bool> launchUrl(String url, LaunchOptions options) async {
    modes.add(options.mode);
    onLaunch?.call();
    return true;
  }

  @override
  Future<void> closeWebView() async => closeCount++;
}
