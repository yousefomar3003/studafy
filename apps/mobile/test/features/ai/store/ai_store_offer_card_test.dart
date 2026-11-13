import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_backend.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_controller.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_offer_card.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_purchase_confirmation_note.dart';

import '../../../support/wrap_with_localization.dart';
import 'store_fakes.dart';

/// The purchase screen's withdrawal waiver (EU consumer law; Terms of Service 7.7): Subscribe opens
/// the store only once the student has ticked it, and the in-app copy of the confirmation.
void main() {
  late FakeGateway gateway;
  late FakeBackend backend;
  late FakeWaiverStore waivers;

  setUp(() {
    gateway = FakeGateway();
    backend = FakeBackend(storeSetup());
    waivers = FakeWaiverStore();
  });

  tearDown(() => gateway.purchases.close());

  Future<void> pump(WidgetTester tester, Widget child, {Locale locale = const Locale('en')}) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        ProviderScope(
          overrides: [
            storeGatewayProvider.overrideWithValue(gateway),
            aiStoreBackendProvider.overrideWithValue(backend),
            withdrawalWaiverStoreProvider.overrideWithValue(waivers),
          ],
          child: Builder(
            builder: (context) => MaterialApp(
              theme: AppTheme.light,
              locale: context.locale,
              supportedLocales: context.supportedLocales,
              localizationsDelegates: context.localizationDelegates,
              home: Scaffold(body: SingleChildScrollView(child: child)),
            ),
          ),
        ),
        startLocale: locale,
      ),
    );
    await tester.pumpAndSettle();
  }

  FilledButton subscribe(WidgetTester tester) =>
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Subscribe'));

  const waiverText =
      'I want the AI study assistant to start now, and I understand I lose my 14-day right to '
      'cancel once it starts.';

  testWidgets('Subscribe is disabled until the withdrawal waiver is ticked', (tester) async {
    await pump(tester, const AiStoreOfferCard());

    expect(find.text(waiverText), findsOneWidget);
    final checkbox = tester.widget<CheckboxListTile>(find.byKey(const ValueKey('aiStore.waiver')));
    expect(checkbox.value, isFalse);
    expect(subscribe(tester).onPressed, isNull);

    await tester.tap(find.widgetWithText(FilledButton, 'Subscribe'));
    await tester.pumpAndSettle();
    expect(gateway.bought, isEmpty);

    await tester.tap(find.text(waiverText));
    await tester.pumpAndSettle();
    expect(subscribe(tester).onPressed, isNotNull);

    await tester.tap(find.widgetWithText(FilledButton, 'Subscribe'));
    await tester.pump();
    expect(gateway.bought, hasLength(1));
    expect(waivers.kept, isNotNull);
  });

  testWidgets('unticking disables Subscribe again', (tester) async {
    await pump(tester, const AiStoreOfferCard());

    await tester.tap(find.text(waiverText));
    await tester.pumpAndSettle();
    await tester.tap(find.text(waiverText));
    await tester.pumpAndSettle();

    expect(subscribe(tester).onPressed, isNull);
  });

  testWidgets('links the Terms of Service beside the waiver', (tester) async {
    await pump(tester, const AiStoreOfferCard());

    expect(find.widgetWithText(TextButton, 'Terms of Service'), findsOneWidget);
  });

  testWidgets('Restore purchases asks first, and Cancel does nothing', (tester) async {
    await pump(tester, const AiStoreOfferCard());

    await tester.ensureVisible(find.byKey(const ValueKey('aiStore.restore')));
    await tester.tap(find.byKey(const ValueKey('aiStore.restore')));
    await tester.pumpAndSettle();
    expect(find.text('Restore purchases?'), findsOneWidget);

    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(gateway.restores, 0);
    // Still there after the dialog: it never disappears from the offer.
    expect(find.byKey(const ValueKey('aiStore.restore')), findsOneWidget);
  });

  testWidgets('a confirmed restore shows progress, then the outcome', (tester) async {
    await pump(tester, const AiStoreOfferCard());

    await tester.ensureVisible(find.byKey(const ValueKey('aiStore.restore')));
    await tester.tap(find.byKey(const ValueKey('aiStore.restore')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('aiStore.restore.confirm')));
    await tester.pump();
    await tester.pump();

    expect(gateway.restores, 1);
    expect(find.byKey(const ValueKey('aiStore.restoring')), findsOneWidget);

    await tester.pump(AiStoreController.restoreSettle);
    await tester.pumpAndSettle();
    expect(find.text('No purchases to restore for this account.'), findsOneWidget);
    expect(find.byKey(const ValueKey('aiStore.restore')), findsOneWidget);
  });

  testWidgets('when it cannot be bought for a child, says why with their name', (tester) async {
    backend.config = storeSetup(
      purchasable: false,
      unavailableReason: AiStoreUnavailableReason.noFreeProduct,
    );
    await pump(tester, const AiStoreOfferCard(studentId: siblingId));

    expect(find.byKey(const ValueKey('aiStore.unavailable')), findsOneWidget);
    expect(find.textContaining('To add Sara'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Subscribe'), findsNothing);
  });

  testWidgets('a parent sees the offer titled with the child it is for', (tester) async {
    backend.config = storeSetup(forStudent: siblingId);
    await pump(tester, const AiStoreOfferCard(studentId: siblingId));

    expect(find.text('Studafy AI for Sara'), findsOneWidget);
  });

  testWidgets('the waiver is in Arabic for an Arabic reader', (tester) async {
    await pump(tester, const AiStoreOfferCard(), locale: const Locale('ar'));

    expect(find.textContaining('14 يومًا'), findsOneWidget);
    expect(find.text(waiverText), findsNothing);
  });

  group('the in-app purchase confirmation', () {
    AiStoreSetup confirmed({required bool emailed}) => AiStoreSetup(
      enabled: true,
      productId: 'studafy_ai_monthly',
      apple: true,
      google: true,
      purchasable: true,
      accountToken: studentId,
      profileId: schoolId,
      purchaseConfirmation: AiStorePurchaseConfirmation(
        acknowledgedAt: DateTime.utc(2026, 11, 11, 9, 59),
        termsVersion: '2026-11-11',
        emailed: emailed,
      ),
    );

    testWidgets('is the confirmation itself for an account without an email', (tester) async {
      backend.config = confirmed(emailed: false);
      await pump(tester, const AiStorePurchaseConfirmationNote());

      expect(find.text('Your purchase confirmation'), findsOneWidget);
      expect(find.textContaining('you lose your 14-day right to cancel'), findsOneWidget);
      expect(find.textContaining('Terms of Service of 2026-11-11 apply'), findsOneWidget);
      expect(find.textContaining('Nov 11, 2026'), findsOneWidget);
      expect(find.text('We also emailed you this confirmation.'), findsNothing);
    });

    testWidgets('says it was emailed too, where it was', (tester) async {
      backend.config = confirmed(emailed: true);
      await pump(tester, const AiStorePurchaseConfirmationNote());

      expect(find.text('We also emailed you this confirmation.'), findsOneWidget);
    });

    testWidgets('is nothing when none was recorded', (tester) async {
      await pump(tester, const AiStorePurchaseConfirmationNote());

      expect(find.byKey(const ValueKey('aiStore.confirmation')), findsNothing);
    });
  });
}
