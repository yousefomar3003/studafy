import 'package:dio/dio.dart';
import 'package:studafy_mobile/src/core/auth/oauth_browser.dart';

import 'mock_idp.dart';

/// Drives the real mock OAuth round trip over plain HTTP instead of opening a system browser.
///
/// [OAuthBrowser.authorize] launches `ASWebAuthenticationSession`/Custom Tabs and waits on an
/// `app_links` deep-link callback — there is no way for an instrumented test to drive that UI
/// chrome, and no need to: the mock IdP issues its authorization code immediately with no consent
/// screen (see `resolveMockAuthorizationCode`'s doc comment). Everything downstream of this
/// (`/mobile-exchange`, the mock IdP's own `/token`, `loginReturningUser`) is the real production
/// code path — only the "open a browser and wait for a redirect" step is swapped for a single
/// unfollowed request, exactly the seam `oAuthBrowserProvider` exists for.
class FakeOAuthBrowser extends OAuthBrowser {
  FakeOAuthBrowser() : _dio = Dio();

  final Dio _dio;

  @override
  Future<OAuthCallback> authorize(Uri authorizationUrl) async {
    try {
      final resolved = await resolveMockAuthorizationCode(_dio, authorizationUrl);
      return OAuthCallback(code: resolved.code, state: resolved.state);
    } on StateError catch (error) {
      throw OAuthCancelledException(error.message);
    }
  }
}
