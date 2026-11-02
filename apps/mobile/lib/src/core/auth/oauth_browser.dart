import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:url_launcher/url_launcher.dart';

const _callbackScheme = 'studafy';
const _callbackHost = 'auth';
const _callbackPath = '/callback';

/// Runs an iOS `ASWebAuthenticationSession` for [url] and returns the callback URL it captured.
typedef WebAuthSession =
    Future<String> Function(Uri url, String callbackScheme);

Future<String> _flutterWebAuth2(Uri url, String callbackScheme) =>
    FlutterWebAuth2.authenticate(
      url: url.toString(),
      callbackUrlScheme: callbackScheme,
    );

/// Opens the IdP authorization URL in a browser, then waits for the
/// `studafy://auth/callback` redirect containing the authorization code.
///
/// On iOS the page opens in an `ASWebAuthenticationSession`, inside the app: App
/// Review rejects sign-in that sends the user out to Safari (guideline 4.0), and
/// `SFSafariViewController` silently drops the IdP's redirect to the custom
/// scheme, so the code never comes back. The session captures that redirect
/// itself. On Android it opens in the default browser app, and the
/// `studafy://auth/callback` intent filter brings the user back. Never an
/// embedded webview, which Google and Microsoft both refuse to sign in.
///
/// The IdP never sees `studafy://auth/callback`: it returns to the API's own
/// callback, which then redirects the browser here with a one-time code (see
/// `apps/api/src/modules/auth/oauth/mobile-handoff.ts`).
class OAuthBrowser {
  OAuthBrowser({AppLinks? appLinks, WebAuthSession? webAuthSession})
    : _appLinks = appLinks ?? AppLinks(),
      _webAuthSession = webAuthSession ?? _flutterWebAuth2;

  final AppLinks _appLinks;
  final WebAuthSession _webAuthSession;

  Completer<OAuthCallback>? _pending;

  /// The deep link the API's callback sends the browser back to.
  Uri get redirectUri => Uri(
        scheme: _callbackScheme,
        host: _callbackHost,
        path: _callbackPath,
      );

  /// Whether sign-in runs in an `ASWebAuthenticationSession` (iOS) rather than
  /// the browser app plus a deep link (Android). The session reports its own
  /// dismissal, so only the Android flow needs the caller to detect an
  /// abandoned sign-in.
  static bool get usesWebAuthSession =>
      defaultTargetPlatform == TargetPlatform.iOS;

  /// Open the browser and wait for the callback.
  ///
  /// Returns the `code` and `state` query parameters from the redirect. Throws
  /// [OAuthCancelledException] if the IdP returns an error, the user closes the
  /// sign-in sheet, or [cancel] is called. On Android, closing the browser
  /// without signing in sends no callback, so the caller must offer [cancel]
  /// while this is pending.
  Future<OAuthCallback> authorize(Uri authorizationUrl) async {
    final completer = Completer<OAuthCallback>();
    _pending = completer;

    try {
      if (usesWebAuthSession) {
        unawaited(_runWebAuthSession(authorizationUrl, completer));
        return await completer.future;
      }
      return await _runExternalBrowser(authorizationUrl, completer);
    } finally {
      if (identical(_pending, completer)) _pending = null;
    }
  }

  Future<void> _runWebAuthSession(
    Uri authorizationUrl,
    Completer<OAuthCallback> completer,
  ) async {
    try {
      final result = await _webAuthSession(authorizationUrl, _callbackScheme);
      _completeFromCallback(Uri.parse(result), completer);
      if (!completer.isCompleted) {
        completer.completeError(
          const OAuthCancelledException('invalid_callback'),
        );
      }
    } on PlatformException catch (e) {
      if (!completer.isCompleted) {
        completer.completeError(
          OAuthCancelledException(e.code == 'CANCELED' ? 'cancelled' : e.code),
        );
      }
    }
  }

  Future<OAuthCallback> _runExternalBrowser(
    Uri authorizationUrl,
    Completer<OAuthCallback> completer,
  ) async {
    // Listen for the deep link before launching the browser to avoid a race.
    final sub = _appLinks.uriLinkStream.listen(
      (uri) => _completeFromCallback(uri, completer),
      onError: (Object error) {
        if (!completer.isCompleted) {
          completer.completeError(error);
        }
      },
    );

    try {
      final launched = await launchUrl(
        authorizationUrl,
        mode: LaunchMode.externalApplication,
      );

      if (!launched) {
        completer.completeError(OAuthCancelledException('launch_failed'));
      }

      return await completer.future;
    } finally {
      await sub.cancel();
    }
  }

  /// Completes [completer] from a `studafy://auth/callback` redirect; ignores any other URI.
  void _completeFromCallback(Uri uri, Completer<OAuthCallback> completer) {
    if (uri.scheme != _callbackScheme ||
        uri.host != _callbackHost ||
        uri.path != _callbackPath ||
        completer.isCompleted) {
      return;
    }
    final code = uri.queryParameters['code'];
    final state = uri.queryParameters['state'];
    final error = uri.queryParameters['error'];

    if (error != null) {
      completer.completeError(OAuthCancelledException(error));
    } else if (code != null && state != null) {
      completer.complete(OAuthCallback(code: code, state: state));
    }
  }

  /// Abandon the pending [authorize] call, which then throws
  /// [OAuthCancelledException]. A no-op when nothing is pending.
  void cancel() {
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(const OAuthCancelledException('cancelled'));
    }
  }
}

class OAuthCallback {
  const OAuthCallback({required this.code, required this.state});

  final String code;
  final String state;
}

class OAuthCancelledException implements Exception {
  const OAuthCancelledException(this.reason);
  final String reason;

  @override
  String toString() => 'OAuth cancelled: $reason';
}
