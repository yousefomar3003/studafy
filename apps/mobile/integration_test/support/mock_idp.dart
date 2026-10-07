import 'package:dio/dio.dart';

/// The app's deep link (`OAuthBrowser.redirectUri`) — a static constant, safe to duplicate here
/// rather than reaching into `lib/` for it.
const mockOAuthRedirectUri = 'studafy://auth/callback';

/// A browser following redirects never needs more than three hops here (API `/mobile-authorize` →
/// mock IdP `/authorize` → API callback → deep link); the cap only stops a redirect loop.
const _maxRedirects = 5;

class MockAuthorizationCode {
  const MockAuthorizationCode({required this.code, required this.state});

  final String code;
  final String state;
}

/// Follows the sign-in redirects hop by hop, as the system browser would, until one lands on the
/// app's deep link, and reads the one-time `code` and `state` off it. `dev/mock-idp.ts`'s
/// `/authorize` has no consent screen or login form: it issues a code immediately for whichever
/// `login_hint` was passed, so there is nothing to click through.
///
/// The chain is the production one: the API's `/mobile-authorize` sends the browser to the IdP,
/// the IdP returns to the API's own callback, and the callback hands off to the app (see
/// `apps/api/src/modules/auth/oauth/mobile-handoff.ts`).
///
/// Shared by [FakeOAuthBrowser] (the in-app flow a real login screen drives) and this directory's
/// `apiLoginAs`/`activateInvitationViaMock` helpers (steps this suite has no mobile UI to drive at
/// all — see docs/testing/mobile-integration-suite.md's journey table).
Future<MockAuthorizationCode> resolveMockAuthorizationCode(
  Dio dio,
  Uri authorizeUrl,
) async {
  var next = authorizeUrl;
  for (var hop = 0; hop < _maxRedirects; hop++) {
    final response = await dio.getUri<void>(
      next,
      options: Options(followRedirects: false, validateStatus: (_) => true),
    );
    if (response.statusCode != 302) {
      throw StateError(
        'sign-in redirect chain stopped with ${response.statusCode} at ${next.path}',
      );
    }

    final location = response.headers.value('location');
    if (location == null) {
      throw StateError('${next.path} redirected with no Location header');
    }

    final redirected = next.resolve(location);
    if (redirected.toString().startsWith(mockOAuthRedirectUri)) {
      final error = redirected.queryParameters['error'];
      if (error != null) throw StateError('sign-in failed: $error');
      final code = redirected.queryParameters['code'];
      final state = redirected.queryParameters['state'];
      if (code == null || state == null) {
        throw StateError('deep link carried no code/state: $location');
      }
      return MockAuthorizationCode(code: code, state: state);
    }
    next = redirected;
  }
  throw StateError('sign-in did not reach $mockOAuthRedirectUri within $_maxRedirects redirects');
}

/// The URL the system browser opens for a mobile `mobile-start` response, exactly as
/// `AuthNotifier._buildAuthorizationUrl` builds it — duplicated here (not imported from `lib/`)
/// because that method is private.
Uri buildMockAuthorizeUrl({
  required Uri apiBaseUrl,
  required String state,
  required String nonce,
  required String codeChallenge,
  String? loginHint,
}) {
  return apiBaseUrl.replace(
    path: '/api/auth/oauth/mock/mobile-authorize',
    queryParameters: {
      'state': state,
      'nonce': nonce,
      'code_challenge': codeChallenge,
      'login_hint': ?loginHint,
    },
  );
}
