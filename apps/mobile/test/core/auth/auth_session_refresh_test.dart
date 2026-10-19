import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';

/// Answers `/api/auth/refresh` with [respond]; counts the calls.
class _RefreshAdapter implements HttpClientAdapter {
  _RefreshAdapter(this.respond);

  final Future<ResponseBody> Function(RequestOptions options) respond;
  int calls = 0;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    calls++;
    return respond(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(int status, Map<String, dynamic> body) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

void main() {
  final renewedToken = fakeAccessToken(
    expiresAt: DateTime.now().add(const Duration(minutes: 15)),
  );

  Future<AuthSession> signedIn(
    _RefreshAdapter adapter, {
    required int expiresIn,
  }) async {
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
      ..httpClientAdapter = adapter;
    final session = AuthSession(
      authClient: MobileAuthClient(baseUrl: 'http://localhost', dio: dio),
      secureStore: FakeSecureTokenStore(),
    );
    await session.restore();
    await session.saveTokens(
      accessToken: 'old-access',
      refreshToken: 'refresh',
      sessionId: 'session',
      expiresIn: expiresIn,
    );
    return session;
  }

  test(
    'a token that is about to expire is renewed before it is handed out',
    () async {
      final adapter = _RefreshAdapter(
        (_) async => _json(200, {
          'access_token': renewedToken,
          'token_type': 'Bearer',
          'expires_in': 900,
          'session_id': 'session',
          'refresh_token': 'refresh-2',
        }),
      );
      final session = await signedIn(adapter, expiresIn: 30);

      expect(await session.tokenProvider, renewedToken);
      expect(adapter.calls, 1);
    },
  );

  test('a fresh token is handed out without a renewal', () async {
    final adapter = _RefreshAdapter((_) async => _json(500, {}));
    final session = await signedIn(adapter, expiresIn: 3600);

    expect(await session.tokenProvider, 'old-access');
    expect(adapter.calls, 0);
  });

  test(
    'a renewal that fails on connectivity keeps the user signed in',
    () async {
      final adapter = _RefreshAdapter(
        (options) async => throw DioException.connectionError(
          requestOptions: options,
          reason: 'offline',
        ),
      );
      final session = await signedIn(adapter, expiresIn: 30);

      expect(await session.tokenProvider, 'old-access');
      expect(session.isAuthenticated, isTrue);
    },
  );

  test('a refresh token the server rejects ends the session', () async {
    final adapter = _RefreshAdapter(
      (_) async => _json(401, {'title': 'Unauthorized'}),
    );
    final session = await signedIn(adapter, expiresIn: 30);

    expect(await session.tokenProvider, isNull);
    expect(session.isAuthenticated, isFalse);
  });
}
