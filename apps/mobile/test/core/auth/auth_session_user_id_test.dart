import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';

void main() {
  AuthSession session() => AuthSession(
        authClient: MobileAuthClient(baseUrl: 'http://localhost'),
        secureStore: FakeSecureTokenStore(),
      );

  test('userId is null before any tokens are saved', () async {
    final auth = session();
    await auth.restore();

    expect(auth.userId, isNull);
  });

  test('saveTokens decodes the sub claim from the access token', () async {
    final auth = session();

    // fakeAccessToken always carries `sub: 'test-user'` — see fake_access_token.dart.
    await auth.saveTokens(
      accessToken: fakeAccessToken(),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    expect(auth.userId, 'test-user');
  });

  test('userId survives a restore from secure storage', () async {
    final store = FakeSecureTokenStore();
    final auth = AuthSession(
      authClient: MobileAuthClient(baseUrl: 'http://localhost'),
      secureStore: store,
    );
    await auth.saveTokens(
      accessToken: fakeAccessToken(),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    final restored = AuthSession(
      authClient: MobileAuthClient(baseUrl: 'http://localhost'),
      secureStore: store,
    );
    await restored.restore();

    expect(restored.userId, 'test-user');
  });

  test('clear resets userId back to null', () async {
    final auth = session();
    await auth.saveTokens(
      accessToken: fakeAccessToken(),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );
    expect(auth.userId, isNotNull);

    await auth.clear();

    expect(auth.userId, isNull);
  });
}
