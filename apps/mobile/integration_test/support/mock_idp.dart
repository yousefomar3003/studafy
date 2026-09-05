import 'package:dio/dio.dart';

/// The mock IdP's fixed client id (`MOCK_OAUTH_CLIENT_ID` in `oauth/mock-config.ts`) and the
/// mobile app's registered redirect URI (`OAuthBrowser.redirectUri`) — both static, dev/E2E-only
/// constants, safe to duplicate here rather than reaching into `lib/` for them.
const mockOAuthClientId = 'studafy-e2e';
const mockOAuthRedirectUri = 'studafy://auth/callback';

class MockAuthorizationCode {
  const MockAuthorizationCode({required this.code, required this.state});

  final String code;
  final String state;
}

/// Hits the mock IdP's `/authorize` endpoint directly and reads `code`/`state` off its redirect —
/// the one HTTP hop a system browser would otherwise make. `dev/mock-idp.ts`'s `/authorize` has no
/// consent screen or login form: it issues a code immediately for whichever `login_hint` was
/// passed and redirects, so there is nothing else for a driver to click through.
///
/// Shared by [FakeOAuthBrowser] (the in-app PKCE flow a real login screen drives) and this
/// directory's `apiLoginAs`/`activateInvitationViaMock` helpers (steps this suite has no mobile UI
/// to drive at all — see docs/testing/mobile-integration-suite.md's journey table).
Future<MockAuthorizationCode> resolveMockAuthorizationCode(
  Dio dio,
  Uri authorizeUrl,
) async {
  final response = await dio.getUri<void>(
    authorizeUrl,
    options: Options(followRedirects: false, validateStatus: (_) => true),
  );

  if (response.statusCode != 302) {
    throw StateError(
      'mock IdP /authorize returned ${response.statusCode}, expected 302 (${authorizeUrl.path})',
    );
  }

  final location = response.headers.value('location');
  if (location == null) {
    throw StateError('mock IdP /authorize redirected with no Location header');
  }

  final redirected = Uri.parse(location);
  final code = redirected.queryParameters['code'];
  final state = redirected.queryParameters['state'];
  if (code == null || state == null) {
    throw StateError('mock IdP /authorize redirect carried no code/state: $location');
  }

  return MockAuthorizationCode(code: code, state: state);
}

/// Builds the mock IdP's authorization URL for a mobile PKCE `mobile-start` response, exactly as
/// `AuthNotifier._buildAuthorizationUrl`'s `mock` branch does — duplicated here (not imported
/// from `lib/`) because that method is private; both build the identical URL shape against
/// `dev/mock-idp.ts`'s `/authorize`.
Uri buildMockAuthorizeUrl({
  required Uri apiBaseUrl,
  required String state,
  required String nonce,
  required String codeChallenge,
  String? loginHint,
}) {
  return apiBaseUrl.replace(
    path: '/mock-idp/authorize',
    queryParameters: {
      'client_id': mockOAuthClientId,
      'redirect_uri': mockOAuthRedirectUri,
      'response_type': 'code',
      'scope': 'openid email profile',
      'state': state,
      'nonce': nonce,
      'code_challenge': codeChallenge,
      'code_challenge_method': 'S256',
      'login_hint': ?loginHint,
    },
  );
}
