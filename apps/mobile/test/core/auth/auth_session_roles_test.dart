import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';

String _tokenWithRawPayload(Map<String, dynamic> payload) {
  String segment(Object value) =>
      base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
  return '${segment({
        'alg': 'none',
      })}.${segment(payload)}.';
}

void main() {
  AuthSession session() => AuthSession(
        authClient: MobileAuthClient(baseUrl: 'http://localhost'),
        secureStore: FakeSecureTokenStore(),
      );

  test('roles is empty before any tokens are saved', () async {
    final auth = session();
    await auth.restore();

    expect(auth.isAuthenticated, isFalse);
    expect(auth.roles, isEmpty);
  });

  test('saveTokens decodes the roles claim from the access token', () async {
    final auth = session();

    await auth.saveTokens(
      accessToken: fakeAccessToken(roles: const ['STUDENT', 'PARENT']),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    expect(auth.isAuthenticated, isTrue);
    expect(auth.roles, ['STUDENT', 'PARENT']);
  });

  test('roles survive a restore from secure storage', () async {
    final store = FakeSecureTokenStore();
    final auth = AuthSession(
      authClient: MobileAuthClient(baseUrl: 'http://localhost'),
      secureStore: store,
    );
    await auth.saveTokens(
      accessToken: fakeAccessToken(roles: const ['INSTRUCTOR']),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    // A fresh AuthSession over the same (fake) persisted storage, as if the app restarted.
    final restored = AuthSession(
      authClient: MobileAuthClient(baseUrl: 'http://localhost'),
      secureStore: store,
    );
    await restored.restore();

    expect(restored.isAuthenticated, isTrue);
    expect(restored.roles, ['INSTRUCTOR']);
  });

  test('clear resets roles back to empty', () async {
    final auth = session();
    await auth.saveTokens(
      accessToken: fakeAccessToken(roles: const ['STUDENT']),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );
    expect(auth.roles, isNotEmpty);

    await auth.clear();

    expect(auth.isAuthenticated, isFalse);
    expect(auth.roles, isEmpty);
  });

  test('a roles claim with non-string entries drops just those entries', () async {
    final auth = session();
    await auth.saveTokens(
      accessToken: _tokenWithRawPayload({
        'roles': ['STUDENT', 42, null],
        'exp': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000,
      }),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    expect(auth.roles, ['STUDENT']);
  });

  test('a missing roles claim decodes to empty rather than throwing', () async {
    final auth = session();
    await auth.saveTokens(
      accessToken: _tokenWithRawPayload({
        'exp': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000,
      }),
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: 3600,
    );

    expect(auth.isAuthenticated, isTrue);
    expect(auth.roles, isEmpty);
  });
}
