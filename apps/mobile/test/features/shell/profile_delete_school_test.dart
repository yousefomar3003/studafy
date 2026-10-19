import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/current_school.dart';
import 'package:studafy_mobile/src/core/api/generated/models/current_school_status.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/core/auth/oauth_client.dart';
import 'package:studafy_mobile/src/core/auth/school_closed_notice.dart';
import 'package:studafy_mobile/src/features/shell/application/school_closure_providers.dart';
import 'package:studafy_mobile/src/features/shell/presentation/delete_school_screen.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';

import '../../support/fake_access_token.dart';
import '../../support/fake_secure_token_store.dart';
import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

const _schoolName = 'Al Noor Academy';

/// "Delete school" on the Profile tab: only the school admin (ORG_ADMIN) gets it — every role,
/// the admin included, also gets "Delete my account" — and its confirmation screen closes the school only after the
/// admin types the school's name, then signs this device out with the closed-school notice.
void main() {
  group('the Profile tab offers account deletion to every role', () {
    for (final roles in const [
      ['STUDENT'],
      ['PARENT'],
      ['INSTRUCTOR'],
      ['FINANCE'],
      ['SUPER_ADMIN'],
      ['SUPPORT_AGENT'],
      ['GUEST'],
    ]) {
      testWidgets('${roles.first} sees "Delete my account" only', (
        tester,
      ) async {
        await pumpAppShell(
          tester,
          session: await fakeAuthenticatedSession(roles: roles),
        );
        await _openProfile(tester);

        expect(find.byKey(const Key('profileDeleteSchool')), findsNothing);
        expect(find.byKey(const Key('profileDeleteAccount')), findsOneWidget);
        expect(find.text('Delete school'), findsNothing);
        expect(find.byKey(const Key('profilePrivacyPolicy')), findsOneWidget);
      });
    }

    testWidgets('ORG_ADMIN sees both deletion actions and the privacy policy', (
      tester,
    ) async {
      await pumpAppShell(
        tester,
        session: await fakeAuthenticatedSession(roles: const ['ORG_ADMIN']),
      );
      await _openProfile(tester);

      expect(find.byKey(const Key('profileDeleteSchool')), findsOneWidget);
      expect(find.text('Delete school'), findsOneWidget);
      expect(find.byKey(const Key('profileDeleteAccount')), findsOneWidget);
      expect(find.byKey(const Key('profilePrivacyPolicy')), findsOneWidget);
    });
  });

  group('the Delete school confirmation', () {
    testWidgets('enables the button only once the school name is typed exactly', (
      tester,
    ) async {
      await _pumpAdminOnDeleteSchool(tester, close: (_) async {});

      expect(find.byKey(const Key('deleteSchoolName')), findsOneWidget);
      expect(
        find.text('Nobody at your school can sign in to Studafy again.'),
        findsOneWidget,
      );
      expect(
        find.text("Your school's data is kept. Nothing is deleted."),
        findsOneWidget,
      );
      expect(_confirmEnabled(tester), isFalse);

      await tester.enterText(
        find.byKey(const Key('deleteSchoolNameField')),
        'Al Noor',
      );
      await tester.pump();
      expect(_confirmEnabled(tester), isFalse);

      await tester.enterText(
        find.byKey(const Key('deleteSchoolNameField')),
        'Al Noor Academy X',
      );
      await tester.pump();
      expect(_confirmEnabled(tester), isFalse);

      // Same comparison as the server: surrounding whitespace and letter case don't matter.
      await tester.enterText(
        find.byKey(const Key('deleteSchoolNameField')),
        '  al noor ACADEMY ',
      );
      await tester.pump();
      expect(_confirmEnabled(tester), isTrue);
    });

    testWidgets(
      'a successful closure signs out and raises the closed-school notice',
      (tester) async {
        final sent = <String>[];
        final container = await _pumpAdminOnDeleteSchool(
          tester,
          close: (name) async => sent.add(name),
        );

        await tester.enterText(
          find.byKey(const Key('deleteSchoolNameField')),
          _schoolName,
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('deleteSchoolConfirm')));
        // Not pumpAndSettle: the button keeps its progress spinner until the router (absent here)
        // replaces the shell with the login screen.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));

        expect(sent, [_schoolName]);
        expect(
          container.read(authNotifierProvider),
          AuthStatus.unauthenticated,
        );
        expect(container.read(schoolClosedNoticeProvider), isTrue);
      },
    );

    testWidgets('a name the server rejects stays signed in and says so', (
      tester,
    ) async {
      final container = await _pumpAdminOnDeleteSchool(
        tester,
        close: (_) async =>
            throw _apiError(422, 'SCHOOL_CLOSURE_NAME_MISMATCH'),
      );

      await tester.enterText(
        find.byKey(const Key('deleteSchoolNameField')),
        _schoolName,
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('deleteSchoolConfirm')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('deleteSchoolError')), findsOneWidget);
      expect(
        find.text("The name you typed doesn't match your school's name."),
        findsOneWidget,
      );
      expect(container.read(authNotifierProvider), AuthStatus.authenticated);
      expect(container.read(schoolClosedNoticeProvider), isFalse);
    });
  });
}

/// Pumps the ORG_ADMIN shell with a fake school and [close], opens Profile → Delete school, and
/// returns the provider container.
Future<ProviderContainer> _pumpAdminOnDeleteSchool(
  WidgetTester tester, {
  required Future<void> Function(String name) close,
}) async {
  // The session's own client answers everything (the sign-out's best-effort revoke) with 204.
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
    ..httpClientAdapter = _NoContentAdapter();
  final client = MobileAuthClient(baseUrl: 'http://localhost', dio: dio);
  final session = AuthSession(
    authClient: client,
    secureStore: FakeSecureTokenStore(),
  );
  await session.saveTokens(
    accessToken: fakeAccessToken(roles: const ['ORG_ADMIN']),
    refreshToken: 'fake-refresh-token',
    sessionId: 'fake-session-id',
    expiresIn: 3600,
  );

  await pumpAppShell(
    tester,
    session: session,
    overrides: [
      authClientProvider.overrideWithValue(client),
      currentSchoolProvider.overrideWith(
        (ref) async => const CurrentSchool(
          id: 'school-1',
          name: _schoolName,
          status: CurrentSchoolStatus.active,
        ),
      ),
      closeSchoolProvider.overrideWithValue(close),
    ],
  );
  await _openProfile(tester);
  // The floating nav bar overlaps the bottom of the short test viewport.
  await tester.ensureVisible(find.byKey(const Key('profileDeleteSchool')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('profileDeleteSchool')));
  await tester.pumpAndSettle();
  expect(find.byType(DeleteSchoolScreen), findsOneWidget);

  return ProviderScope.containerOf(
    tester.element(find.byType(DeleteSchoolScreen)),
  );
}

bool _confirmEnabled(WidgetTester tester) {
  final button = tester.widget<ButtonStyleButton>(
    find.descendant(
      of: find.byKey(const Key('deleteSchoolConfirm')),
      matching: find.byWidgetPredicate((widget) => widget is ButtonStyleButton),
      matchRoot: true,
    ),
  );
  return button.onPressed != null;
}

DioException _apiError(int status, String code) {
  final options = RequestOptions(path: '/api/schools/current/closure');
  final response = Response<dynamic>(
    requestOptions: options,
    statusCode: status,
    data: {'status': status, 'title': 'Error', 'code': code},
  );
  return DioException(
    requestOptions: options,
    response: response,
    error: ApiException.fromResponse(response),
  );
}

Future<void> _openProfile(WidgetTester tester) async {
  await tester.tap(
    find.descendant(
      of: find.byType(PillNavigationBar),
      matching: find.byIcon(Icons.person_outline),
    ),
  );
  await tester.pumpAndSettle();
}

class _NoContentAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => ResponseBody.fromString('', 204);

  @override
  void close({bool force = false}) {}
}
