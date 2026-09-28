import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_usage_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_not_active_card.dart';
import 'package:url_launcher_platform_interface/url_launcher_platform_interface.dart';

import 'support/fake_url_launcher.dart';
import 'support/personas.dart';
import 'support/test_app.dart';

/// Journey 5/5 (ST-247, reworked by ST-304): AI add-on not active, then activated elsewhere.
///
/// Store-compliant half: a real unsubscribed student on the real AI tab sees the not-active notice
/// and has nothing to tap that leaves the app — the add-on is a digital good sold on the web only,
/// and the stores forbid linking to that (see docs/store_payment_routing.md). [FakeUrlLauncher]
/// sits on `url_launcher`'s platform seam so that any launch at all, from any widget, is caught.
///
/// Return half: an add-on activated outside the app reaches it through the one real out-of-app
/// signal the app has — a push-notification tap (`PushService.onNotificationTap` → `StudafyApp`'s
/// `GoRouter.push`) — so this proves that mechanism lands on the AI usage screen.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'the not-active AI tab offers no way out to a purchase, and a notification tap deep-links back',
    (tester) async {
      final urlLauncher = FakeUrlLauncher();
      UrlLauncherPlatform.instance = urlLauncher;

      final app = await IntegrationTestApp.pump(
        tester,
        mockLoginHint: Personas.unsubscribedAiStudent,
      );
      await app.signInWithMock(tester);

      await tester.tap(find.text('AI'));
      await pumpUntil(tester, () => find.byType(AiNotActiveCard).evaluate().isNotEmpty);

      final card = find.byType(AiNotActiveCard);
      expect(find.descendant(of: card, matching: find.byType(ButtonStyleButton)), findsNothing);
      expect(find.descendant(of: card, matching: find.byType(InkWell)), findsNothing);
      await tester.tap(card);
      await tester.pumpAndSettle();
      expect(urlLauncher.launches, isEmpty);

      app.pushService.simulateNotificationTap('/me/ai/usage');
      await tester.pumpAndSettle();

      expect(find.byType(AiUsageScreen), findsOneWidget);
    },
  );
}
