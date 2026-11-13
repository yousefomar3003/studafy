import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/session.dart';
import 'package:studafy_mobile/src/core/api/generated/models/session_channel.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/account/application/account_settings_providers.dart';
import 'package:studafy_mobile/src/features/account/presentation/signed_in_devices_screen.dart';

import '../../support/pump_studafy_app.dart';
import 'account_test_app.dart';

Session _session(
  String id, {
  String? name,
  SessionChannel channel = SessionChannel.mobile,
}) {
  final issued = DateTime.now().subtract(const Duration(hours: 2));
  return Session(
    id: id,
    deviceId: null,
    deviceName: name,
    channel: channel,
    userAgent: null,
    ipAddress: null,
    issuedAt: issued,
    expiresAt: issued.add(const Duration(days: 30)),
  );
}

void main() {
  testWidgets('marks this device, and signs out another one or all of them', (
    tester,
  ) async {
    final session = await fakeAuthenticatedSession(roles: const ['STUDENT']);
    final signedOut = <String>[];
    final signedOutAll = <List<Session>>[];
    final sessions = [
      _session('fake-session-id', name: 'My phone'),
      _session('other-1', channel: SessionChannel.web),
    ];

    await pumpAccountScreen(
      tester,
      ProviderScope(
        overrides: [
          authSessionProvider.overrideWithValue(session),
          signedInSessionsProvider.overrideWith((ref) async => sessions),
          signOutSessionProvider.overrideWithValue(
            (id) async => signedOut.add(id),
          ),
          signOutOtherSessionsProvider.overrideWithValue(
            (all) async => signedOutAll.add(all),
          ),
        ],
        child: accountScreenApp(const SignedInDevicesScreen()),
      ),
    );

    expect(find.text('My phone'), findsOneWidget);
    expect(find.text('This device'), findsOneWidget);
    expect(find.text('Web browser'), findsOneWidget);
    // Only the other session can be signed out from its row.
    expect(find.widgetWithText(TextButton, 'Sign out'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
    await tester.pumpAndSettle();
    expect(signedOut, ['other-1']);

    await tester.tap(find.byKey(const Key('signOutOtherSessions')));
    await tester.pumpAndSettle();
    expect(find.text('Sign out everywhere else?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Sign out').last);
    await tester.pumpAndSettle();
    expect(signedOutAll, [sessions]);
  });

  testWidgets('offers no bulk sign-out when this is the only session', (
    tester,
  ) async {
    final session = await fakeAuthenticatedSession(roles: const ['PARENT']);

    await pumpAccountScreen(
      tester,
      ProviderScope(
        overrides: [
          authSessionProvider.overrideWithValue(session),
          signedInSessionsProvider.overrideWith(
            (ref) async => [_session('fake-session-id')],
          ),
        ],
        child: accountScreenApp(const SignedInDevicesScreen()),
      ),
    );

    expect(find.text('Mobile app'), findsOneWidget);
    expect(find.byKey(const Key('signOutOtherSessions')), findsNothing);
  });
}
