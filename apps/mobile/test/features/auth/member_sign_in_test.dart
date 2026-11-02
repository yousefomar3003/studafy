import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/fake_access_token.dart';
import '../../support/pump_studafy_app.dart';

/// Member-ID + password sign-in driven through the real app: login screen, [AuthNotifier],
/// [MobileAuthClient] and the auth guard. Only the network is faked. The API refuses a session on
/// the starting password, so the form must collect a new one and resend.
void main() {
  testWidgets('first sign-in asks for a new password, then signs in with it', (
    tester,
  ) async {
    final sent = <Object?>[];
    await _pumpWith(tester, (options) {
      sent.add(options.data);
      final body = options.data as Map<String, Object?>;
      if (!body.containsKey('new_password')) {
        return _problem(
          403,
          'AUTH_PASSWORD_CHANGE_REQUIRED',
          'Set a new password.',
        );
      }
      return _json(200, {
        'access_token': fakeAccessToken(
          roles: const ['STUDENT'],
          sub: 'student',
        ),
        'token_type': 'Bearer',
        'expires_in': 900,
        'session_id': '00000000-0000-0000-0000-000000000001',
        'refresh_token': 'refresh',
      });
    });

    await _enter(tester, 'memberSignInUsername', ' stu-100001 ');
    await _enter(tester, 'memberSignInPassword', 'pass@1234');
    await _tap(tester, 'memberSignInSubmit');

    expect(find.byKey(const Key('memberSignInChangeRequired')), findsOneWidget);
    expect(sent.single, {
      'username': 'stu-100001',
      'password': 'pass@1234',
      'channel': 'mobile',
    });

    await _enter(tester, 'memberSignInNewPassword', 'Blue-Kite-42');
    await _enter(tester, 'memberSignInConfirmPassword', 'Blue-Kite-42');
    await _tap(tester, 'memberSignInSubmit');

    expect(sent.last, {
      'username': 'stu-100001',
      'password': 'pass@1234',
      'new_password': 'Blue-Kite-42',
      'channel': 'mobile',
    });
    expect(find.byType(PillNavigationBar), findsOneWidget);
  });

  testWidgets('a mismatched confirmation is caught before any request', (
    tester,
  ) async {
    var requests = 0;
    await _pumpWith(tester, (_) {
      requests++;
      return _problem(
        403,
        'AUTH_PASSWORD_CHANGE_REQUIRED',
        'Set a new password.',
      );
    });

    await _enter(tester, 'memberSignInUsername', 'PAR-100001');
    await _enter(tester, 'memberSignInPassword', 'pass@1234');
    await _tap(tester, 'memberSignInSubmit');
    expect(requests, 1);

    await _enter(tester, 'memberSignInNewPassword', 'Blue-Kite-42');
    await _enter(tester, 'memberSignInConfirmPassword', 'Blue-Kite-43');
    await _tap(tester, 'memberSignInSubmit');

    expect(find.text("The passwords don't match"), findsOneWidget);
    expect(requests, 1);
  });

  testWidgets('a locked account says so', (tester) async {
    await _pumpWith(
      tester,
      (_) => _problem(403, 'AUTH_ACCOUNT_LOCKED', 'Too many.'),
    );

    await _enter(tester, 'memberSignInUsername', 'TCH-100001');
    await _enter(tester, 'memberSignInPassword', 'wrong');
    await _tap(tester, 'memberSignInSubmit');

    expect(find.byKey(const Key('memberSignInError')), findsOneWidget);
    expect(find.textContaining('Too many wrong passwords'), findsOneWidget);
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

Future<void> _enter(WidgetTester tester, String key, String text) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(Key(key)), text);
}

Future<void> _tap(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
}

ResponseBody _problem(int status, String code, String detail) => _json(status, {
  'type': 'about:blank',
  'title': 'Error',
  'status': status,
  'code': code,
  'detail': detail,
});

ResponseBody _json(int status, Map<String, Object?> body) =>
    ResponseBody.fromString(
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
