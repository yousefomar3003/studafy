import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/auth_interceptor.dart';
import 'package:studafy_mobile/src/core/api/error_mapping_interceptor.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/auth/school_closed_notice.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';

/// How the app reacts when the API says the school is closed (`SCHOOL_SUSPENDED`): on any
/// authenticated request, on refresh, and on sign-in. The session ends locally, once, and the
/// closed-school notice is raised for the login screen.
void main() {
  group('AuthInterceptor', () {
    late Dio dio;
    late int closedCalls;
    late int renewals;
    late String? token;

    setUp(() {
      closedCalls = 0;
      renewals = 0;
      token = 'access';
      dio = Dio(
        BaseOptions(baseUrl: 'http://localhost'),
      )..httpClientAdapter = _Adapter((_) => _problem(403, 'SCHOOL_SUSPENDED'));
      dio.interceptors
        ..add(
          AuthInterceptor(
            () async => token,
            onUnauthorized: () async {
              renewals++;
              return false;
            },
            onSchoolClosed: () async => closedCalls++,
            retryClient: dio,
          ),
        )
        ..add(ErrorMappingInterceptor());
    });

    test(
      'an authenticated SCHOOL_SUSPENDED ends the session without trying to renew',
      () async {
        await expectLater(
          dio.get<dynamic>('/api/students/me'),
          throwsA(
            isA<DioException>().having(
              (e) => isSchoolClosedError(e),
              'is school closed',
              isTrue,
            ),
          ),
        );

        expect(closedCalls, 1);
        expect(renewals, 0);
      },
    );

    test(
      'an anonymous request answering SCHOOL_SUSPENDED is left alone',
      () async {
        token = null;

        await expectLater(
          dio.get<dynamic>('/api/auth/invitations/abc'),
          throwsA(isA<DioException>()),
        );

        expect(closedCalls, 0);
      },
    );

    test('other errors do not trigger it', () async {
      dio.httpClientAdapter = _Adapter((_) => _problem(403, 'AUTHZ_FORBIDDEN'));

      await expectLater(
        dio.get<dynamic>('/api/students/me'),
        throwsA(isA<DioException>()),
      );

      expect(closedCalls, 0);
    });
  });

  group('AuthNotifier', () {
    test(
      'a refresh refused with SCHOOL_SUSPENDED signs out and raises the notice',
      () async {
        final container = await _signedInContainer(
          (_) => _problem(403, 'SCHOOL_SUSPENDED'),
        );

        final renewed = await container
            .read(authNotifierProvider.notifier)
            .handleAuthFailure();

        expect(renewed, isFalse);
        expect(
          container.read(authNotifierProvider),
          AuthStatus.unauthenticated,
        );
        expect(container.read(schoolClosedNoticeProvider), isTrue);
        expect(container.read(authSessionProvider).isAuthenticated, isFalse);
      },
    );

    test(
      'a refresh refused for another reason signs out without the notice',
      () async {
        final container = await _signedInContainer(
          (_) => _problem(401, 'AUTH_TOKEN_INVALID'),
        );

        await container.read(authNotifierProvider.notifier).handleAuthFailure();

        expect(
          container.read(authNotifierProvider),
          AuthStatus.unauthenticated,
        );
        expect(container.read(schoolClosedNoticeProvider), isFalse);
      },
    );

    test('many failing requests at once share a single sign-out', () async {
      final store = _CountingTokenStore();
      final container = await _signedInContainer(
        (_) => _problem(500, 'INTERNAL_ERROR'),
        store: store,
      );
      final notifier = container.read(authNotifierProvider.notifier);

      await Future.wait([
        notifier.handleSchoolClosed(),
        notifier.handleSchoolClosed(),
        notifier.handleSchoolClosed(),
      ]);

      expect(store.clears, 1);
      expect(container.read(authNotifierProvider), AuthStatus.unauthenticated);
      expect(container.read(schoolClosedNoticeProvider), isTrue);
    });
  });
}

Future<ProviderContainer> _signedInContainer(
  ResponseBody Function(RequestOptions options) respond, {
  FakeSecureTokenStore? store,
}) async {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
    ..httpClientAdapter = _Adapter(respond);
  final client = MobileAuthClient(baseUrl: 'http://localhost', dio: dio);
  final session = AuthSession(
    authClient: client,
    secureStore: store ?? FakeSecureTokenStore(),
  );
  await session.saveTokens(
    accessToken: fakeAccessToken(roles: const ['STUDENT']),
    refreshToken: 'refresh',
    sessionId: 'session',
    expiresIn: 3600,
  );
  if (store is _CountingTokenStore) store.clears = 0;

  final container = ProviderContainer(
    overrides: [
      appConfigProvider.overrideWithValue(
        AppConfig.fromEnvironment(AppEnvironment.dev),
      ),
      authClientProvider.overrideWithValue(client),
      authSessionProvider.overrideWithValue(session),
    ],
  );
  addTearDown(container.dispose);

  // Let the notifier's restore settle into `authenticated`.
  container.read(authNotifierProvider);
  for (
    var i = 0;
    i < 20 && container.read(authNotifierProvider) == AuthStatus.loading;
    i++
  ) {
    await Future<void>.delayed(Duration.zero);
  }
  expect(container.read(authNotifierProvider), AuthStatus.authenticated);
  return container;
}

class _CountingTokenStore extends FakeSecureTokenStore {
  int clears = 0;

  @override
  Future<void> clear() {
    clears++;
    return super.clear();
  }
}

ResponseBody _problem(int status, String code) => ResponseBody.fromString(
  jsonEncode({
    'type': 'about:blank',
    'title': 'Error',
    'status': status,
    'code': code,
  }),
  status,
  headers: {
    Headers.contentTypeHeader: ['application/problem+json'],
  },
);

class _Adapter implements HttpClientAdapter {
  _Adapter(this.respond);

  final ResponseBody Function(RequestOptions options) respond;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => respond(options);

  @override
  void close({bool force = false}) {}
}
