import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';

import '../../support/fake_access_token.dart';
import '../../support/pump_studafy_app.dart';

/// The reviewer email/password sign-in (ST-303), driven through the real app: login screen,
/// [AuthNotifier], [MobileAuthClient] and the auth guard. Only the network is faked.
void main() {
  testWidgets('valid reviewer credentials sign in and leave the login screen', (tester) async {
    late RequestOptions sent;
    await _pumpWith(tester, (options) {
      sent = options;
      return _json(200, {
        'access_token': fakeAccessToken(roles: const ['STUDENT'], sub: 'reviewer'),
        'token_type': 'Bearer',
        'expires_in': 900,
        'session_id': '00000000-0000-0000-0000-000000000001',
        'refresh_token': 'refresh',
      });
    });

    await _signIn(tester, ' student@review.studafy.test ', 'secret');

    expect(sent.path, '/api/auth/login/review');
    expect(sent.data, {
      'email': 'student@review.studafy.test',
      'password': 'secret',
      'channel': 'mobile',
    });
    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.text('Sign in with Microsoft'), findsNothing);
  });

  testWidgets('rejected credentials show a specific error and stay on the form', (tester) async {
    await _pumpWith(
      tester,
      (_) => _json(401, {
        'type': 'about:blank',
        'title': 'Unauthorized',
        'status': 401,
        'code': 'AUTH_INVALID_CREDENTIALS',
        'detail': 'Invalid email or password.',
      }),
    );

    await _signIn(tester, 'student@review.studafy.test', 'wrong');

    expect(find.text('Incorrect email or password.'), findsOneWidget);
    expect(find.byKey(const Key('emailSignInSubmit')), findsOneWidget);
    // The browser-flow snackbar is not shown for this path.
    expect(find.text('Sign-in was cancelled or failed.'), findsNothing);
  });

  testWidgets('empty fields are validated before any request', (tester) async {
    var requests = 0;
    await _pumpWith(tester, (_) {
      requests++;
      return _json(500, {});
    });

    await tester.tap(find.byKey(const Key('emailSignInToggle')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('emailSignInSubmit')));
    await tester.pumpAndSettle();

    expect(find.text('Enter your email address.'), findsOneWidget);
    expect(find.text('Enter your password.'), findsOneWidget);
    expect(requests, 0);
  });
}

Future<void> _pumpWith(
  WidgetTester tester,
  ResponseBody Function(RequestOptions options) respond,
) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
    ..httpClientAdapter = _FakeAdapter(respond);
  return pumpStudafyApp(
    tester,
    extraOverrides: [
      authClientProvider.overrideWithValue(
        MobileAuthClient(baseUrl: 'http://localhost', dio: dio),
      ),
    ],
  );
}

Future<void> _signIn(WidgetTester tester, String email, String password) async {
  await tester.tap(find.byKey(const Key('emailSignInToggle')));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const Key('emailSignInEmail')), email);
  await tester.enterText(find.byKey(const Key('emailSignInPassword')), password);
  await tester.tap(find.byKey(const Key('emailSignInSubmit')));
  await tester.pumpAndSettle();
}

ResponseBody _json(int status, Map<String, Object?> body) => ResponseBody.fromString(
  jsonEncode(body),
  status,
  headers: {
    Headers.contentTypeHeader: [
      status < 300 ? 'application/json' : 'application/problem+json',
    ],
  },
);

class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this.respond);

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
