import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_backend.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_controller.dart';

import 'store_fakes.dart';

PurchaseDetails _purchase(PurchaseStatus status, {String productId = 'studafy_ai_monthly'}) =>
    PurchaseDetails(
      purchaseID: 'GPA.1234',
      productID: productId,
      verificationData: PurchaseVerificationData(
        localVerificationData: '{}',
        serverVerificationData: 'purchase-token',
        source: 'google_play',
      ),
      transactionDate: '1790812800000',
      status: status,
    )..pendingCompletePurchase = true;

DioException _refused(String code, int status) => DioException(
  requestOptions: RequestOptions(path: '/'),
  error: ApiException(status: status, title: 'refused', code: code),
);

void main() {
  late FakeGateway gateway;
  late FakeBackend backend;
  late FakeWaiverStore waivers;
  late ProviderContainer container;

  setUp(() {
    gateway = FakeGateway();
    backend = FakeBackend(storeSetup());
    waivers = FakeWaiverStore();
    container = ProviderContainer(
      overrides: [
        storeGatewayProvider.overrideWithValue(gateway),
        aiStoreBackendProvider.overrideWithValue(backend),
        withdrawalWaiverStoreProvider.overrideWithValue(waivers),
      ],
    );
  });

  tearDown(() {
    container.dispose();
    gateway.purchases.close();
    debugDefaultTargetPlatformOverride = null;
  });

  Future<AiStoreState> load() async {
    final subscription = container.listen(aiStoreProvider, (_, _) {});
    addTearDown(subscription.close);
    return container.read(aiStoreProvider.future);
  }

  AiStoreState current() => container.read(aiStoreProvider).requireValue;

  Future<void> deliver(PurchaseDetails purchase) async {
    gateway.purchases.add([purchase]);
    await pumpEventQueue();
  }

  group('what is offered', () {
    test("the store's own price, when the server sells it to this student on this store", () async {
      final state = await load();

      expect(state, isA<AiStoreOffering>());
      expect((state as AiStoreOffering).price, 'JOD 2.990');
    });

    test('nothing for a user the server does not sell it to', () async {
      backend.config = storeSetup(purchasable: false);
      expect(await load(), isA<AiStoreHidden>());
    });

    test('nothing when this device\'s store is not configured', () async {
      backend.config = storeSetup(google: false);
      expect(await load(), isA<AiStoreHidden>());
    });

    test('nothing when the store is unreachable or does not list the product', () async {
      gateway.available = false;
      expect(await load(), isA<AiStoreHidden>());

      container.dispose();
      gateway = FakeGateway()..listed = null;
      container = ProviderContainer(
        overrides: [
          storeGatewayProvider.overrideWithValue(gateway),
          aiStoreBackendProvider.overrideWithValue(backend),
        ],
      );
      expect(await load(), isA<AiStoreHidden>());
    });

    test('nothing on a device with no store', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      expect(await load(), isA<AiStoreHidden>());
    });
  });

  group('buying', () {
    test("stamps the purchase with the student's and the school's ids", () async {
      await load();

      container.read(aiStoreProvider.notifier).acknowledgeWaiver(true);
      await container.read(aiStoreProvider.notifier).buy();

      expect(gateway.bought.single, (accountToken: studentId, profileId: schoolId));
      expect((current() as AiStoreOffering).busy, AiStoreBusy.purchasing);
    });

    test('opens the store only once the withdrawal waiver is ticked', () async {
      await load();
      final controller = container.read(aiStoreProvider.notifier);
      expect((current() as AiStoreOffering).waiverAcknowledged, isFalse);

      await controller.buy();
      expect(gateway.bought, isEmpty);

      controller
        ..acknowledgeWaiver(true)
        ..acknowledgeWaiver(false);
      await controller.buy();
      expect(gateway.bought, isEmpty);
      expect(waivers.kept, isNull);
    });

    test('sends the waiver with the purchase it was given for, then forgets it', () async {
      await load();
      final controller = container.read(aiStoreProvider.notifier)..acknowledgeWaiver(true);
      final before = DateTime.now().toUtc();

      await controller.buy();
      expect(waivers.kept, isNotNull);
      await deliver(_purchase(PurchaseStatus.purchased));

      final sent = backend.waivers.single;
      expect(sent, isNotNull);
      expect(sent!.isBefore(before), isFalse);
      expect(sent.isUtc, isTrue);
      expect(waivers.kept, isNull);
      expect(current(), isA<AiStoreActivated>());
    });

    test('a purchase the server confirms on a later launch still carries the waiver', () async {
      // The waiver was given, and the store took the purchase, in an earlier run of the app.
      final givenAt = DateTime.utc(2026, 11, 11, 9, 59);
      waivers.kept = givenAt;
      await load();

      backend.refusal = DioException(requestOptions: RequestOptions(path: '/'));
      await deliver(_purchase(PurchaseStatus.purchased));
      // Not confirmed yet: kept for the next try.
      expect(waivers.kept, givenAt);

      backend.refusal = null;
      await deliver(_purchase(PurchaseStatus.purchased));
      expect(backend.waivers, [givenAt, givenAt]);
      expect(waivers.kept, isNull);
    });

    test('a purchase bought without the waiver (an older version) is sent without one', () async {
      await load();

      await deliver(_purchase(PurchaseStatus.purchased));

      expect(backend.waivers, [null]);
    });

    test('a delivered purchase is registered, then finished, and the add-on turns on', () async {
      await load();
      final purchase = _purchase(PurchaseStatus.purchased);

      await deliver(purchase);

      expect(backend.registered.single, (StorePlatform.google, 'purchase-token'));
      expect(gateway.completed, [purchase]);
      expect(current(), isA<AiStoreActivated>());
    });

    test('on iOS the App Store transaction is registered as an Apple purchase', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      await load();

      await deliver(_purchase(PurchaseStatus.purchased));

      expect(backend.registered.single.$1, StorePlatform.apple);
    });

    test(
      'a purchase the server could not confirm yet is left for the store to redeliver',
      () async {
        await load();
        backend.refusal = DioException(requestOptions: RequestOptions(path: '/'));

        await deliver(_purchase(PurchaseStatus.purchased));

        expect(gateway.completed, isEmpty);
        expect((current() as AiStoreOffering).messageKey, 'aiStore.errors.verifyLater');
      },
    );

    test("another account's purchase is finished, so it is not redelivered forever", () async {
      await load();
      backend.refusal = _refused('STORE_PURCHASE_ALREADY_CLAIMED', 409);

      await deliver(_purchase(PurchaseStatus.purchased));

      expect(gateway.completed, hasLength(1));
      expect((current() as AiStoreOffering).messageKey, 'aiStore.errors.otherAccount');
    });

    test('a cancelled sheet goes back to the offer; a store error says so', () async {
      await load();
      final controller = container.read(aiStoreProvider.notifier)..acknowledgeWaiver(true);
      await controller.buy();

      await deliver(_purchase(PurchaseStatus.canceled));
      expect((current() as AiStoreOffering).messageKey, isNull);
      // Nothing was bought, so the waiver given for it is gone; the box stays ticked.
      expect(waivers.kept, isNull);
      expect((current() as AiStoreOffering).waiverAcknowledged, isTrue);

      await deliver(_purchase(PurchaseStatus.error));
      expect((current() as AiStoreOffering).messageKey, 'aiStore.errors.storeFailed');
      expect(backend.registered, isEmpty);
    });

    test("another product's purchase is not this flow's", () async {
      await load();

      await deliver(_purchase(PurchaseStatus.purchased, productId: 'something_else'));

      expect(backend.registered, isEmpty);
      expect(gateway.completed, isEmpty);
    });
  });

  group('restoring', () {
    test('a restored purchase is registered like a new one', () async {
      await load();

      unawaited(container.read(aiStoreProvider.notifier).restore());
      await deliver(_purchase(PurchaseStatus.restored));

      expect(gateway.restores, 1);
      expect(backend.registered, hasLength(1));
      expect(current(), isA<AiStoreActivated>());
    });

    test('a restored purchase is never sent with a waiver', () async {
      waivers.kept = DateTime.utc(2026, 11, 11);
      await load();

      unawaited(container.read(aiStoreProvider.notifier).restore());
      await deliver(_purchase(PurchaseStatus.restored));

      expect(backend.waivers, [null]);
    });

    // testWidgets for its fake clock: the restore waits restoreSettle for a redelivery.
    testWidgets('says so when there was nothing to restore', (tester) async {
      await load();

      unawaited(container.read(aiStoreProvider.notifier).restore());
      await tester.pump();
      expect((current() as AiStoreOffering).busy, AiStoreBusy.restoring);

      await tester.pump(AiStoreController.restoreSettle);
      expect((current() as AiStoreOffering).messageKey, 'aiStore.restore.none');
    });
  });
}
