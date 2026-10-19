import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/auth/school_closed_notice.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/fake_access_token.dart';
import '../../support/pump_studafy_app.dart';

const _message = 'This app is no longer available for your school.';

/// The closed-school notice on the login screen, through the real app (router, auth guard,
/// [AuthNotifier], [MobileAuthClient]); only the network is faked.
void main() {
  testWidgets(
    'a pending notice is shown as a persistent message on the login screen',
    (tester) async {
      await _pumpWith(tester, (_) => _json(500, {}), noticeShown: true);

      expect(find.byKey(const Key('schoolClosedNotice')), findsOneWidget);
      expect(find.text(_message), findsOneWidget);
      expect(find.byType(SnackBar), findsNothing);

      // Still there after time passes — it is not a transient snackbar.
      await tester.pump(const Duration(seconds: 10));
      expect(find.text(_message), findsOneWidget);
    },
  );

  testWidgets('a sign-in refused with SCHOOL_SUSPENDED shows the notice', (
    tester,
  ) async {
    await _pumpWith(
      tester,
      (_) => _json(403, {
        'type': 'about:blank',
        'title': 'Forbidden',
        'status': 403,
        'code': 'SCHOOL_SUSPENDED',
        'detail': 'This school has been closed and is no longer available.',
      }),
    );
    expect(find.byKey(const Key('schoolClosedNotice')), findsNothing);

    await _signIn(tester);

    expect(find.byKey(const Key('schoolClosedNotice')), findsOneWidget);
    expect(find.text(_message), findsWidgets);
    expect(find.byKey(const Key('brandLogo')), findsOneWidget);
  });

  testWidgets('a successful sign-in clears the notice', (tester) async {
    await _pumpWith(
      tester,
      (_) => _json(200, {
        'access_token': fakeAccessToken(
          roles: const ['STUDENT'],
          sub: 'student',
        ),
        'token_type': 'Bearer',
        'expires_in': 900,
        'session_id': '00000000-0000-0000-0000-000000000001',
        'refresh_token': 'refresh',
      }),
      noticeShown: true,
    );
    expect(find.byKey(const Key('schoolClosedNotice')), findsOneWidget);

    await _signIn(tester);

    expect(find.byType(PillNavigationBar), findsOneWidget);
    expect(find.byKey(const Key('schoolClosedNotice')), findsNothing);
  });
}

class _ShownNotice extends SchoolClosedNoticeNotifier {
  @override
  bool build() => true;
}

Future<void> _pumpWith(
  WidgetTester tester,
  ResponseBody Function(RequestOptions options) respond, {
  bool noticeShown = false,
}) {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
    ..httpClientAdapter = _FakeAdapter(respond);
  return pumpStudafyApp(
    tester,
    extraOverrides: [
      authClientProvider.overrideWithValue(
        MobileAuthClient(baseUrl: 'http://localhost', dio: dio),
      ),
      if (noticeShown)
        schoolClosedNoticeProvider.overrideWith(_ShownNotice.new),
    ],
  );
}

Future<void> _signIn(WidgetTester tester) async {
  await tester.enterText(
    find.byKey(const Key('memberSignInUsername')),
    'STU-100001',
  );
  await tester.enterText(
    find.byKey(const Key('memberSignInPassword')),
    'secret',
  );
  await tester.ensureVisible(find.byKey(const Key('memberSignInSubmit')));
  await tester.tap(find.byKey(const Key('memberSignInSubmit')));
  await tester.pumpAndSettle();
}

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
