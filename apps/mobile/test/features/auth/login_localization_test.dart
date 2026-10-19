import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/pump_studafy_app.dart';

/// The login screen renders fully in Arabic (RTL) and its language switch flips it to English
/// in place. One real-router test per file — see auth_guard_boot_test.dart.
void main() {
  testWidgets('login screen is localised and switches language in place', (
    tester,
  ) async {
    await pumpStudafyApp(tester, startLocale: const Locale('ar'));
    // ar.json is over the 50 KB threshold above which `rootBundle.loadString` decodes on a
    // background isolate, which never completes inside the test's fake-async zone.
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pumpAndSettle();

    expect(find.text('سياسة الخصوصية'), findsOneWidget);
    expect(find.text('Privacy policy'), findsNothing);
    expect(
      Directionality.of(
        tester.element(find.byKey(const Key('memberSignInSubmit'))),
      ),
      TextDirection.rtl,
    );

    await tester.ensureVisible(find.byKey(const Key('memberSignInSubmit')));
    await tester.tap(find.byKey(const Key('memberSignInSubmit')));
    await tester.pumpAndSettle();
    expect(find.text('أدخل الرقم الذي أعطتك إياه المدرسة'), findsOneWidget);

    // The top-end globe opens a menu naming each language in its own script.
    await tester.tap(find.byKey(const Key('localeMenuButton')));
    await tester.pumpAndSettle();
    expect(find.text('العربية'), findsOneWidget);
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();

    expect(find.text('Privacy policy'), findsOneWidget);
    expect(find.text('English'), findsNothing);
    expect(find.byIcon(Icons.language), findsOneWidget);
  });
}
