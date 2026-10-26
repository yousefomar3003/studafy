import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/account_profile.dart';
import 'package:studafy_mobile/src/core/api/generated/models/school3.dart';
import 'package:studafy_mobile/src/core/auth/auth_notifier.dart';
import 'package:studafy_mobile/src/core/auth/auth_state.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/shell/presentation/delete_account_screen.dart';
import 'package:studafy_mobile/src/features/shell/presentation/deletion_pending_screen.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';
import 'package:studafy_mobile/src/features/shell/presentation/profile_tab_screen.dart';

import '../../support/pump_app_shell.dart';
import '../../support/pump_studafy_app.dart';

typedef _DeleteCall = ({String? memberId, String? password});

/// "Delete my account" (App Store 5.1.1(v), Google Play): the button stays disabled until the
/// person ticks the acknowledgement, types DELETE and — for member-password accounts — enters
/// their member ID and password; a final dialog confirms; the deletion is scheduled 14 days out and
/// the device signs out. Signing in while it is pending shows only "Cancel deletion" / "Sign out".
void main() {
  group('the Delete account requirements', () {
    testWidgets('an email account needs the acknowledgement and DELETE typed', (
      tester,
    ) async {
      final calls = <_DeleteCall>[];
      final container = await _pumpOnDeleteAccount(
        tester,
        memberAccount: false,
        delete: ({memberId, password}) async {
          calls.add((memberId: memberId, password: password));
          return DateTime.utc(2026, 11, 1);
        },
      );

      expect(find.byKey(const Key('deleteAccountMemberId')), findsNothing);
      expect(_confirmEnabled(tester), isFalse);

      await _tapAcknowledge(tester);
      expect(_confirmEnabled(tester), isFalse);

      await _type(tester, 'deleteAccountConfirmation', 'DELET');
      expect(_confirmEnabled(tester), isFalse);
      await _type(tester, 'deleteAccountConfirmation', 'delete');
      expect(_confirmEnabled(tester), isTrue);

      await _confirm(tester);
      expect(calls, [(memberId: null, password: null)]);
      expect(find.text('Deletion scheduled'), findsOneWidget);

      await tester.tap(find.byKey(const Key('deleteAccountDone')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(container.read(authNotifierProvider), AuthStatus.unauthenticated);
    });

    testWidgets('a member account must also enter its member ID and password', (
      tester,
    ) async {
      final calls = <_DeleteCall>[];
      await _pumpOnDeleteAccount(
        tester,
        memberAccount: true,
        delete: ({memberId, password}) async {
          calls.add((memberId: memberId, password: password));
          return DateTime.utc(2026, 11, 1);
        },
      );

      await _tapAcknowledge(tester);
      await _type(tester, 'deleteAccountConfirmation', 'DELETE');
      expect(_confirmEnabled(tester), isFalse);

      await _type(tester, 'deleteAccountMemberId', ' PAR-0001 ');
      expect(_confirmEnabled(tester), isFalse);
      await _type(tester, 'deleteAccountPassword', 'secret-pass');
      expect(_confirmEnabled(tester), isTrue);

      await _confirm(tester);
      expect(calls, [(memberId: 'PAR-0001', password: 'secret-pass')]);
    });

    testWidgets('wrong credentials stay signed in and say so', (tester) async {
      final container = await _pumpOnDeleteAccount(
        tester,
        memberAccount: true,
        delete: ({memberId, password}) async =>
            throw _apiError(422, 'ACCOUNT_DELETION_VERIFICATION_FAILED'),
      );

      await _tapAcknowledge(tester);
      await _type(tester, 'deleteAccountConfirmation', 'DELETE');
      await _type(tester, 'deleteAccountMemberId', 'PAR-0001');
      await _type(tester, 'deleteAccountPassword', 'wrong');
      await tester.tap(find.byKey(const Key('deleteAccountConfirm')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('deleteAccountDialogConfirm')));
      await tester.pumpAndSettle();

      expect(
        find.text('The member ID or password is incorrect.'),
        findsOneWidget,
      );
      expect(container.read(authNotifierProvider), AuthStatus.authenticated);
    });

    testWidgets('cancelling the dialog deletes nothing', (tester) async {
      var calls = 0;
      await _pumpOnDeleteAccount(
        tester,
        memberAccount: false,
        delete: ({memberId, password}) async {
          calls++;
          return DateTime.utc(2026, 11, 1);
        },
      );

      await _tapAcknowledge(tester);
      await _type(tester, 'deleteAccountConfirmation', 'DELETE');
      await tester.tap(find.byKey(const Key('deleteAccountConfirm')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('deleteAccountCancel')));
      await tester.pumpAndSettle();

      expect(calls, 0);
    });
  });

  testWidgets('a pending deletion replaces the shell until it is cancelled', (
    tester,
  ) async {
    var scheduled = true;
    var cancels = 0;
    await pumpAppShell(
      tester,
      session: await fakeAuthenticatedSession(roles: const ['PARENT']),
      overrides: [
        accountProfileProvider.overrideWith(
          (ref) async => _profile(
            memberAccount: false,
            scheduledFor: scheduled ? DateTime.utc(2026, 11, 1) : null,
          ),
        ),
        cancelAccountDeletionProvider.overrideWith(
          (ref) => () async {
            cancels++;
            scheduled = false;
            ref.invalidate(accountProfileProvider);
          },
        ),
      ],
    );
    await tester.pumpAndSettle();

    expect(find.byType(DeletionPendingScreen), findsOneWidget);
    expect(find.byType(PillNavigationBar), findsNothing);
    expect(find.byKey(const Key('deletionPendingSignOut')), findsOneWidget);

    await tester.tap(find.byKey(const Key('deletionPendingCancel')));
    await tester.pumpAndSettle();

    expect(cancels, 1);
    expect(find.byType(DeletionPendingScreen), findsNothing);
    expect(find.byType(PillNavigationBar), findsOneWidget);
  });
}

AccountProfile _profile({
  required bool memberAccount,
  DateTime? scheduledFor,
}) => AccountProfile(
  userId: 'user-1',
  displayName: 'Test Parent',
  email: memberAccount ? null : 'parent@example.com',
  memberIds: memberAccount ? const ['PAR-0001'] : const [],
  deletionScheduledFor: scheduledFor,
  deletionRequiresMemberCredentials: memberAccount,
  school: const School3(id: 'school-1', name: 'Al Noor Academy'),
);

/// Pumps a PARENT shell with [delete] standing in for the API, opens Profile → Delete my account,
/// and returns the provider container.
Future<ProviderContainer> _pumpOnDeleteAccount(
  WidgetTester tester, {
  required bool memberAccount,
  required Future<DateTime> Function({String? memberId, String? password})
  delete,
}) async {
  await pumpAppShell(
    tester,
    session: await fakeAuthenticatedSession(roles: const ['PARENT']),
    overrides: [
      accountProfileProvider.overrideWith(
        (ref) async => _profile(memberAccount: memberAccount),
      ),
      deleteOwnAccountProvider.overrideWithValue(delete),
    ],
  );
  await tester.tap(
    find.descendant(
      of: find.byType(PillNavigationBar),
      matching: find.byIcon(Icons.person_outline),
    ),
  );
  await tester.pumpAndSettle();
  // "Delete my account" lives under Profile -> Sign-in & security.
  // The floating nav bar overlaps the bottom of the short test viewport.
  await tester.ensureVisible(find.byKey(const Key('profileSignInSecurity')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('profileSignInSecurity')));
  await tester.pumpAndSettle();
  expect(find.byType(SignInSecurityScreen), findsOneWidget);
  await tester.tap(find.byKey(const Key('profileDeleteAccount')));
  await tester.pumpAndSettle();
  expect(find.byType(DeleteAccountScreen), findsOneWidget);

  return ProviderScope.containerOf(
    tester.element(find.byType(DeleteAccountScreen)),
  );
}

Future<void> _tapAcknowledge(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('deleteAccountAcknowledge')));
  await tester.tap(find.byKey(const Key('deleteAccountAcknowledge')));
  await tester.pump();
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.enterText(find.byKey(Key(key)), text);
  await tester.pump();
}

/// Taps the enabled button, confirms the dialog, and waits for the success dialog.
Future<void> _confirm(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('deleteAccountConfirm')));
  await tester.tap(find.byKey(const Key('deleteAccountConfirm')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('deleteAccountDialogConfirm')));
  // Not pumpAndSettle: the button's spinner keeps animating behind the success dialog.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
}

bool _confirmEnabled(WidgetTester tester) {
  final button = tester.widget<ButtonStyleButton>(
    find.descendant(
      of: find.byKey(const Key('deleteAccountConfirm')),
      matching: find.byWidgetPredicate((widget) => widget is ButtonStyleButton),
      matchRoot: true,
    ),
  );
  return button.onPressed != null;
}

DioException _apiError(int status, String code) {
  final options = RequestOptions(path: '/api/account/deletion');
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
