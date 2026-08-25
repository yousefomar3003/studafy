import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';

const _callbackScheme = 'studafy';
const _callbackHost = 'auth';
const _callbackPath = '/callback';

/// Opens the system browser (ASWebAuthenticationSession on iOS, Custom Tabs on
/// Android) for the IdP authorization URL, then listens for the deep-link
/// callback containing the authorization code.
///
/// The redirect URI sent to the IdP must be `studafy://auth/callback` — the
/// same scheme+host+path the listener expects.
class OAuthBrowser {
  OAuthBrowser({AppLinks? appLinks})
      : _appLinks = appLinks ?? AppLinks();

  final AppLinks _appLinks;

  /// The redirect URI registered with the IdP.
  Uri get redirectUri => Uri(
        scheme: _callbackScheme,
        host: _callbackHost,
        path: _callbackPath,
      );

  /// Open the system browser and wait for the callback.
  ///
  /// Returns the `code` and `state` query parameters from the redirect. Throws
  /// [OAuthCancelledException] if the user closes the browser without
  /// authenticating.
  Future<OAuthCallback> authorize(Uri authorizationUrl) async {
    final completer = Completer<OAuthCallback>();

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
      final launched = await launchUrl(
        authorizationUrl,
        mode: LaunchMode.externalApplication,
      );

      if (!launched) {
        completer.completeError(OAuthCancelledException('launch_failed'));
      }

      return completer.future;
    } finally {
      sub.cancel();
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
