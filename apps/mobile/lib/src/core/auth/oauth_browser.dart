import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';

const _callbackScheme = 'studafy';
const _callbackHost = 'auth';
const _callbackPath = '/callback';

/// Opens the IdP authorization URL in a browser, then listens for the deep-link
/// callback containing the authorization code.
///
/// On iOS the page opens in `SFSafariViewController`, inside the app: App Review
/// rejects sign-in that sends the user out to Safari (guideline 4.0). On Android
/// it opens in the default browser app, and the `studafy://auth/callback` intent
/// filter brings the user back. Never an embedded webview, which Google and
/// Microsoft both refuse to sign in.
///
/// The IdP never sees `studafy://auth/callback`: it returns to the API's own
/// callback, which then redirects the browser here with a one-time code (see
/// `apps/api/src/modules/auth/oauth/mobile-handoff.ts`).
class OAuthBrowser {
  OAuthBrowser({AppLinks? appLinks})
      : _appLinks = appLinks ?? AppLinks();

  final AppLinks _appLinks;

  Completer<OAuthCallback>? _pending;

  /// The deep link the API's callback sends the browser back to.
  Uri get redirectUri => Uri(
        scheme: _callbackScheme,
        host: _callbackHost,
        path: _callbackPath,
      );

  /// How the authorization page is opened on the current platform.
  @visibleForTesting
  static LaunchMode get launchMode => defaultTargetPlatform == TargetPlatform.iOS
      ? LaunchMode.inAppBrowserView
      : LaunchMode.externalApplication;

  /// Open the browser and wait for the callback.
  ///
  /// Returns the `code` and `state` query parameters from the redirect. Throws
  /// [OAuthCancelledException] if the IdP returns an error or [cancel] is
  /// called. Closing the browser without signing in sends no callback, so the
  /// caller must offer [cancel] while this is pending.
  Future<OAuthCallback> authorize(Uri authorizationUrl) async {
    final completer = Completer<OAuthCallback>();
    _pending = completer;

    // Listen for the deep link before launching the browser to avoid a race.
    final sub = _appLinks.uriLinkStream.listen(
      (uri) {
        if (uri.scheme == _callbackScheme &&
            uri.host == _callbackHost &&
            uri.path == _callbackPath) {
          final code = uri.queryParameters['code'];
          final state = uri.queryParameters['state'];
          final error = uri.queryParameters['error'];

          if (error != null && !completer.isCompleted) {
            completer.completeError(OAuthCancelledException(error));
          } else if (code != null && state != null && !completer.isCompleted) {
            completer.complete(OAuthCallback(code: code, state: state));
          }
        }
      },
      onError: (Object error) {
        if (!completer.isCompleted) {
          completer.completeError(error);
        }
      },
    );

    try {
      final launched = await launchUrl(authorizationUrl, mode: launchMode);

      if (!launched) {
        completer.completeError(OAuthCancelledException('launch_failed'));
      }

      return await completer.future;
    } finally {
      sub.cancel();
      if (identical(_pending, completer)) _pending = null;
      if (launchMode == LaunchMode.inAppBrowserView) {
        // The redirect reaches the app while the sign-in sheet is still on screen.
        await closeInAppWebView();
      }
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
